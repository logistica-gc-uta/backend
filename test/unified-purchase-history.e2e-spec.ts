import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  execPsqlCommand,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(300_000);

/**
 * Issue #46: historial unificado de compras propias (Shop + ADMIN) sobre PostgreSQL real (contenedor propio).
 * Las compras Shop y ADMIN se crean por la API pública; los pedidos conservados sin comprobante, los de otro
 * titular y el de un invitado se insertan directamente porque la API ya no los genera.
 */
describe('Historial unificado de compras propias (#46) en PostgreSQL real', () => {
  let app: INestApplication;
  let db: any;
  let jwtSign: (payload: Record<string, unknown>) => string;
  let adminToken: string;
  let tokenA: string;
  let tokenB: string;
  let productId: string;
  const ids = { admin: randomUUID(), a: randomUUID(), b: randomUUID() };
  const dbName = `history_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const card = { number: '9000 0000 0000 0001', holderName: 'PRUEBA APROBADA', expiresMonth: 12, expiresYear: 2030, cvv: '111' };
  const delivery = (phone = '0991234567') => {
    const date = new Date(Date.now() + 3 * 86_400_000);
    date.setUTCHours(15, 0, 0, 0); // 10:00 hora de Guayaquil
    return {
      recipient: { name: 'Ana Regalo', phone },
      deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
      deliveryLocation: { lat: -1.25, lng: -78.63 },
      scheduledDeliveryDate: date.toISOString(),
    };
  };
  const count = async (model: 'PurchaseReceipt' | 'Order') => (await db.client.orm.public[model].all()).length;

  /** Compra Shop por la API pública (cotizar y pagar con la tarjeta ficticia aprobada). */
  const shopPurchase = async (token: string) => {
    const items = [{ productId, quantity: 1 }];
    const dlv = delivery();
    const quote = await http().post('/api/v1/shop/checkout/quote').set(auth(token)).send({ items, delivery: dlv }).expect(200);
    const res = await http()
      .post('/api/v1/shop/checkout')
      .set(auth(token))
      .set('Idempotency-Key', randomUUID())
      .send({ items, delivery: dlv, quoteToken: quote.body.quoteToken, paymentCard: card })
      .expect(201);
    return res.body.order.id as string;
  };
  /** Compra ADMIN para un cliente registrado, con pago externo declarado y comprobante. */
  const adminPurchase = async (clientId: string) => {
    const dlv = delivery();
    const res = await http()
      .post('/api/v1/orders/admin')
      .set(auth(adminToken))
      .set('Idempotency-Key', randomUUID())
      .send({
        buyer: { type: 'REGISTERED_CLIENT', clientId, contactPhone: '0991234567' },
        deliveryAddress: dlv.deliveryAddress,
        scheduledDeliveryDate: dlv.scheduledDeliveryDate,
        deliveryLat: -1.25,
        deliveryLng: -78.63,
        items: [{ productId, quantity: 1 }],
        payment: { method: 'CASH' },
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  /** Pedido insertado directamente (la API ya no crea pedidos sin comprobante). */
  const insertOrder = (opts: { id: string; userId: string | null; createdById: string | null; recipientType: 'REGISTERED_CLIENT' | 'GUEST' | null; createdAt: string; status?: string; phone?: string }) => {
    const recipient = opts.recipientType ? `'Ana Conservada', '${opts.phone ?? '0990000000'}'` : 'NULL, NULL';
    execPsqlCommand(dbName, `
      INSERT INTO public."order" (id,"userId","createdById","recipientType","recipientName","recipientPhone",status,"deliveryAddress","scheduledDeliveryDate","createdAt")
      VALUES ('${opts.id}', ${opts.userId ? `'${opts.userId}'` : 'NULL'}, ${opts.createdById ? `'${opts.createdById}'` : 'NULL'}, ${opts.recipientType ? `'${opts.recipientType}'` : 'NULL'}, ${recipient}, '${opts.status ?? 'DELIVERED'}', 'Dirección conservada', '2026-09-05T15:00:00Z', '${opts.createdAt}')
    `);
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';
    startOwnedContainer();
    const dbUrl = createOwnedDatabase(dbName);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');
    const { bootstrapSimulatedCards } = await import('../src/modules/shop/checkout/simulated-card.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = app.get(PrismaService);
    const jwt = app.get(JwtService);
    jwtSign = (payload) => jwt.sign(payload);
    await bootstrapSimulatedCards(db);

    for (const [key, role, name] of [['admin', 'ADMIN', 'Admin'], ['a', 'CLIENT', 'Cliente A'], ['b', 'CLIENT', 'Cliente B']] as const) {
      await db.user.create({ id: ids[key], name, email: `${key}-${ids[key]}@example.test`, password: 'fixture-not-real', role });
    }
    adminToken = jwtSign({ sub: ids.admin, email: 'admin@example.test', role: 'ADMIN' });
    tokenA = jwtSign({ sub: ids.a, email: 'a@example.test', role: 'CLIENT' });
    tokenB = jwtSign({ sub: ids.b, email: 'b@example.test', role: 'CLIENT' });

    const categoryId = randomUUID();
    await db.client.orm.public.Category.create({ id: categoryId, name: `Historial ${categoryId.slice(0, 6)}`, slug: `historial-${categoryId.slice(0, 6)}`, isActive: true });
    productId = randomUUID();
    await db.client.orm.public.Product.create({
      id: productId, name: 'Regalo de historial', description: 'Regalo para el historial unificado', sku: `HIST-${productId.slice(0, 6)}`,
      price: 10, priceCents: BigInt(1000), stock: 100, isPublished: true, isFeatured: false, categoryId,
    });
    const now = Temporal.Now.instant();
    await db.client.orm.public.StoreCoverage.create({
      id: randomUUID(), singletonKey: 'GLOBAL', lat: -1.24908, lng: -78.61675,
      coverage: { type: 'Polygon', coordinates: [[[-78.7, -1.3], [-78.5, -1.3], [-78.5, -1.1], [-78.7, -1.1], [-78.7, -1.3]]] },
      updatedById: null, createdAt: now, updatedAt: now,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
  });

  describe('lista, detalle y comprobante', () => {
    let shopOrderId: string;
    let adminOrderId: string;
    const legacyId = randomUUID();
    const adminWithoutReceiptId = randomUUID();
    const guestId = randomUUID();
    const foreignId = randomUUID();

    beforeAll(async () => {
      shopOrderId = await shopPurchase(tokenA);
      adminOrderId = await adminPurchase(ids.a);
      insertOrder({ id: legacyId, userId: ids.a, createdById: null, recipientType: null, createdAt: '2026-09-01T12:00:00Z' });
      insertOrder({ id: adminWithoutReceiptId, userId: ids.a, createdById: ids.admin, recipientType: 'REGISTERED_CLIENT', createdAt: '2026-09-02T12:00:00Z' });
      // Invitado cuyo teléfono coincide con el del cliente A: no se vincula por teléfono.
      insertOrder({ id: guestId, userId: null, createdById: ids.admin, recipientType: 'GUEST', createdAt: '2026-09-03T12:00:00Z', phone: '0991234567' });
      // Pedido de otro cliente.
      insertOrder({ id: foreignId, userId: ids.b, createdById: null, recipientType: null, createdAt: '2026-09-04T12:00:00Z' });
    });

    it('el cliente A ve en UNA lista su compra Shop, su compra ADMIN y sus pedidos conservados, cada uno con su origen', async () => {
      const res = await http().get('/api/v1/shop/orders?pageSize=50').set(auth(tokenA)).expect(200);

      const bySource = Object.fromEntries(res.body.items.map((i: any) => [i.id, [i.source, i.receiptAvailable]]));
      expect(bySource).toEqual({
        [shopOrderId]: ['SHOP', true],
        [adminOrderId]: ['ADMIN', true],
        [legacyId]: ['SHOP', false],
        [adminWithoutReceiptId]: ['ADMIN', false],
      });
      expect(res.body.total).toBe(4);
    });

    it('la lista queda ordenada por fecha de creación descendente, con desempate estable por id', async () => {
      const res = await http().get('/api/v1/shop/orders?pageSize=50').set(auth(tokenA)).expect(200);
      const dates = res.body.items.map((i: any) => Date.parse(i.createdAt));
      expect(dates).toEqual([...dates].sort((x, y) => y - x));
      // La paginación recorre todo exactamente una vez, en el mismo orden.
      const pages: string[] = [];
      for (const page of [1, 2, 3, 4]) {
        const part = await http().get(`/api/v1/shop/orders?page=${page}&pageSize=1`).set(auth(tokenA)).expect(200);
        pages.push(...part.body.items.map((i: any) => i.id));
      }
      expect(pages).toEqual(res.body.items.map((i: any) => i.id));
      expect(new Set(pages).size).toBe(4);
    });

    it('la compra ADMIN con comprobante muestra sus importes congelados y la Shop los suyos', async () => {
      const res = await http().get('/api/v1/shop/orders?pageSize=50').set(auth(tokenA)).expect(200);
      for (const id of [shopOrderId, adminOrderId]) {
        const item = res.body.items.find((i: any) => i.id === id);
        expect(item).toMatchObject({ currency: 'USD', paymentStatus: 'APPROVED', itemsCount: 1, subtotalCents: 1000, taxAmountCents: 150, totalCents: 1150 });
        expect(item.number).toEqual(expect.any(String));
        expect(item.receiptId).toEqual(expect.any(String));
      }
    });

    it('un pedido conservado sin comprobante se lista sin importes, número, pago ni ítems reconstruidos', async () => {
      const res = await http().get('/api/v1/shop/orders?pageSize=50').set(auth(tokenA)).expect(200);
      const item = res.body.items.find((i: any) => i.id === legacyId);
      expect(item).toMatchObject({
        number: null, receiptAvailable: false, receiptId: null, paymentStatus: null, totalCents: null, subtotalCents: null,
        taxAmountCents: null, taxRateBps: null, shippingAmountCents: null, taxEnabled: null, itemsCount: null, primaryImageUrl: null, primaryProductId: null,
        status: 'DELIVERED', scheduledDeliveryDate: '2026-09-05T15:00:00.000Z',
      });
    });

    it('el detalle de un pedido sin comprobante existe y conserva su seguimiento; el de uno con comprobante, su snapshot', async () => {
      const legacy = await http().get(`/api/v1/shop/orders/${legacyId}`).set(auth(tokenA)).expect(200);
      expect(legacy.body).toMatchObject({
        id: legacyId, source: 'SHOP', receiptAvailable: false, number: null, totalCents: null, paymentStatus: null, receiptId: null, items: [],
        buyer: { id: ids.a }, delivery: { address: 'Dirección conservada', location: null }, status: 'DELIVERED',
      });
      expect(legacy.body.timeline.map((t: any) => t.code)).toEqual(['PENDING']);

      const adminDetail = await http().get(`/api/v1/shop/orders/${adminWithoutReceiptId}`).set(auth(tokenA)).expect(200);
      expect(adminDetail.body).toMatchObject({ source: 'ADMIN', receiptAvailable: false, recipient: { name: 'Ana Conservada' } });

      const shop = await http().get(`/api/v1/shop/orders/${shopOrderId}`).set(auth(tokenA)).expect(200);
      expect(shop.body).toMatchObject({ source: 'SHOP', receiptAvailable: true, totalCents: 1150, paymentStatus: 'APPROVED' });
      expect(shop.body.items).toHaveLength(1);
      const admin = await http().get(`/api/v1/shop/orders/${adminOrderId}`).set(auth(tokenA)).expect(200);
      expect(admin.body).toMatchObject({ source: 'ADMIN', receiptAvailable: true, totalCents: 1150 });
    });

    it('el comprobante existe para Shop y ADMIN; para un pedido sin comprobante informa la indisponibilidad y no genera uno', async () => {
      await http().get(`/api/v1/shop/orders/${shopOrderId}/receipt`).set(auth(tokenA)).expect(200);
      const adminReceipt = await http().get(`/api/v1/shop/orders/${adminOrderId}/receipt`).set(auth(tokenA)).expect(200);
      expect(adminReceipt.body.payment).toMatchObject({ kind: 'ADMIN_DECLARED_EXTERNAL', status: 'DECLARED' });

      const receiptsBefore = await count('PurchaseReceipt');
      const ordersBefore = await count('Order');
      for (const id of [legacyId, adminWithoutReceiptId]) {
        const res = await http().get(`/api/v1/shop/orders/${id}/receipt`).set(auth(tokenA)).expect(404);
        expect(res.body.error.code).toBe('RECEIPT_UNAVAILABLE');
      }
      expect(await count('PurchaseReceipt')).toBe(receiptsBefore); // no se genera un comprobante nuevo
      expect(await count('Order')).toBe(ordersBefore);
    });

    it('el cliente B no ve ninguno de los pedidos de A y solo ve el suyo; cambiar el id no da acceso', async () => {
      const list = await http().get('/api/v1/shop/orders?pageSize=50').set(auth(tokenB)).expect(200);
      expect(list.body.items.map((i: any) => i.id)).toEqual([foreignId]);

      for (const id of [shopOrderId, adminOrderId, legacyId, adminWithoutReceiptId]) {
        expect((await http().get(`/api/v1/shop/orders/${id}`).set(auth(tokenB)).expect(404)).body.error.code).toBe('ORDER_NOT_FOUND');
        expect((await http().get(`/api/v1/shop/orders/${id}/receipt`).set(auth(tokenB)).expect(404)).body.error.code).toBe('ORDER_NOT_FOUND');
      }
    });

    it('un invitado no se vincula por teléfono: el pedido de invitado con el mismo teléfono de A no aparece ni se puede abrir', async () => {
      const list = await http().get('/api/v1/shop/orders?pageSize=50').set(auth(tokenA)).expect(200);
      expect(list.body.items.map((i: any) => i.id)).not.toContain(guestId);
      expect((await http().get(`/api/v1/shop/orders/${guestId}`).set(auth(tokenA)).expect(404)).body.error.code).toBe('ORDER_NOT_FOUND');
      expect((await http().get(`/api/v1/shop/orders/${guestId}/receipt`).set(auth(tokenA)).expect(404)).body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('el filtro por estado actúa sobre ambos orígenes y sobre los pedidos sin comprobante', async () => {
      const delivered = await http().get('/api/v1/shop/orders?status=DELIVERED&pageSize=50').set(auth(tokenA)).expect(200);
      expect(delivered.body.items.map((i: any) => i.id).sort()).toEqual([legacyId, adminWithoutReceiptId].sort());
      const pending = await http().get('/api/v1/shop/orders?status=PENDING&pageSize=50').set(auth(tokenA)).expect(200);
      expect(pending.body.items.map((i: any) => i.id).sort()).toEqual([shopOrderId, adminOrderId].sort());
    });

    it('la base de datos impide un comprobante cuyo titular no es el dueño del pedido (el filtro del servidor es una segunda barrera)', () => {
      const mismatchId = randomUUID();
      insertOrder({ id: mismatchId, userId: ids.a, createdById: null, recipientType: null, createdAt: '2026-09-06T12:00:00Z' });
      expect(() =>
        execPsqlCommand(dbName, `
          INSERT INTO public."purchaseReceipt" (id,"orderId",number,"commercialOrderNumber","buyerId","subtotalCents","taxEnabled","taxRateBps","taxAmountCents","totalCents",snapshot)
          VALUES ('${randomUUID()}','${mismatchId}','RC-${mismatchId}','RG-${mismatchId}','${ids.b}',1000,true,1500,150,1150,'{}'::jsonb)
        `),
      ).toThrow(/Receipt buyerId must match order\.userId/);
    });

    it('sin sesión o con otro rol no se consulta el historial', async () => {
      await http().get('/api/v1/shop/orders').expect(401);
      await http().get(`/api/v1/shop/orders/${legacyId}`).expect(401);
      await http().get(`/api/v1/shop/orders/${legacyId}/receipt`).expect(401);
      await http().get('/api/v1/shop/orders').set(auth(adminToken)).expect(403);
    });
  });
});
