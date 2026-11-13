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
import { buildValidators, describeErrors, loadOpenApi } from './shop-openapi-contract.js';

jest.setTimeout(240_000);

/**
 * Validación contractual (Issue #35): cada respuesta real de la API se valida con Ajv contra el esquema que
 * `docs/REGALIA-SHOP-OPENAPI-v1.2.yaml` declara para ese método, ruta y estado. Usa el catálogo demo de 200 regalos.
 */
describe('Contrato OpenAPI v1.2 de Shop: las respuestas reales cumplen los esquemas del contrato (PostgreSQL propio)', () => {
  let app: INestApplication;
  let db: any;
  let clientToken: string;
  let adminToken: string;
  let zoneId: string;
  let freshSku: string;
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

  const openapi = loadOpenApi();
  const validators = buildValidators(openapi);
  /** Falla con el detalle de Ajv si el cuerpo real no cumple el esquema que el contrato declara para ese estado. */
  const expectContract = (res: { status: number; body: unknown }, method: string, route: string) => {
    const { validate, schema } = validators.forResponse(method, route, res.status);
    if (!validate(res.body)) {
      throw new Error(
        `${method.toUpperCase()} ${route} → ${res.status} no cumple '${schema}':\n${describeErrors(validate)}\n${JSON.stringify(res.body).slice(0, 400)}`,
      );
    }
  };
  const buyOnce = async () => {
    const productId = await idOf(freshSku);
    const items = [{ productId, quantity: 1 }];
    const dlv = delivery();
    const quote = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody(items, dlv));
    const key = randomUUID();
    const checkout = await http()
      .post('/api/v1/shop/checkout')
      .set(auth(clientToken))
      .set('Idempotency-Key', key)
      .send({ items, delivery: dlv, quoteToken: quote.body.quoteToken, paymentCard: card });
    return { quote, checkout, key };
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';
    startOwnedContainer();
    const dbUrl = createOwnedDatabase(`shop_openapi_${dbSuffix}`);
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
    freshSku = products.filter((p) => p.stock >= 20)[0]!.sku;
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
  });

  describe('Autenticación y catálogo', () => {
    it('POST /auth/register y /auth/login cumplen RegisterResponse y LoginResponse', async () => {
      const email = `contract-${randomUUID()}@example.test`;
      const registered = await http().post('/api/v1/auth/register').send({ name: 'Contrato Uno', email, password: 'secret123' }).expect(201);
      expectContract(registered, 'post', '/auth/register');
      const login = await http().post('/api/v1/auth/login').send({ email, password: 'secret123' }).expect(200);
      expectContract(login, 'post', '/auth/login');
    });

    it('GET /shop/categories, /shop/products y /shop/products/{id} cumplen el contrato', async () => {
      expectContract(await http().get('/api/v1/shop/categories').expect(200), 'get', '/shop/categories');
      const page = await http().get('/api/v1/shop/products?page=1&pageSize=12').expect(200);
      expectContract(page, 'get', '/shop/products');
      const detail = await http().get(`/api/v1/shop/products/${page.body.items[0].id}`).expect(200);
      expectContract(detail, 'get', '/shop/products/{id}');
    });

    it('GET /shop/settings y /admin/shop-settings cumplen el contrato; el CLIENT recibe 403 con ApiError', async () => {
      expectContract(await http().get('/api/v1/shop/settings').expect(200), 'get', '/shop/settings');
      expectContract(await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200), 'get', '/admin/shop-settings');
      expectContract(await http().get('/api/v1/admin/shop-settings').set(auth(clientToken)).expect(403), 'get', '/admin/shop-settings');
    });

    it('un ADMIN lee el catálogo administrativo y el contrato lo describe', async () => {
      expectContract(await http().get('/api/v1/admin/catalog/categories').set(auth(adminToken)).expect(200), 'get', '/admin/catalog/categories');
      const page = await http().get('/api/v1/admin/catalog/products?page=1&pageSize=5').set(auth(adminToken)).expect(200);
      expectContract(page, 'get', '/admin/catalog/products');
      const detail = await http().get(`/api/v1/admin/catalog/products/${page.body.items[0].id}`).set(auth(adminToken)).expect(200);
      expectContract(detail, 'get', '/admin/catalog/products/{id}');
    });
  });

  describe('Compra, pedidos y comprobante', () => {
    let purchase: Awaited<ReturnType<typeof buyOnce>>;
    let orderId: string;
    beforeAll(async () => {
      purchase = await buyOnce();
      orderId = (await http().get('/api/v1/shop/orders').set(auth(clientToken)).expect(200)).body.items[0].id;
    });

    it('POST /shop/checkout/quote y /shop/checkout cumplen QuoteResponse y CheckoutSuccess', () => {
      expect(purchase.quote.status).toBe(200);
      expectContract(purchase.quote, 'post', '/shop/checkout/quote');
      expect(purchase.checkout.status).toBe(201);
      expectContract(purchase.checkout, 'post', '/shop/checkout');
    });

    it('GET /shop/checkout-attempts/{key} cumple CheckoutAttemptStatus', async () => {
      expectContract(await http().get(`/api/v1/shop/checkout-attempts/${purchase.key}`).set(auth(clientToken)), 'get', '/shop/checkout-attempts/{idempotencyKey}');
    });

    it('GET /shop/orders cumple OrderList', async () => {
      expectContract(await http().get('/api/v1/shop/orders').set(auth(clientToken)).expect(200), 'get', '/shop/orders');
    });

    it('GET /shop/orders/{id} cumple OrderDetail', async () => {
      expectContract(await http().get(`/api/v1/shop/orders/${orderId}`).set(auth(clientToken)).expect(200), 'get', '/shop/orders/{id}');
    });

    it('GET /shop/orders/{id}/receipt cumple Receipt', async () => {
      expectContract(await http().get(`/api/v1/shop/orders/${orderId}/receipt`).set(auth(clientToken)).expect(200), 'get', '/shop/orders/{id}/receipt');
    });

    it('los errores de negocio cumplen ApiError: 401 sin token, 422 por límite por SKU y 409 por stock agotado', async () => {
      expectContract(await http().post('/api/v1/shop/checkout/quote').send({}).expect(401), 'post', '/shop/checkout/quote');
      const productId = await idOf(freshSku);
      const tooMany = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody([{ productId, quantity: 11 }])).expect(422);
      expectContract(tooMany, 'post', '/shop/checkout/quote');

      const items = [{ productId: await idOf(outOfStockSku), quantity: 1 }];
      const dlv = delivery();
      const quote = await http().post('/api/v1/shop/checkout/quote').set(auth(clientToken)).send(quoteBody(items, dlv));
      const soldOut = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send({ items, delivery: dlv, quoteToken: quote.body.quoteToken ?? 'x', paymentCard: card });
      expect([409, 422]).toContain(soldOut.status);
      expectContract(soldOut, 'post', '/shop/checkout');
    });
  });
});
