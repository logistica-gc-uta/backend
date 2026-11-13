import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';
import { seedAmbatoStoreCoverage } from './ambato-store-coverage.fixture.js';

jest.setTimeout(240_000);

/**
 * Issue #35-C: concurrencia e idempotencia sobre PostgreSQL REAL con compradores simultáneos
 * (más que los 2 de las suites previas) y cambios de ADMIN mientras las compras esperan un bloqueo.
 */
describe('Shop v1.2 concurrency matrix on real PostgreSQL (owned fixture)', () => {
  let app: INestApplication;
  let db: any;
  let zoneId: string;
  let categoryId: string;
  let jwtSign: (payload: Record<string, unknown>) => string;
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const APPROVED = { number: '9000 0000 0000 0001', holderName: 'PRUEBA APROBADA', expiresMonth: 12, expiresYear: 2030, cvv: '111' };
  const LIMITED = { number: '9000 0000 0000 0002', holderName: 'PRUEBA LIMITADA', expiresMonth: 12, expiresYear: 2030, cvv: '222' };

  const deliveryDate = (): string => {
    const date = new Date(Date.now() + 3 * 86_400_000);
    date.setUTCHours(15, 0, 0, 0); // 10:00 en Guayaquil
    return date.toISOString();
  };
  const delivery = () => ({
    recipient: { name: 'Ana Regalo', phone: '0991234567' },
    zoneId,
    deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
    deliveryLocation: { lat: -1.2425, lng: -78.6188 },
    scheduledDeliveryDate: deliveryDate(),
  });

  const createProduct = async (label: string, priceCents: number, stock: number): Promise<string> => {
    const id = randomUUID();
    await db.client.orm.public.Product.create({
      id, name: `Regalo ${label} ${dbSuffix}`, description: `Regalo de prueba de concurrencia ${label}`,
      sku: `CC-${dbSuffix}-${label}`, price: priceCents / 100, priceCents: BigInt(priceCents), stock,
      isPublished: true, isFeatured: false, categoryId,
    });
    return id;
  };
  const createBuyers = async (count: number) => {
    const buyers: { id: string; token: string }[] = [];
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      const email = `buyer-${index}-${id}@example.test`;
      await db.user.create({ id, name: `Comprador ${index}`, email, password: 'fixture-not-real', role: 'CLIENT' });
      buyers.push({ id, token: jwtSign({ sub: id, email, role: 'CLIENT' }) });
    }
    return buyers;
  };
  const quoteFor = async (token: string, productId: string, quantity = 1) => {
    const items = [{ productId, quantity }];
    const dlv = delivery();
    const res = await http().post('/api/v1/shop/checkout/quote').set(auth(token)).send({ items, delivery: dlv }).expect(200);
    return { items, delivery: dlv, quoteToken: res.body.quoteToken as string };
  };
  const buy = (token: string, prepared: Awaited<ReturnType<typeof quoteFor>>, paymentCard: object, key = randomUUID()) =>
    http().post('/api/v1/shop/checkout').set(auth(token)).set('Idempotency-Key', key).send({ ...prepared, paymentCard });
  const card = async (fixtureId: string) => (await db.client.orm.public.SimulatedCard.where({ fixtureId }).first()).balanceCents as bigint;
  const stockOf = async (id: string) => (await db.client.orm.public.Product.where({ id }).first()).stock as number;
  const countRows = async (model: 'Order' | 'PaymentAttempt' | 'PurchaseReceipt') => (await db.client.orm.public[model].all()).length;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';
    startOwnedContainer();
    const dbUrl = createOwnedDatabase(`shop_conc_${dbSuffix}`);
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
    await app.listen(0, '127.0.0.1');
    db = app.get(PrismaService);
    const jwt = app.get(JwtService);
    jwtSign = (payload) => jwt.sign(payload);
    await bootstrapSimulatedCards(db);

    categoryId = randomUUID();
    await db.client.orm.public.Category.create({ id: categoryId, name: `Concurrencia ${dbSuffix}`, slug: `concurrencia-${dbSuffix}`, isActive: true });
    zoneId = randomUUID();
    await db.client.orm.public.Zone.create({ id: zoneId, name: `Centro ${dbSuffix}`, code: `CC-${dbSuffix.slice(0, 4).toUpperCase()}`, depotLat: -1.2425, depotLng: -78.6188 });
    await seedAmbatoStoreCoverage(db);
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
  });

  it('12 compradores simultáneos por 5 unidades: exactamente 5 aprueban, 7 reciben STOCK_UNAVAILABLE y el stock queda en 0', async () => {
    const productId = await createProduct('STOCK5', 1000, 5); // total 1150 con IVA 15%
    const buyers = await createBuyers(12);
    const prepared = await Promise.all(buyers.map((buyer) => quoteFor(buyer.token, productId)));
    const balanceBefore = await card('DEMO_APPROVED');

    const results = await Promise.all(buyers.map((buyer, index) => buy(buyer.token, prepared[index]!, APPROVED)));

    const approved = results.filter((res) => res.status === 201);
    const rejected = results.filter((res) => res.status === 409);
    const unexpected = results
      .filter((res) => res.status !== 201 && res.status !== 409)
      .map((res) => ({ status: res.status, body: res.body }));
    expect(unexpected).toEqual([]);
    expect(approved).toHaveLength(5);
    expect(rejected).toHaveLength(7);
    for (const res of rejected) expect(res.body.error.code).toBe('STOCK_UNAVAILABLE');
    expect(await stockOf(productId)).toBe(0);
    expect(await card('DEMO_APPROVED')).toBe(balanceBefore - 5n * 1150n);
    expect(await countRows('Order')).toBe(5);
    expect(await countRows('PaymentAttempt')).toBe(5);
    expect(await countRows('PurchaseReceipt')).toBe(5);
  });

  it('10 compras simultáneas contra la tarjeta LIMITADA (2000): solo una cabe, el saldo no queda negativo', async () => {
    const productId = await createProduct('SALDO', 1000, 50); // total 1150: dos no caben en 2000
    const buyers = await createBuyers(10);
    const prepared = await Promise.all(buyers.map((buyer) => quoteFor(buyer.token, productId)));
    const ordersBefore = await countRows('Order');

    const results = await Promise.all(buyers.map((buyer, index) => buy(buyer.token, prepared[index]!, LIMITED)));

    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    const declined = results.filter((res) => res.status === 422);
    expect(declined).toHaveLength(9);
    for (const res of declined) expect(res.body.error.code).toBe('INSUFFICIENT_DEMO_FUNDS');
    expect(await card('DEMO_LIMITED')).toBe(850n);
    expect(await stockOf(productId)).toBe(49);
    expect(await countRows('Order')).toBe(ordersBefore + 1);
  });

  it('8 reintentos simultáneos con la misma Idempotency-Key: una sola compra y respuestas idénticas', async () => {
    const productId = await createProduct('IDEM', 1000, 20);
    const [buyer] = await createBuyers(1);
    const prepared = await quoteFor(buyer!.token, productId, 2);
    const key = randomUUID();
    const balanceBefore = await card('DEMO_APPROVED');
    const ordersBefore = await countRows('Order');

    const results = await Promise.all(Array.from({ length: 8 }, () => buy(buyer!.token, prepared, APPROVED, key)));

    for (const res of results) expect(res.status).toBe(201);
    // El reintento se sirve desde el JSON guardado: mismo contenido aunque el orden de claves difiera.
    for (const res of results) expect(res.body).toEqual(results[0]!.body);
    expect(await countRows('Order')).toBe(ordersBefore + 1);
    expect(await stockOf(productId)).toBe(18);
    expect(await card('DEMO_APPROVED')).toBe(balanceBefore - 2300n);
  });

  it('un cambio de precio del ADMIN mientras la compra espera el bloqueo del producto da PRICE_CHANGED sin cobrar', async () => {
    const productId = await createProduct('PRECIO', 1000, 10);
    const [buyer] = await createBuyers(1);
    const prepared = await quoteFor(buyer!.token, productId);
    const balanceBefore = await card('DEMO_APPROVED');
    const stockBefore = await stockOf(productId);

    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const lockTask = db.client.transaction(async (tx: any) => {
      await tx.query(db.client.raw.sql`SELECT id FROM public.product WHERE id = ${productId} FOR UPDATE`.returnsRow({ id: 'pg/text@1' }).build());
      locked();
      await hold;
      // El ADMIN cambia el precio y confirma justo cuando la compra ya está esperando.
      await tx.execute(db.client.raw.sql`UPDATE public.product SET "priceCents" = 1500, price = 15 WHERE id = ${productId}`.affectedCount().build());
    });
    await acquired;

    const pending = buy(buyer!.token, prepared, APPROVED).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 1500)); // la compra está bloqueada esperando
    release();
    await lockTask;
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRICE_CHANGED');
    expect(await stockOf(productId)).toBe(stockBefore);
    expect(await card('DEMO_APPROVED')).toBe(balanceBefore);
  });

  it('un cambio de ajustes del ADMIN espera a la compra en curso (bloqueo FOR SHARE) y la siguiente compra con la cotización vieja da SHOP_SETTINGS_CHANGED', async () => {
    const productId = await createProduct('AJUSTES', 1000, 10);
    const [buyer] = await createBuyers(1);
    const inFlight = await quoteFor(buyer!.token, productId);
    const stale = await quoteFor(buyer!.token, productId);
    const ordersBefore = await countRows('Order');

    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const lockTask = db.client.transaction(async (tx: any) => {
      await tx.query(db.client.raw.sql`SELECT id FROM public.product WHERE id = ${productId} FOR UPDATE`.returnsRow({ id: 'pg/text@1' }).build());
      locked();
      await hold;
    });
    await acquired;

    const pendingPurchase = buy(buyer!.token, inFlight, APPROVED).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 1500)); // la compra ya tomó los ajustes y espera el producto

    const version = (await http().get('/api/v1/shop/settings').expect(200)).body.version;
    const adminId = randomUUID();
    await db.user.create({ id: adminId, name: 'Admin', email: `admin-${adminId}@example.test`, password: 'fixture-not-real', role: 'ADMIN' });
    let patchDone = false;
    const pendingPatch = http()
      .patch('/api/v1/admin/shop-settings')
      .set(auth(jwtSign({ sub: adminId, email: `admin-${adminId}@example.test`, role: 'ADMIN' })))
      .send({ expectedVersion: version, tax: { rateBps: 1400 } })
      .then((res) => { patchDone = true; return res; });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(patchDone).toBe(false); // el ADMIN espera: la compra en curso conserva los ajustes con los que se cotizó

    release();
    await lockTask;
    const purchase = await pendingPurchase;
    const patch = await pendingPatch;

    expect(purchase.status).toBe(201);
    expect(purchase.body.order.taxRateBps).toBe(1500);
    expect(patch.status).toBe(200);

    const balanceAfterFirst = await card('DEMO_APPROVED');
    const late = await buy(buyer!.token, stale, APPROVED);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('SHOP_SETTINGS_CHANGED');
    expect(await card('DEMO_APPROVED')).toBe(balanceAfterFirst);
    expect(await countRows('Order')).toBe(ordersBefore + 1);
  });

  describe('Horario de atención (CT-009 y CT-040)', () => {
    let adminToken: string;
    let adminAvailable = false;
    const patchSchedule = async (startTime: string, endTime: string) => {
      const version = (await http().get('/api/v1/shop/settings').expect(200)).body.version;
      return http().patch('/api/v1/admin/shop-settings').set(auth(adminToken)).send({ expectedVersion: version, deliverySchedule: { startTime, endTime } });
    };
    const quoteAt = (token: string, productId: string, scheduledDeliveryDate: string) => {
      const dlv = { ...delivery(), scheduledDeliveryDate };
      return http().post('/api/v1/shop/checkout/quote').set(auth(token)).send({ items: [{ productId, quantity: 1 }], delivery: dlv });
    };
    const unchanged = async (before: { balance: bigint; orders: number; payments: number; receipts: number }, productId: string, stock: number) => {
      expect(await card('DEMO_APPROVED')).toBe(before.balance);
      expect(await countRows('Order')).toBe(before.orders);
      expect(await countRows('PaymentAttempt')).toBe(before.payments);
      expect(await countRows('PurchaseReceipt')).toBe(before.receipts);
      expect(await stockOf(productId)).toBe(stock);
    };
    const snapshot = async () => ({
      balance: await card('DEMO_APPROVED'),
      orders: await countRows('Order'),
      payments: await countRows('PaymentAttempt'),
      receipts: await countRows('PurchaseReceipt'),
    });

    beforeAll(async () => {
      const adminId = randomUUID();
      const email = `admin-horario-${adminId}@example.test`;
      await db.user.create({ id: adminId, name: 'Admin Horario', email, password: 'fixture-not-real', role: 'ADMIN' });
      adminToken = jwtSign({ sub: adminId, email, role: 'ADMIN' });
      adminAvailable = true;
    });
    afterAll(async () => {
      if (adminAvailable) await patchSchedule('07:00', '17:00'); // deja el horario inicial del contrato
    });

    it('CT-009: una fecha que vence mientras la compra espera el bloqueo del producto se rechaza con DELIVERY_INVALID sin cobrar', async () => {
      expect((await patchSchedule('00:00', '23:59')).status).toBe(200); // el horario no debe influir en este caso
      const productId = await createProduct('FECHA', 1000, 10);
      const [buyer] = await createBuyers(1);
      const scheduled = new Date(Date.now() + 9_000).toISOString(); // futura al cotizar, vencida al terminar la espera
      const quote = await quoteAt(buyer!.token, productId, scheduled);
      expect(quote.status).toBe(200);
      const prepared = { items: [{ productId, quantity: 1 }], delivery: { ...delivery(), scheduledDeliveryDate: scheduled }, quoteToken: quote.body.quoteToken as string };
      const before = await snapshot();

      let release!: () => void;
      let locked!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const acquired = new Promise<void>((resolve) => { locked = resolve; });
      const lockTask = db.client.transaction(async (tx: any) => {
        await tx.query(db.client.raw.sql`SELECT id FROM public.product WHERE id = ${productId} FOR UPDATE`.returnsRow({ id: 'pg/text@1' }).build());
        locked();
        await hold;
      });
      await acquired;

      const pending = buy(buyer!.token, prepared, APPROVED).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(scheduled) - Date.now()) + 1500)); // la fecha ya venció con la compra en espera
      release();
      await lockTask;
      const res = await pending;

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('DELIVERY_INVALID');
      await unchanged(before, productId, 10);
    });

    it('CT-040: tras cambiar el horario el ADMIN, la cotización anterior da SHOP_SETTINGS_CHANGED, la nueva valida el horario vigente y compra', async () => {
      expect((await patchSchedule('07:00', '17:00')).status).toBe(200);
      const productId = await createProduct('HORARIO', 1000, 10);
      const [buyer] = await createBuyers(1);
      const stale = await quoteFor(buyer!.token, productId); // 10:00 local, válida con 07:00–17:00
      const before = await snapshot();

      expect((await patchSchedule('08:00', '09:00')).status).toBe(200);

      const late = await buy(buyer!.token, stale, APPROVED);
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('SHOP_SETTINGS_CHANGED');
      await unchanged(before, productId, 10);

      const outside = await quoteAt(buyer!.token, productId, deliveryDate()); // 10:00 local: fuera de 08:00–09:00
      expect(outside.status).toBe(422);
      expect(outside.body.error.code).toBe('DELIVERY_OUTSIDE_HOURS');

      const inside = new Date(Date.now() + 3 * 86_400_000);
      inside.setUTCHours(13, 30, 0, 0); // 08:30 en Guayaquil
      const fresh = await quoteAt(buyer!.token, productId, inside.toISOString());
      expect(fresh.status).toBe(200);
      const bought = await buy(buyer!.token, { items: [{ productId, quantity: 1 }], delivery: { ...delivery(), scheduledDeliveryDate: inside.toISOString() }, quoteToken: fresh.body.quoteToken }, APPROVED);
      expect(bought.status).toBe(201);
      expect(await stockOf(productId)).toBe(9);
    });
  });
});
