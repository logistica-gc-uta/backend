import { createServer, Socket } from 'node:net';
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
import { bootstrapSimulatedCards } from '../src/modules/shop/checkout/simulated-card.js';
import { signQuoteToken, QuoteTokenPayload } from '../src/modules/shop/checkout/quote-token.util.js';

jest.setTimeout(240_000);

describe('Shop Checkout v1.2 Recovery, Attempt GET & Durability E2E (owned PostgreSQL fixture)', () => {
  let app: INestApplication;
  let db: any;
  let clientToken: string;
  let clientUserId: string;
  let clientEmail: string;
  let otherClientToken: string;
  let otherClientUserId: string;
  let adminToken: string;
  let driverToken: string;

  let ownedContainerId: string | null = null;
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);
  let dbUrl: string;

  let activeCategoryId: string;
  let publishedProductId: string;
  let validZoneId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

    const receipt = startOwnedContainer();
    ownedContainerId = receipt.containerId;
    console.log(`[TEST-CONTAINER-RECEIPT] containerId=${receipt.containerId}`);
    dbUrl = createOwnedDatabase(`shop_recovery_${dbSuffix}`);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);

    db = app.get(PrismaService);
    const jwt = app.get(JwtService);

    await bootstrapSimulatedCards(db);

    clientUserId = randomUUID();
    clientEmail = `client-rec-${clientUserId}@example.test`;
    await db.user.create({
      id: clientUserId,
      name: 'Elena Recuperación',
      email: clientEmail,
      password: 'fixture-password',
      role: 'CLIENT',
    });
    clientToken = jwt.sign({ sub: clientUserId, email: clientEmail, role: 'CLIENT' });

    otherClientUserId = randomUUID();
    const otherEmail = `other-rec-${otherClientUserId}@example.test`;
    await db.user.create({
      id: otherClientUserId,
      name: 'Mario Otro',
      email: otherEmail,
      password: 'fixture-password',
      role: 'CLIENT',
    });
    otherClientToken = jwt.sign({ sub: otherClientUserId, email: otherEmail, role: 'CLIENT' });

    const adminId = randomUUID();
    await db.user.create({
      id: adminId,
      name: 'Admin User',
      email: `admin-rec-${adminId}@example.test`,
      password: 'fixture-password',
      role: 'ADMIN',
    });
    adminToken = jwt.sign({ sub: adminId, email: `admin-rec-${adminId}@example.test`, role: 'ADMIN' });

    const driverId = randomUUID();
    await db.user.create({
      id: driverId,
      name: 'Driver User',
      email: `driver-rec-${driverId}@example.test`,
      password: 'fixture-password',
      role: 'DRIVER',
    });
    driverToken = jwt.sign({ sub: driverId, email: `driver-rec-${driverId}@example.test`, role: 'DRIVER' });

    activeCategoryId = randomUUID();
    await db.client.orm.public.Category.create({
      id: activeCategoryId,
      name: `Navidad Rec ${dbSuffix}`,
      slug: `navidad-rec-${dbSuffix}`,
      isActive: true,
    });

    publishedProductId = randomUUID();
    await db.client.orm.public.Product.create({
      id: publishedProductId,
      name: 'Cesta Gourmet Navideña',
      description: 'Cesta gourmet navideña con vinos y chocolates',
      sku: `SKU-REC-${dbSuffix}`,
      price: 36.5,
      priceCents: 3650n,
      stock: 50,
      isPublished: true,
      isFeatured: true,
      categoryId: activeCategoryId,
    });

    validZoneId = randomUUID();
    await db.client.orm.public.Zone.create({
      id: validZoneId,
      name: `Ambato Rec ${dbSuffix}`,
      code: `AMBR-${dbSuffix.slice(0, 4).toUpperCase()}`,
      depotLat: -1.2425,
      depotLng: -78.6188,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
    if (ownedContainerId) {
      console.log(`[TEST-CONTAINER-CLEANUP] containerId=${ownedContainerId}`);
    }
  });

  const getValidQuoteToken = async (
    buyerId: string,
    productId: string,
    quantity: number,
    overrides: Partial<QuoteTokenPayload> = {},
  ): Promise<string> => {
    const unitPriceCents = 3650;
    const subtotalCents = unitPriceCents * quantity;
    const taxAmountCents = Math.floor((subtotalCents * 1500 + 5000) / 10000);
    const totalCents = subtotalCents + taxAmountCents;

    const nowRes = await db.client.transaction(async (tx: any) => {
      const { deliveryClock } = await import('../src/modules/orders/order-delivery.util.js');
      return deliveryClock(tx, db.client.raw);
    });
    const issuedAt = nowRes.toString();
    const validUntil = nowRes.add({ minutes: 15 }).toString();

    const payload: QuoteTokenPayload = {
      buyerUserId: buyerId,
      issuedAt,
      validUntil,
      settingsVersion: 1,
      currency: 'USD',
      tax: {
        mode: 'SIMULATED',
        enabled: true,
        rateBps: 1500,
        amountCents: taxAmountCents,
      },
      subtotalCents,
      shippingAmountCents: 0,
      totalCents,
      items: [
        {
          productId,
          quantity,
          unitPriceCents,
          lineTotalCents: subtotalCents,
        },
      ],
      delivery: {
        recipient: { name: 'Elena Destino', phone: '0991234567' },
        zoneId: validZoneId,
        deliveryAddress: 'Av. Cevallos 123, Ambato',
        deliveryLocation: { lat: -1.2425, lng: -78.6188 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      ...overrides,
    };
    return signQuoteToken(payload);
  };

  const buildCheckoutPayload = (token: string) => ({
    items: [{ productId: publishedProductId, quantity: 1 }],
    delivery: {
      recipient: { name: 'Elena Destino', phone: '0991234567' },
      zoneId: validZoneId,
      deliveryAddress: 'Av. Cevallos 123, Ambato',
      deliveryLocation: { lat: -1.2425, lng: -78.6188 },
      scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
    },
    quoteToken: token,
    paymentCard: {
      number: '9000 0000 0000 0001',
      holderName: 'PRUEBA APROBADA',
      expiresMonth: 12,
      expiresYear: 2030,
      cvv: '111',
    },
  });

  describe('GET /api/v1/shop/checkout-attempts/:idempotencyKey — Auth, Roles & IDOR Protection', () => {
    it('rejects unauthenticated request with HTTP 401', async () => {
      const res = await http().get(`/api/v1/shop/checkout-attempts/${randomUUID()}`);
      expect(res.status).toBe(401);
    });

    it('rejects ADMIN role with HTTP 403 (restricted to CLIENT)', async () => {
      const res = await http()
        .get(`/api/v1/shop/checkout-attempts/${randomUUID()}`)
        .set(auth(adminToken));
      expect(res.status).toBe(403);
    });

    it('rejects DRIVER role with HTTP 403 (restricted to CLIENT)', async () => {
      const res = await http()
        .get(`/api/v1/shop/checkout-attempts/${randomUUID()}`)
        .set(auth(driverToken));
      expect(res.status).toBe(403);
    });

    it('rejects non-UUIDv4 idempotencyKey parameter with HTTP 400 VALIDATION_ERROR', async () => {
      const res = await http()
        .get('/api/v1/shop/checkout-attempts/not-a-valid-uuid')
        .set(auth(clientToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns HTTP 404 CHECKOUT_ATTEMPT_NOT_FOUND when key does not exist', async () => {
      const res = await http()
        .get(`/api/v1/shop/checkout-attempts/${randomUUID()}`)
        .set(auth(clientToken));
      console.log('DEBUG 404 BODY:', JSON.stringify(res.body));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CHECKOUT_ATTEMPT_NOT_FOUND');
    });

    it('IDOR protection: returns indistinguishable HTTP 404 when querying an attempt owned by another client', async () => {
      // Client 1 creates a successful checkout
      const keyClient1 = randomUUID();
      const token1 = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      const postRes = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', keyClient1)
        .send(buildCheckoutPayload(token1));
      expect(postRes.status).toBe(201);

      // Client 2 attempts to probe Client 1's key
      const probeRes = await http()
        .get(`/api/v1/shop/checkout-attempts/${keyClient1}`)
        .set(auth(otherClientToken));

      expect(probeRes.status).toBe(404);
      expect(probeRes.body.error.code).toBe('CHECKOUT_ATTEMPT_NOT_FOUND');
    });
  });

  describe('Exact DTO Projection & Security Integrity', () => {
    it('returns exact DTO projection for SUCCEEDED attempt with no sensitive leakage', async () => {
      const key = randomUUID();
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      const postRes = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', key)
        .send(buildCheckoutPayload(token));
      expect(postRes.status).toBe(201);

      const getRes = await http()
        .get(`/api/v1/shop/checkout-attempts/${key}`)
        .set(auth(clientToken));

      expect(getRes.status).toBe(200);
      expect(getRes.body).toMatchObject({
        status: 'SUCCEEDED',
        checkoutAttemptId: postRes.body.checkoutAttemptId,
        orderId: postRes.body.order.id,
        receiptId: postRes.body.receipt.id,
        errorCode: null,
      });
      expect(typeof getRes.body.updatedAt).toBe('string');

      // Security check: exact projection only
      const keys = Object.keys(getRes.body).sort();
      expect(keys).toEqual([
        'checkoutAttemptId',
        'errorCode',
        'orderId',
        'receiptId',
        'status',
        'updatedAt',
      ]);

      expect(getRes.body.requestHash).toBeUndefined();
      expect(getRes.body.paymentAttemptId).toBeUndefined();
      expect(getRes.body.successSnapshot).toBeUndefined();
      expect(getRes.body.paymentCard).toBeUndefined();
      expect(getRes.body.balanceCents).toBeUndefined();
    });

    it('GET does not mutate stock, balance, or database state (GET money unchanged)', async () => {
      const key = randomUUID();
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', key)
        .send(buildCheckoutPayload(token));

      const stockBefore = (await db.client.orm.public.Product.where({ id: publishedProductId }).first()).stock;
      const balanceBefore = (await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()).balanceCents;
      const orderCountBefore = (await db.client.orm.public.Order.all()).length;

      // Repeat GET 5 times
      for (let i = 0; i < 5; i++) {
        const res = await http()
          .get(`/api/v1/shop/checkout-attempts/${key}`)
          .set(auth(clientToken));
        expect(res.status).toBe(200);
      }

      const stockAfter = (await db.client.orm.public.Product.where({ id: publishedProductId }).first()).stock;
      const balanceAfter = (await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()).balanceCents;
      const orderCountAfter = (await db.client.orm.public.Order.all()).length;

      expect(stockAfter).toBe(stockBefore);
      expect(balanceAfter).toBe(balanceBefore);
      expect(orderCountAfter).toBe(orderCountBefore);
    });
  });
});
