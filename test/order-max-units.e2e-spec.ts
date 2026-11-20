import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { cleanupOwnedResources, createOwnedDatabase, runPrismaMigrate, startOwnedContainer } from './geolocation-migration.fixtures.js';
import { seedAmbatoStoreCoverage } from './ambato-store-coverage.fixture.js';
import { bootstrapSimulatedCards } from '../src/modules/shop/checkout/simulated-card.js';

jest.setTimeout(240_000);

/**
 * #83: máximo configurable de unidades por pedido (suma de todas las líneas), sobre PostgreSQL real y HTTP real.
 * Cubre la tienda (cotización y confirmación), el panel (POST /orders/admin) y POST /orders, los permisos, la configuración
 * inválida, el efecto de un cambio de configuración sobre cotizaciones previas y que un rechazo no deje efectos parciales.
 */
describe('Máximo de unidades por pedido (#83, owned PostgreSQL fixture)', () => {
  let app: INestApplication;
  let db: any;
  let adminToken: string;
  let clientToken: string;
  let driverToken: string;
  let clientId: string;
  let zoneId: string;
  let productA: string;
  let productB: string;
  let version = 1;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const STOCK = 100;

  const delivery = () => ({
    recipient: { name: 'Ana Regalo', phone: '0991234567' },
    zoneId,
    deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
    deliveryLocation: { lat: -1.2425, lng: -78.6188 },
    scheduledDeliveryDate: '2030-06-14T15:00:00.000Z',
  });
  const lines = (a: number, b = 0) => [
    { productId: productA, quantity: a },
    ...(b > 0 ? [{ productId: productB, quantity: b }] : []),
  ];

  const settingsPatch = (body: Record<string, unknown>, token = adminToken) =>
    http().patch('/api/v1/admin/shop-settings').set(bearer(token)).send({ expectedVersion: version, ...body });
  const setMax = async (value: number | null) => {
    const res = await settingsPatch({ limits: { maxUnitsPerOrder: value } }).expect(200);
    version = res.body.version;
    return res;
  };
  const quote = (items: unknown) => http().post('/api/v1/shop/checkout/quote').set(bearer(clientToken)).send({ items, delivery: delivery() });
  const checkout = (items: unknown, quoteToken: string) =>
    http().post('/api/v1/shop/checkout').set(bearer(clientToken)).set('Idempotency-Key', randomUUID()).send({
      items,
      delivery: delivery(),
      quoteToken,
      paymentCard: { number: '9000 0000 0000 0001', holderName: 'PRUEBA APROBADA', expiresMonth: 12, expiresYear: 2030, cvv: '111' },
    });
  const adminPurchase = (items: unknown) =>
    http().post('/api/v1/orders/admin').set(bearer(adminToken)).set('Idempotency-Key', randomUUID()).send({
      buyer: { type: 'GUEST', name: 'Invitado', contactPhone: '+593 99 123 4567' },
      payment: { method: 'CASH' },
      zoneId,
      deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
      deliveryLat: -1.2425,
      deliveryLng: -78.6188,
      scheduledDeliveryDate: '2030-06-14T10:00:00-05:00',
      items,
    });
  const legacyOrder = (items: unknown) =>
    http().post('/api/v1/orders').set(bearer(clientToken)).send({
      zoneId,
      deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
      deliveryLat: -1.2425,
      deliveryLng: -78.6188,
      scheduledDeliveryDate: '2030-06-14T10:00:00-05:00',
      items,
    });

  const counts = async () => ({
    orders: (await db.client.orm.public.Order.all()).length,
    payments: (await db.client.orm.public.PaymentAttempt.all()).length,
    stockA: (await db.client.orm.public.Product.where({ id: productA }).first()).stock,
    stockB: (await db.client.orm.public.Product.where({ id: productB }).first()).stock,
  });
  const expectLimitError = (res: request.Response, requestedUnits: number, maximumAllowed: number) => {
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'ORDER_UNITS_LIMIT_EXCEEDED', details: { requestedUnits, maximumAllowed } });
  };

  beforeAll(async () => {
    const receipt = startOwnedContainer();
    console.log(`[TEST-CONTAINER-RECEIPT] containerId=${receipt.containerId}`);
    const dbUrl = createOwnedDatabase(`order_max_units_${suffix}`);
    runPrismaMigrate(dbUrl);
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = app.get(PrismaService);
    const jwt = app.get(JwtService);
    await bootstrapSimulatedCards(db);

    for (const role of ['ADMIN', 'CLIENT', 'DRIVER'] as const) {
      const id = randomUUID();
      const email = `${role.toLowerCase()}-${id}@example.test`;
      await db.user.create({ id, name: `Fixture ${role}`, email, password: 'fixture-password-not-real', role });
      const token = jwt.sign({ sub: id, email, role }, { expiresIn: '1h' });
      if (role === 'ADMIN') adminToken = token;
      if (role === 'CLIENT') {
        clientToken = token;
        clientId = id;
      }
      if (role === 'DRIVER') driverToken = token;
    }

    zoneId = randomUUID();
    await db.zone.create({ id: zoneId, name: 'Zona Centro Ambato', code: `AMB-${suffix.slice(0, 4)}`, depotLat: -1.242, depotLng: -78.618 });
    await seedAmbatoStoreCoverage(db);
    const categoryId = randomUUID();
    await db.category.create({ id: categoryId, name: 'Navidad', slug: `navidad-${suffix}`, description: 'Regalos', isActive: true, sortOrder: 1 });
    const product = async (name: string, sku: string) => {
      const id = randomUUID();
      await db.product.create({
        id, name, description: `${name} de prueba`, price: 10, priceCents: 1000n, sku: `${sku}-${suffix.slice(0, 6)}`,
        categoryId, isPublished: true, isFeatured: false, stock: STOCK,
      });
      return id;
    };
    productA = await product('Producto A', 'MAXU-A');
    productB = await product('Producto B', 'MAXU-B');
  }, 240_000);

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.JWT_SECRET;
      delete process.env.SIMULATED_PAYMENTS_ENABLED;
      cleanupOwnedResources();
    }
  });

  describe('contrato de la configuración', () => {
    it('sin configurar no hay límite total y el contrato web lo expone como null (público y admin)', async () => {
      const publicRes = await http().get('/api/v1/shop/settings').expect(200);
      expect(publicRes.body.limits).toEqual({ maxUnitsPerSkuPerOrder: 10, maxUnitsPerOrder: null });
      const adminRes = await http().get('/api/v1/admin/shop-settings').set(bearer(adminToken)).expect(200);
      expect(adminRes.body.limits).toEqual({ maxUnitsPerSkuPerOrder: 10, maxUnitsPerOrder: null });
      version = adminRes.body.version;
    });

    it('sin límite, un pedido de varias líneas se acepta (comportamiento anterior conservado)', async () => {
      const res = await quote(lines(10, 10));
      expect(res.status).toBe(200);
    });

    it('solo ADMIN cambia el máximo; sin sesión, CLIENT y DRIVER no pueden y nada cambia', async () => {
      await http().patch('/api/v1/admin/shop-settings').send({ expectedVersion: version, limits: { maxUnitsPerOrder: 5 } }).expect(401);
      await settingsPatch({ limits: { maxUnitsPerOrder: 5 } }, clientToken).expect(403);
      await settingsPatch({ limits: { maxUnitsPerOrder: 5 } }, driverToken).expect(403);
      const adminRes = await http().get('/api/v1/admin/shop-settings').set(bearer(adminToken)).expect(200);
      expect(adminRes.body).toMatchObject({ version, limits: { maxUnitsPerOrder: null } });
    });

    it.each([
      ['cero', 0],
      ['negativo', -3],
      ['sobre el tope de 1000', 1001],
      ['decimal', 2.5],
      ['texto', '5'],
    ])('un valor inválido (%s) se rechaza sin modificar la configuración', async (_name, value) => {
      const res = await settingsPatch({ limits: { maxUnitsPerOrder: value } });
      expect(res.status).toBe(400);
      const adminRes = await http().get('/api/v1/admin/shop-settings').set(bearer(adminToken)).expect(200);
      expect(adminRes.body).toMatchObject({ version, limits: { maxUnitsPerOrder: null } });
    });

    it('un limits vacío se rechaza', async () => {
      await settingsPatch({ limits: {} }).expect(400);
    });

    it('ADMIN fija el máximo: sube la versión, queda en la auditoría y no toca el máximo por SKU', async () => {
      const res = await setMax(5);
      expect(res.body.limits).toEqual({ maxUnitsPerSkuPerOrder: 10, maxUnitsPerOrder: 5 });
      const publicRes = await http().get('/api/v1/shop/settings').expect(200);
      expect(publicRes.body.limits).toEqual({ maxUnitsPerSkuPerOrder: 10, maxUnitsPerOrder: 5 });
      const audits = await db.client.orm.public.ShopSettingsAudit.where({ newVersion: version }).all();
      expect(audits).toHaveLength(1);
      expect(audits[0].changedFields).toEqual({ limits: { maxUnitsPerOrder: 5 } });
    });
  });

  describe('tienda: cotización y confirmación (máximo 5)', () => {
    it('acepta por debajo y en el límite, sumando productos distintos', async () => {
      expect((await quote(lines(3))).status).toBe(200);
      expect((await quote(lines(3, 2))).status).toBe(200);
    });

    it('rechaza N+1 con código estable y el máximo vigente; el total suma líneas, no las cuenta', async () => {
      expectLimitError(await quote(lines(3, 3)), 6, 5);
      expectLimitError(await quote(lines(1, 1).concat([{ productId: productA, quantity: 4 }])), 6, 5);
    });

    it('con dos productos que cumplen el máximo por SKU se rechaza si la suma excede el total, y el máximo por SKU sigue vigente', async () => {
      expectLimitError(await quote(lines(9, 9)), 18, 5);
      // Una sola línea sobre el máximo por SKU conserva su propio código.
      const perSku = await quote(lines(11));
      expect(perSku.status).toBe(422);
      expect(perSku.body.error.code).toBe('QUANTITY_LIMIT_EXCEEDED');
    });

    it('confirma un pedido exactamente en el límite y lo crea con su stock y cobro', async () => {
      const before = await counts();
      const items = lines(3, 2);
      const q = await quote(items).expect(200);
      const res = await checkout(items, q.body.quoteToken);
      if (res.status !== 201) throw new Error(JSON.stringify(res.body));
      const after = await counts();
      expect(after).toEqual({ orders: before.orders + 1, payments: before.payments + 1, stockA: before.stockA - 3, stockB: before.stockB - 2 });
    });

    it('una cotización previa no esquiva un máximo más bajo: SHOP_SETTINGS_CHANGED y nada se crea', async () => {
      const items = lines(3, 2);
      const q = await quote(items).expect(200);
      const before = await counts();
      await setMax(4);
      const res = await checkout(items, q.body.quoteToken);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SHOP_SETTINGS_CHANGED');
      expect(await counts()).toEqual(before);
    });

    it('no se puede inflar el pedido al confirmar con la cotización de uno menor: se rechaza sin tocar stock ni cobros', async () => {
      const q = await quote(lines(2, 2)).expect(200);
      const before = await counts();
      const res = await checkout(lines(3, 2), q.body.quoteToken);
      expect([400, 409, 422]).toContain(res.status);
      expect(await counts()).toEqual(before);
    });
  });

  describe('panel (POST /orders/admin) y POST /orders (máximo 4)', () => {
    it('el panel acepta en el límite y crea el pedido', async () => {
      const before = await counts();
      const res = await adminPurchase(lines(2, 2));
      expect(res.status).toBe(201);
      expect(await counts()).toMatchObject({ orders: before.orders + 1, stockA: before.stockA - 2, stockB: before.stockB - 2 });
    });

    it('el panel rechaza N+1 con el mismo código y no crea pedido ni altera stock', async () => {
      const before = await counts();
      expectLimitError(await adminPurchase(lines(3, 2)), 5, 4);
      expect(await counts()).toEqual(before);
    });

    it('el panel también suma líneas repetidas del mismo producto', async () => {
      const before = await counts();
      expectLimitError(await adminPurchase([{ productId: productA, quantity: 3 }, { productId: productA, quantity: 2 }]), 5, 4);
      expect(await counts()).toEqual(before);
    });

    it('POST /orders: acepta en el límite y rechaza N+1 sin efectos', async () => {
      const ok = await legacyOrder(lines(2, 2));
      expect(ok.status).toBe(201);
      const before = await counts();
      expectLimitError(await legacyOrder(lines(2, 3)), 5, 4);
      expect(await counts()).toEqual(before);
    });
  });

  describe('cambios de configuración y pedidos existentes', () => {
    it('bajar el máximo no altera los pedidos ya registrados', async () => {
      const before = await counts();
      const existing = await db.client.orm.public.OrderItem.all();
      await setMax(1);
      expect(await counts()).toEqual(before);
      expect(await db.client.orm.public.OrderItem.all()).toHaveLength(existing.length);
      expectLimitError(await adminPurchase(lines(1, 1)), 2, 1);
    });

    it('subir el máximo habilita de nuevo el pedido rechazado, y null quita el límite', async () => {
      await setMax(1000);
      expect((await adminPurchase(lines(10, 10))).status).toBe(201);
      await setMax(null);
      const adminRes = await http().get('/api/v1/admin/shop-settings').set(bearer(adminToken)).expect(200);
      expect(adminRes.body.limits.maxUnitsPerOrder).toBeNull();
      expect((await adminPurchase(lines(10, 10))).status).toBe(201);
    });

    it('un cambio concurrente de configuración y una confirmación nunca dejan un pedido sobre el máximo vigente', async () => {
      await setMax(5);
      const items = lines(3, 2);
      const q = await quote(items).expect(200);
      const before = await counts();
      const nextVersion = version;
      const [patch, order] = await Promise.all([
        http().patch('/api/v1/admin/shop-settings').set(bearer(adminToken)).send({ expectedVersion: nextVersion, limits: { maxUnitsPerOrder: 4 } }),
        checkout(items, q.body.quoteToken),
      ]);
      expect(patch.status).toBe(200);
      version = patch.body.version;
      const after = await counts();
      if (order.status === 201) {
        // Ganó la confirmación: el pedido de 5 se hizo bajo el máximo 5 vigente entonces.
        expect(after.orders).toBe(before.orders + 1);
      } else {
        expect(order.status).toBe(409);
        expect(after).toEqual(before);
      }
    });
  });
});
