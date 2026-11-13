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
 * Casos de la matriz CI-SHOP-001 §15 (Issue #35-B) que las suites de Shop existentes no ejercían
 * de punta a punta. Usa el catálogo demo REAL de 200 regalos como fixture (el mismo seeder).
 */
describe('Shop v1.2 contract matrix gaps on the 200-gift demo catalog (owned PostgreSQL fixture)', () => {
  let app: INestApplication;
  let db: any;
  let clientToken: string;
  let adminToken: string;
  let zoneId: string;
  let freshSku: string; // regalo con stock alto
  let freshSku2: string;
  const outOfStockSku = 'RG-NAV-011';
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  // Siempre dentro del horario 07:00–17:00 de Guayaquil: 15:00Z = 10:00 local, tres días adelante.
  const deliveryDate = (): string => {
    const date = new Date(Date.now() + 3 * 86_400_000);
    date.setUTCHours(15, 0, 0, 0);
    return date.toISOString();
  };
  const delivery = () => ({
    recipient: { name: 'Ana Regalo', phone: '0991234567' },
    zoneId,
    deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
    deliveryLocation: { lat: -1.2425, lng: -78.6188 },
    scheduledDeliveryDate: deliveryDate(),
  });
  const quoteBody = (items: { productId: string; quantity: number }[], dlv = delivery()) => ({ items, delivery: dlv });
  const card = {
    number: '9000 0000 0000 0001',
    holderName: 'PRUEBA APROBADA',
    expiresMonth: 12,
    expiresYear: 2030,
    cvv: '111',
  };
  const idOf = async (sku: string): Promise<string> => (await db.client.orm.public.Product.where({ sku }).first()).id;
  const settingsVersion = async (): Promise<number> => (await http().get('/api/v1/shop/settings').expect(200)).body.version;
  const patchSettings = async (changes: Record<string, unknown>) =>
    http()
      .patch('/api/v1/admin/shop-settings')
      .set(auth(adminToken))
      .send({ expectedVersion: await settingsVersion(), ...changes });
  const snapshot = async () => ({
    balance: (await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()).balanceCents,
    orders: (await db.client.orm.public.Order.all()).length,
    payments: (await db.client.orm.public.PaymentAttempt.all()).length,
    receipts: (await db.client.orm.public.PurchaseReceipt.all()).length,
  });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';
    startOwnedContainer();
    const dbUrl = createOwnedDatabase(`shop_matrix_${dbSuffix}`);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');
    const { seedShopDemo } = await import('../src/prisma/shop-demo/seed.js');
    const { buildDemoCatalog } = await import('../src/prisma/shop-demo/dataset.js');
    const { publicIdFor } = await import('../src/prisma/shop-demo/images-manifest.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = app.get(PrismaService);
    const jwt = app.get(JwtService);

    const adminId = randomUUID();
    await db.user.create({ id: adminId, name: 'Admin', email: 'admin@delivery.com', password: 'fixture-not-real', role: 'ADMIN' });
    adminToken = jwt.sign({ sub: adminId, email: 'admin@delivery.com', role: 'ADMIN' });
    const clientId = randomUUID();
    const clientEmail = `client-${clientId}@example.test`;
    await db.user.create({ id: clientId, name: 'María Pérez', email: clientEmail, password: 'fixture-not-real', role: 'CLIENT' });
    clientToken = jwt.sign({ sub: clientId, email: clientEmail, role: 'CLIENT' });

    zoneId = randomUUID();
    await db.client.orm.public.Zone.create({
      id: zoneId, name: `Centro ${dbSuffix}`, code: `AM-${dbSuffix.slice(0, 4).toUpperCase()}`, depotLat: -1.2425, depotLng: -78.6188,
    });
    await seedAmbatoStoreCoverage(db);

    const { products } = buildDemoCatalog();
    const manifest = {
      version: 1 as const,
      cloudName: 'fixture-cloud',
      generatedAt: new Date().toISOString(),
      entries: products.map((p) => ({
        sku: p.sku,
        publicId: publicIdFor(p.sku),
        secureUrl: `https://res.cloudinary.com/fixture-cloud/image/upload/v1/${publicIdFor(p.sku)}.png`,
        format: 'png' as const, bytes: 2048, width: 600, height: 600, altText: `Foto de ${p.sku}`,
      })),
    };
    await seedShopDemo(db.client, { manifest });
    [freshSku, freshSku2] = products.filter((p) => p.stock >= 20).slice(0, 2).map((p) => p.sku);
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
  });

  describe('Catálogo público (CT-001 a CT-005)', () => {
    it('CT-001: el anónimo lista categorías y productos sin recursos de ADMIN', async () => {
      const categories = await http().get('/api/v1/shop/categories').expect(200);
      const products = await http().get('/api/v1/shop/products').expect(200);
      expect(categories.body.items).toHaveLength(10);
      expect(products.body.items.length).toBeGreaterThan(0);
      expect(JSON.stringify([categories.body, products.body])).not.toMatch(/password|actorId|@delivery\.com|"cleanup/i);
      await http().get('/api/v1/admin/catalog/products').expect(401);
    });

    it('CT-002: 200 regalos en 17 páginas de 12, última de 8, sin duplicados y con orden estable', async () => {
      const run = async () => {
        const ids: string[] = [];
        for (let page = 1; page <= 17; page++) {
          const res = await http().get(`/api/v1/shop/products?page=${page}&pageSize=12`).expect(200);
          expect(res.body).toMatchObject({ total: 200, totalPages: 17 });
          if (page === 17) expect(res.body.items).toHaveLength(8);
          ids.push(...res.body.items.map((item: any) => item.id));
        }
        return ids;
      };
      const first = await run();
      expect(new Set(first).size).toBe(200);
      expect(await run()).toEqual(first);
    });

    it('CT-003: un regalo sin stock se lista como no disponible, inStock=true lo oculta y no se puede añadir', async () => {
      const id = await idOf(outOfStockSku);
      const name = (await db.client.orm.public.Product.where({ id }).first()).name;

      const listed = await http().get(`/api/v1/shop/products?search=${encodeURIComponent(name)}&pageSize=48`).expect(200);
      const item = listed.body.items.find((candidate: any) => candidate.id === id);
      expect(item).toBeDefined();
      expect(item.isAvailable).toBe(false);

      const inStockOnly = await http().get(`/api/v1/shop/products?search=${encodeURIComponent(name)}&inStock=true`).expect(200);
      expect(inStockOnly.body.items.map((candidate: any) => candidate.id)).not.toContain(id);
      expect((await http().get(`/api/v1/shop/products/${id}`).expect(200)).body.isAvailable).toBe(false);

      // La cotización informa la falta de disponibilidad sin rechazarla, pero el pago no procede.
      const quote = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody([{ productId: id, quantity: 1 }])).expect(200);
      expect(quote.body.items[0].available).toBe(false);
    });

    it('CT-004: un regalo despublicado o de categoría inactiva desaparece del listado y su detalle da 404', async () => {
      const unpublishedId = await idOf('RG-CUM-001');
      await db.client.orm.public.Product.where({ id: unpublishedId }).update({ isPublished: false });
      await http().get(`/api/v1/shop/products/${unpublishedId}`).expect(404);

      const category = await db.client.orm.public.Category.where({ slug: 'san-valentin' }).first();
      await db.client.orm.public.Category.where({ id: category.id }).update({ isActive: false });
      const inactiveProduct = await idOf('RG-VAL-001');
      await http().get(`/api/v1/shop/products/${inactiveProduct}`).expect(404);
      const listing = await http().get('/api/v1/shop/products?pageSize=48&page=1').expect(200);
      expect(listing.body.total).toBe(200 - 1 - 20);
      const categories = await http().get('/api/v1/shop/categories').expect(200);
      expect(categories.body.items.map((c: any) => c.slug)).not.toContain('san-valentin');

      await db.client.orm.public.Category.where({ id: category.id }).update({ isActive: true });
      await db.client.orm.public.Product.where({ id: unpublishedId }).update({ isPublished: true });
      expect((await http().get('/api/v1/shop/products').expect(200)).body.total).toBe(200);
    });

    it('CT-005: filtros combinados de categoría, precio y búsqueda devuelven solo coincidencias y validan el rango', async () => {
      const category = (await http().get('/api/v1/shop/categories').expect(200)).body.items.find((c: any) => c.slug === 'navidad');
      const res = await http()
        .get(`/api/v1/shop/products?categoryId=${category.id}&minPriceCents=1000&maxPriceCents=3000&pageSize=48`)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const item of res.body.items) {
        expect(item.categoryId ?? item.category?.id).toBe(category.id);
        expect(item.priceCents).toBeGreaterThanOrEqual(1000);
        expect(item.priceCents).toBeLessThanOrEqual(3000);
      }
      const none = await http().get(`/api/v1/shop/products?categoryId=${category.id}&search=zzzzxxxx`).expect(200);
      expect(none.body.total).toBe(0);
      await http().get('/api/v1/shop/products?minPriceCents=3000&maxPriceCents=1000').expect(400);
    });
  });

  describe('Permisos y datos manipulados (CT-007, CT-013)', () => {
    it('CT-007: un CLIENT no accede a los endpoints ADMIN del catálogo y no recibe datos', async () => {
      const list = await http().get('/api/v1/admin/catalog/products').set(auth(clientToken)).expect(403);
      expect(JSON.stringify(list.body)).not.toContain('RG-');
      await http().post('/api/v1/admin/catalog/products').set(auth(clientToken)).send({ name: 'x' }).expect(403);
    });

    it('CT-013: precios o totales enviados por el cliente se rechazan y el total lo recalcula el backend', async () => {
      const productId = await idOf(freshSku);
      const tampered = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({ ...quoteBody([{ productId, quantity: 1 }]), totalCents: 1, items: [{ productId, quantity: 1, unitPriceCents: 1 }] })
        .expect(400);
      expect(tampered.body.error.code).toBe('VALIDATION_ERROR');
      const honest = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody([{ productId, quantity: 1 }])).expect(200);
      const product = await db.client.orm.public.Product.where({ id: productId }).first();
      expect(honest.body.subtotalCents).toBe(Number(product.priceCents));
    });
  });

  describe('Reversión total y límites (CT-016, CT-037)', () => {
    it('CT-016: con dos productos y uno sin stock, la compra se revierte entera', async () => {
      const okId = await idOf(freshSku);
      const emptyId = await idOf(outOfStockSku);
      const before = await snapshot();
      const stockBefore = (await db.client.orm.public.Product.where({ id: okId }).first()).stock;

      const items = [{ productId: okId, quantity: 1 }, { productId: emptyId, quantity: 1 }];
      const dlv = delivery();
      const quote = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody(items, dlv)).expect(200);
      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send({ items, delivery: dlv, quoteToken: quote.body.quoteToken, paymentCard: card });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('STOCK_UNAVAILABLE');
      expect((await db.client.orm.public.Product.where({ id: okId }).first()).stock).toBe(stockBefore);
      expect(await snapshot()).toEqual(before);
    });

    it('CT-037: 10 unidades se aceptan; 11 y los duplicados 6+5 se rechazan sin descontar nada', async () => {
      const productId = await idOf(freshSku);
      const before = await snapshot();
      await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody([{ productId, quantity: 10 }])).expect(200);
      for (const items of [[{ productId, quantity: 11 }], [{ productId, quantity: 6 }, { productId, quantity: 5 }]]) {
        const res = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody(items)).expect(422);
        expect(res.body.error.code).toBe('QUANTITY_LIMIT_EXCEEDED');
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('Ajustes versionados del ADMIN (CT-035, CT-036, CT-038, CT-040, CT-041)', () => {
    it('CT-041/CT-040: si el ADMIN cambia los ajustes entre la cotización y el pago, el pago da 409 SHOP_SETTINGS_CHANGED y no cobra', async () => {
      const productId = await idOf(freshSku);
      const items = [{ productId, quantity: 2 }];
      const dlv = delivery();
      const quote = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody(items, dlv)).expect(200);
      const before = await snapshot();

      await patchSettings({ tax: { rateBps: 1000 } }).then((res) => expect(res.status).toBe(200));

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send({ items, delivery: dlv, quoteToken: quote.body.quoteToken, paymentCard: card });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SHOP_SETTINGS_CHANGED');
      expect(await snapshot()).toEqual(before);
    });

    it('CT-035: la cotización nueva usa la tasa nueva (10%)', async () => {
      const productId = await idOf(freshSku);
      const res = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody([{ productId, quantity: 1 }])).expect(200);
      expect(res.body.tax).toMatchObject({ enabled: true, rateBps: 1000 });
      expect(res.body.tax.amountCents).toBe(Math.floor((res.body.subtotalCents * 1000 + 5000) / 10000));
      expect(res.body.settingsVersion).toBe(await settingsVersion());
    });

    it('CT-036: con el IVA deshabilitado el impuesto es 0 y el total es el subtotal', async () => {
      await patchSettings({ tax: { enabled: false } }).then((res) => expect(res.status).toBe(200));
      const productId = await idOf(freshSku2);
      const res = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody([{ productId, quantity: 3 }])).expect(200);
      expect(res.body.tax).toMatchObject({ enabled: false, amountCents: 0 });
      expect(res.body.totalCents).toBe(res.body.subtotalCents);
      await patchSettings({ tax: { enabled: true, rateBps: 1500 } }).then((res2) => expect(res2.status).toBe(200));
    });

    it('CT-038: con el máximo en 5 el backend rechaza 6 unidades aunque la interfaz lo permita', async () => {
      await patchSettings({ limits: { maxUnitsPerSkuPerOrder: 5 } }).then((res) => expect(res.status).toBe(200));
      const productId = await idOf(freshSku);
      const rejected = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody([{ productId, quantity: 6 }])).expect(422);
      expect(rejected.body.error.code).toBe('QUANTITY_LIMIT_EXCEEDED');
      await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody([{ productId, quantity: 5 }])).expect(200);
      await patchSettings({ limits: { maxUnitsPerSkuPerOrder: 10 } }).then((res) => expect(res.status).toBe(200));
    });
  });
});
