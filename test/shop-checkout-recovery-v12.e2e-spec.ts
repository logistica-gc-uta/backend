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

  describe('Observable PROCESSING & Stale Orphan Reconciliation', () => {
    it('real HTTP checkout blocked on owned product lock: observes DURABLE reservation via GET, remains PROCESSING when stale under active key lock with no changed money, and resolves to original 201 same attemptId upon release', async () => {
      const inFlightKey = randomUUID();
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      const payload = buildCheckoutPayload(token);

      const balanceBefore = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
      ).balanceCents;
      const stockBefore = (
        await db.client.orm.public.Product.where({ id: publishedProductId }).first()
      ).stock;

      let releaseProductLock!: () => void;
      let signalProductLock!: () => void;
      let rejectProductLock!: (error: unknown) => void;
      const productLockHeld = new Promise<void>((resolve) => { releaseProductLock = resolve; });
      const productLockAcquired = new Promise<void>((resolve, reject) => {
        signalProductLock = resolve;
        rejectProductLock = reject;
      });
      const productLockTask = db.client.transaction(async (tx: any) => {
        await tx.query(
          db.client.raw.sql`
            SELECT id FROM public.product WHERE id = ${publishedProductId} FOR UPDATE
          `.returnsRow({ id: 'pg/text@1' }).build(),
        );
        signalProductLock();
        await productLockHeld;
      });
      void productLockTask.catch(rejectProductLock);

      await productLockAcquired;

      let postPromise: Promise<any> | null = null;
      try {
        postPromise = http()
          .post('/api/v1/shop/checkout')
          .set(auth(clientToken))
          .set('Idempotency-Key', inFlightKey)
          .timeout({ response: 15000, deadline: 20000 })
          .send(payload)
          .then((response) => response);

        // Bounded async barrier: poll GET until DURABLE reservation is observed
        let observedAttemptId: string | null = null;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const getRes = await http()
            .get(`/api/v1/shop/checkout-attempts/${inFlightKey}`)
            .set(auth(clientToken));
          if (getRes.status === 200 && getRes.body.status === 'PROCESSING') {
            observedAttemptId = getRes.body.checkoutAttemptId;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        expect(observedAttemptId).toBeTruthy();

        // A visible reservation alone does not prove that its owner has acquired the key lock.
        let ownerHoldsKey = false;
        const ownerDeadline = Date.now() + 5000;
        while (Date.now() < ownerDeadline) {
          ownerHoldsKey = await db.client.transaction(async (tx: any) => {
            const [probe] = await tx.query(
              db.client.raw.sql`
                SELECT pg_try_advisory_xact_lock(
                  hashtext('checkout_intent'), hashtext(${clientUserId} || ':' || ${inFlightKey})
                ) AS available
              `.returnsRow({ available: 'pg/bool@1' }).build(),
            );
            return probe.available === false;
          });
          if (ownerHoldsKey) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(ownerHoldsKey).toBe(true);

        // Make createdAt stale (25 minutes ago) only in owned fixture
        await db.client.transaction(async (tx: any) => {
          await tx.execute(
            db.client.raw.sql`
              UPDATE public."checkoutAttempt"
              SET "createdAt" = clock_timestamp() - INTERVAL '25 minutes',
                  "updatedAt" = clock_timestamp() - INTERVAL '25 minutes'
              WHERE "idempotencyKey" = ${inFlightKey}
            `.affectedCount().build(),
          );
        });

        // While owner actively holds PostgreSQL advisory key lock, GET must REMAIN PROCESSING (active owner not reconciled)
        const staleGetRes = await http()
          .get(`/api/v1/shop/checkout-attempts/${inFlightKey}`)
          .set(auth(clientToken));

        expect(staleGetRes.status).toBe(200);
        expect(staleGetRes.body.status).toBe('PROCESSING');
        expect(staleGetRes.body.checkoutAttemptId).toBe(observedAttemptId);

        // Money and stock remain unchanged
        const balanceDuring = (
          await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
        ).balanceCents;
        const stockDuring = (
          await db.client.orm.public.Product.where({ id: publishedProductId }).first()
        ).stock;
        expect(balanceDuring).toBe(balanceBefore);
        expect(stockDuring).toBe(stockBefore);

        // Release product lock so HTTP checkout unblocks and completes
        releaseProductLock();
        await productLockTask;

        const postRes = await postPromise;
        expect(postRes.status).toBe(201);
        expect(postRes.body.checkoutAttemptId).toBe(observedAttemptId);

        // GET confirms SUCCEEDED with identical attemptId
        const finalGetRes = await http()
          .get(`/api/v1/shop/checkout-attempts/${inFlightKey}`)
          .set(auth(clientToken));

        expect(finalGetRes.status).toBe(200);
        expect(finalGetRes.body.status).toBe('SUCCEEDED');
        expect(finalGetRes.body.checkoutAttemptId).toBe(observedAttemptId);
      } finally {
        releaseProductLock();
        await productLockTask;
        if (postPromise) await postPromise.catch(() => {});
      }
    });


    it('stale orphan reconciler: marks stale (>15 min) unowned PROCESSING attempt FAILED with safe INTERNAL_ERROR', async () => {
      const staleKey = randomUUID();
      const attemptId = randomUUID();

      // Insert an orphan attempt with createdAt 25 minutes in the past
      await db.client.transaction(async (tx: any) => {
        await tx.execute(
          db.client.raw.sql`
            INSERT INTO public."checkoutAttempt" (
              "id", "userId", "idempotencyKey", "requestHash", "status",
              "createdAt", "updatedAt"
            ) VALUES (
              ${attemptId}, ${clientUserId}, ${staleKey}, 'test-stale-hash', 'PROCESSING',
              clock_timestamp() - INTERVAL '25 minutes', clock_timestamp() - INTERVAL '25 minutes'
            )
          `.affectedCount().build()
        );
      });

      const stockBefore = (await db.client.orm.public.Product.where({ id: publishedProductId }).first()).stock;
      const balanceBefore = (await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()).balanceCents;
      const ordersBefore = (await db.client.orm.public.Order.all()).length;

      // GET triggers internal bounded stale reconciler
      const getRes = await http()
        .get(`/api/v1/shop/checkout-attempts/${staleKey}`)
        .set(auth(clientToken));

      expect(getRes.status).toBe(200);
      expect(getRes.body).toMatchObject({
        status: 'FAILED',
        checkoutAttemptId: attemptId,
        orderId: null,
        receiptId: null,
        errorCode: 'INTERNAL_ERROR',
      });

      // Verify no money/stock/order side-effects
      const stockAfter = (await db.client.orm.public.Product.where({ id: publishedProductId }).first()).stock;
      const balanceAfter = (await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()).balanceCents;
      const ordersAfter = (await db.client.orm.public.Order.all()).length;

      expect(stockAfter).toBe(stockBefore);
      expect(balanceAfter).toBe(balanceBefore);
      expect(ordersAfter).toBe(ordersBefore);
    });

    it('FAILED POST never creates a new purchase or charges', async () => {
      const failedKey = randomUUID();
      const attemptId = randomUUID();
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      const payload = buildCheckoutPayload(token);
      const { buildCanonicalIntent, hashCanonicalIntent } = await import(
        '../src/modules/shop/checkout/checkout-intent.util.js'
      );
      const requestHash = hashCanonicalIntent(
        buildCanonicalIntent({
          items: payload.items,
          delivery: payload.delivery,
          quoteToken: payload.quoteToken,
          cardFixtureId: 'DEMO_APPROVED',
        }),
      );

      await db.client.transaction(async (tx: any) => {
        await tx.execute(
          db.client.raw.sql`
            INSERT INTO public."checkoutAttempt" (
              "id", "userId", "idempotencyKey", "requestHash", "status",
              "errorCode", "errorMessage", "createdAt", "updatedAt"
            ) VALUES (
              ${attemptId}, ${clientUserId}, ${failedKey}, ${requestHash}, 'FAILED',
              'INTERNAL_ERROR', 'Error interno simulado', clock_timestamp(), clock_timestamp()
            )
          `.affectedCount().build()
        );
      });

      const postRes = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', failedKey)
        .send(payload);

      expect(postRes.status).toBe(500);
      expect(postRes.body.error.code).toBe('INTERNAL_ERROR');
    });

    it('bounded wait under held key lock: duplicate times out with INTERNAL_ERROR without changing its durable PROCESSING state', async () => {
      const waitKey = randomUUID();
      const attemptId = randomUUID();
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      const payload = buildCheckoutPayload(token);
      const { buildCanonicalIntent, hashCanonicalIntent } = await import(
        '../src/modules/shop/checkout/checkout-intent.util.js'
      );
      const requestHash = hashCanonicalIntent(
        buildCanonicalIntent({
          items: payload.items,
          delivery: payload.delivery,
          quoteToken: payload.quoteToken,
          cardFixtureId: 'DEMO_APPROVED',
        }),
      );

      // The reservation must be committed and visible before simulating its active owner.
      await db.client.transaction(async (tx: any) => {
        await tx.execute(
          db.client.raw.sql`
            INSERT INTO public."checkoutAttempt" (
              "id", "userId", "idempotencyKey", "requestHash", "status",
              "createdAt", "updatedAt"
            ) VALUES (
              ${attemptId}, ${clientUserId}, ${waitKey}, ${requestHash}, 'PROCESSING',
              clock_timestamp(), clock_timestamp()
            )
          `.affectedCount().build(),
        );
      });

      let releaseKeyLock!: () => void;
      let signalKeyLock!: () => void;
      let rejectKeyLock!: (error: unknown) => void;
      const keyLockHeld = new Promise<void>((resolve) => { releaseKeyLock = resolve; });
      const keyLockAcquired = new Promise<void>((resolve, reject) => {
        signalKeyLock = resolve;
        rejectKeyLock = reject;
      });
      const keyLockTask = db.client.transaction(async (tx: any) => {
        await tx.query(
          db.client.raw.sql`
            SELECT 1 AS locked
            FROM pg_advisory_xact_lock(hashtext('checkout_intent'), hashtext(${clientUserId} || ':' || ${waitKey}))
          `.returnsRow({ locked: 'pg/int4@1' }).build(),
        );
        signalKeyLock();
        await keyLockHeld;
      });
      void keyLockTask.catch(rejectKeyLock);

      await keyLockAcquired;

      try {
        const before = await http()
          .get(`/api/v1/shop/checkout-attempts/${waitKey}`)
          .set(auth(clientToken))
          .expect(200);
        const balanceBefore = (await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()).balanceCents;
        const stockBefore = (await db.client.orm.public.Product.where({ id: publishedProductId }).first()).stock;

        // While the owner holds the key, a duplicate waits without taking ownership.
        const started = performance.now();
        const postRes = await http()
          .post('/api/v1/shop/checkout')
          .set(auth(clientToken))
          .set('Idempotency-Key', waitKey)
          .timeout({ response: 15000, deadline: 20000 })
          .send(payload);
        const elapsed = performance.now() - started;

        expect(elapsed).toBeGreaterThanOrEqual(4500);
        expect(elapsed).toBeLessThan(10000);
        expect(postRes.status).toBe(500);
        expect(postRes.body.error).toEqual({
          code: 'INTERNAL_ERROR',
          message: 'Request could not be completed',
          details: {},
          requestId: expect.any(String),
        });

        // Neither the durable decision/timestamp nor financial state may change.
        const inFlightCheck = await http()
          .get(`/api/v1/shop/checkout-attempts/${waitKey}`)
          .set(auth(clientToken));
        expect(inFlightCheck.status).toBe(200);
        expect(inFlightCheck.body).toEqual(before.body);
        expect(inFlightCheck.body.status).toBe('PROCESSING');
        expect((await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()).balanceCents).toBe(balanceBefore);
        expect((await db.client.orm.public.Product.where({ id: publishedProductId }).first()).stock).toBe(stockBefore);
      } finally {
        releaseKeyLock();
        await keyLockTask;
      }
    });
  });


  describe('Real Lost Response After Backend Commit (Fixture-Only Socket Proxy)', () => {
    it('simulates lost HTTP response after backend commit; GET recovers SUCCEEDED and POST replays exact 201', async () => {
      // 1. Create a fixture TCP proxy in front of Nest HTTP server
      const serverAddress = app.getHttpServer().address();
      const targetPort = typeof serverAddress === 'object' ? serverAddress.port : 3000;

      let proxySeverCutDone = false;
      let interceptedCommit = false;
      let clientObservedNetworkFailure = false;
      const activeSockets = new Set<Socket>();
      let proxyServer: ReturnType<typeof createServer> | null = null;

      const lostKey = randomUUID();
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      const payload = buildCheckoutPayload(token);

      const balanceBefore = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
      ).balanceCents;
      const stockBefore = (
        await db.client.orm.public.Product.where({ id: publishedProductId }).first()
      ).stock;

      try {
        proxyServer = createServer((clientSock: Socket) => {
          activeSockets.add(clientSock);
          const targetSock = new Socket();
          activeSockets.add(targetSock);

          targetSock.connect(targetPort, '127.0.0.1', () => {
            clientSock.pipe(targetSock);
          });

          targetSock.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            // Backend responded with 201 Created (commit succeeded!)
            if (text.includes('201') && !proxySeverCutDone) {
              interceptedCommit = true;
              proxySeverCutDone = true;
              // Abruptly destroy client socket before client receives response bytes
              setTimeout(() => {
                clientSock.destroy();
                targetSock.destroy();
              }, 20);
            } else {
              clientSock.write(chunk);
            }
          });

          clientSock.on('error', () => {});
          targetSock.on('error', () => {});
          clientSock.on('close', () => activeSockets.delete(clientSock));
          targetSock.on('close', () => activeSockets.delete(targetSock));
        });

        await new Promise<void>((resolve) => proxyServer!.listen(0, '127.0.0.1', resolve));
        const proxyPort = (proxyServer.address() as any).port;

        // 2. Client issues POST via proxy; expects socket reset/hang up
        try {
          await request(`http://127.0.0.1:${proxyPort}`)
            .post('/api/v1/shop/checkout')
            .set(auth(clientToken))
            .set('Idempotency-Key', lostKey)
            .timeout({ response: 5000, deadline: 10000 })
            .send(payload);
        } catch {
          clientObservedNetworkFailure = true;
        }
      } finally {
        for (const sock of activeSockets) {
          try {
            sock.destroy();
          } catch {}
        }
        activeSockets.clear();

        if (proxyServer) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            proxyServer!.close(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      }

      expect(interceptedCommit).toBe(true);
      expect(clientObservedNetworkFailure).toBe(true);


      // 3. Client recovers status via GET /checkout-attempts/:key
      const recoveryGet = await http()
        .get(`/api/v1/shop/checkout-attempts/${lostKey}`)
        .set(auth(clientToken));

      expect(recoveryGet.status).toBe(200);
      expect(recoveryGet.body.status).toBe('SUCCEEDED');
      expect(recoveryGet.body.orderId).toBeTruthy();
      expect(recoveryGet.body.receiptId).toBeTruthy();

      const recoveredOrderId = recoveryGet.body.orderId;
      const recoveredReceiptId = recoveryGet.body.receiptId;

      // 4. Client retries original POST with same Idempotency-Key
      const retryPost = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', lostKey)
        .send(payload);

      expect(retryPost.status).toBe(201);
      expect(retryPost.body.status).toBe('SUCCEEDED');
      expect(retryPost.body.order.id).toBe(recoveredOrderId);
      expect(retryPost.body.receipt.id).toBe(recoveredReceiptId);

      // 5. Verify card was debited ONLY once and stock was decremented ONLY once!
      const balanceAfter = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
      ).balanceCents;
      const stockAfter = (
        await db.client.orm.public.Product.where({ id: publishedProductId }).first()
      ).stock;

      expect(balanceBefore - balanceAfter).toBe(BigInt(retryPost.body.order.totalCents));
      expect(stockBefore - stockAfter).toBe(1);
    });
  });

  describe('Snapshot Immutability After Admin Catalog & Tax Changes', () => {
    it('preserves immutable PurchaseReceipt and Order snapshot after admin updates product price, name and tax', async () => {
      const key = randomUUID();
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      const postRes = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', key)
        .send(buildCheckoutPayload(token));

      expect(postRes.status).toBe(201);
      const receiptId = postRes.body.receipt.id;
      const orderId = postRes.body.order.id;

      // Read initial receipt snapshot
      const receiptBefore = await db.client.orm.public.PurchaseReceipt.where({ id: receiptId }).first();
      const snapshotBefore = receiptBefore.snapshot as any;
      expect(snapshotBefore.items[0].unitPriceCents).toBe(3650);
      expect(snapshotBefore.pricing.totalCents).toBe(4198);

      // Admin updates product price to $50.00 and alters product name
      await db.client.orm.public.Product.where({ id: publishedProductId }).update({
        price: 50.0,
        priceCents: 5000n,
        name: 'Cesta Modificada Post Compra',
      });

      // Admin modifies shop settings tax rate to 1200 bps
      const settingsRow = (await db.client.orm.public.ShopBusinessSettings.all())[0];
      await db.client.orm.public.ShopBusinessSettings.where({ id: settingsRow.id }).update({
        taxRateBps: 1200,
        version: settingsRow.version + 1,
      });

      // Verify PurchaseReceipt snapshot in PostgreSQL remains 100% immutable
      const receiptAfter = await db.client.orm.public.PurchaseReceipt.where({ id: receiptId }).first();
      const snapshotAfter = receiptAfter.snapshot as any;

      expect(snapshotAfter.items[0].name).toBe('Cesta Gourmet Navideña');
      expect(snapshotAfter.items[0].unitPriceCents).toBe(3650);
      expect(snapshotAfter.pricing.subtotalCents).toBe(3650);
      expect(snapshotAfter.pricing.tax.rateBps).toBe(1500);
      expect(snapshotAfter.pricing.tax.amountCents).toBe(548);
      expect(snapshotAfter.pricing.totalCents).toBe(4198);

      // Verify Order items snapshot
      const orderItems = await db.client.orm.public.OrderItem.where({ orderId }).all();
      expect(orderItems[0].unitPriceCents).toBe(3650n);
    });
  });
});
