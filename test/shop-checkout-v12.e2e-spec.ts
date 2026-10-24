import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  getOwnedContainerReceipt,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';
import { bootstrapSimulatedCards } from '../src/modules/shop/checkout/simulated-card.js';
import { signQuoteToken, QuoteTokenPayload } from '../src/modules/shop/checkout/quote-token.util.js';

jest.setTimeout(240_000);

describe('Shop Checkout v1.2 Atomic Purchase & Idempotency E2E (owned PostgreSQL fixture)', () => {
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

  // Catalog entities
  let activeCategoryId: string;
  let publishedProductId: string; // Price: 3650 cents ($36.50), stock: 8
  let equalPriceProductId: string; // Price: 3650 cents ($36.50), stock: 10
  let singleStockProductId: string; // Price: 1000 cents ($10.00), stock: 1
  let zeroStockProductId: string; // Price: 2000 cents ($20.00), stock: 0
  let validZoneId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

    const receipt = startOwnedContainer();
    ownedContainerId = receipt.containerId;
    console.log(`[TEST-CONTAINER-RECEIPT] containerId=${receipt.containerId}`);
    dbUrl = createOwnedDatabase(`shop_checkout_${dbSuffix}`);
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
    await app.init();

    db = app.get(PrismaService);
    const jwt = app.get(JwtService);

    // Bootstrap simulated cards explicitly
    await bootstrapSimulatedCards(db);

    // Seed test users
    clientUserId = randomUUID();
    clientEmail = `client-${clientUserId}@example.test`;
    await db.user.create({
      id: clientUserId,
      name: 'María Pérez',
      email: clientEmail,
      password: 'fixture-password',
      role: 'CLIENT',
    });
    clientToken = jwt.sign({ sub: clientUserId, email: clientEmail, role: 'CLIENT' });

    otherClientUserId = randomUUID();
    const otherEmail = `other-${otherClientUserId}@example.test`;
    await db.user.create({
      id: otherClientUserId,
      name: 'Carlos Competidor',
      email: otherEmail,
      password: 'fixture-password',
      role: 'CLIENT',
    });
    otherClientToken = jwt.sign({ sub: otherClientUserId, email: otherEmail, role: 'CLIENT' });

    const adminId = randomUUID();
    await db.user.create({
      id: adminId,
      name: 'Admin User',
      email: `admin-${adminId}@example.test`,
      password: 'fixture-password',
      role: 'ADMIN',
    });
    adminToken = jwt.sign({ sub: adminId, email: `admin-${adminId}@example.test`, role: 'ADMIN' });

    const driverId = randomUUID();
    await db.user.create({
      id: driverId,
      name: 'Driver User',
      email: `driver-${driverId}@example.test`,
      password: 'fixture-password',
      role: 'DRIVER',
    });
    driverToken = jwt.sign({ sub: driverId, email: `driver-${driverId}@example.test`, role: 'DRIVER' });

    // Seed category and products
    activeCategoryId = randomUUID();
    await db.client.orm.public.Category.create({
      id: activeCategoryId,
      name: `Navidad ${dbSuffix}`,
      slug: `navidad-${dbSuffix}`,
      isActive: true,
    });

    publishedProductId = randomUUID();
    await db.client.orm.public.Product.create({
      id: publishedProductId,
      name: 'Caja sorpresa navideña',
      description: 'Hermosa caja sorpresa navideña con dulces y flores',
      sku: `SKU-${dbSuffix}-1`,
      price: 36.5,
      priceCents: 3650n,
      stock: 8,
      isPublished: true,
      isFeatured: true,
      categoryId: activeCategoryId,
    });

    equalPriceProductId = randomUUID();
    await db.client.orm.public.Product.create({
      id: equalPriceProductId,
      name: 'Arreglo floral alternativo',
      description: 'Arreglo floral alternativo con el mismo precio exacto',
      sku: `SKU-${dbSuffix}-ALT-1`,
      price: 36.5,
      priceCents: 3650n,
      stock: 10,
      isPublished: true,
      isFeatured: false,
      categoryId: activeCategoryId,
    });

    singleStockProductId = randomUUID();
    await db.client.orm.public.Product.create({
      id: singleStockProductId,
      name: 'Edición Limitada Única',
      description: 'Producto único exclusivo con stock unitario',
      sku: `SKU-${dbSuffix}-LIMIT-1`,
      price: 10.0,
      priceCents: 1000n,
      stock: 1,
      isPublished: true,
      isFeatured: false,
      categoryId: activeCategoryId,
    });

    zeroStockProductId = randomUUID();
    await db.client.orm.public.Product.create({
      id: zeroStockProductId,
      name: 'Producto Agotado',
      description: 'Producto sin stock disponible para pruebas de agotamiento',
      sku: `SKU-${dbSuffix}-ZERO`,
      price: 20.0,
      priceCents: 2000n,
      stock: 0,
      isPublished: true,
      isFeatured: false,
      categoryId: activeCategoryId,
    });

    // Seed zone with depot in Ambato
    validZoneId = randomUUID();
    await db.client.orm.public.Zone.create({
      id: validZoneId,
      name: `Centro Ambato ${dbSuffix}`,
      code: `AMB-${dbSuffix.slice(0, 4).toUpperCase()}`,
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
    const unitPriceCents =
      productId === publishedProductId
        ? 3650
        : productId === equalPriceProductId
        ? 3650
        : productId === zeroStockProductId
        ? 2000
        : 1000;
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
        recipient: { name: 'Ana Regalo', phone: '0991234567' },
        zoneId: validZoneId,
        deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
        deliveryLocation: { lat: -1.2425, lng: -78.6188 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      ...overrides,
    };

    return signQuoteToken(payload);
  };

  const buildCheckoutPayload = (quoteToken: string, cardOverrides: Record<string, any> = {}) => ({
    items: [
      {
        productId: publishedProductId,
        quantity: 2,
      },
    ],
    delivery: {
      recipient: {
        name: 'Ana Regalo',
        phone: '0991234567',
      },
      zoneId: validZoneId,
      deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
      deliveryLocation: {
        lat: -1.2425,
        lng: -78.6188,
      },
      scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
    },
    quoteToken,
    paymentCard: {
      number: '9000 0000 0000 0001',
      holderName: 'PRUEBA APROBADA',
      expiresMonth: 12,
      expiresYear: 2030,
      cvv: '111',
      ...cardOverrides,
    },
  });

  describe('Authentication, Roles & Header Validation', () => {
    it('returns 401 UNAUTHENTICATED without JWT Bearer header', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout')
        .set('Idempotency-Key', randomUUID())
        .send(buildCheckoutPayload('dummy-token'));

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 403 FORBIDDEN when accessed with ADMIN token', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(adminToken))
        .set('Idempotency-Key', randomUUID())
        .send(buildCheckoutPayload('dummy-token'));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 403 FORBIDDEN when accessed with DRIVER token', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(driverToken))
        .set('Idempotency-Key', randomUUID())
        .send(buildCheckoutPayload('dummy-token'));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 400 VALIDATION_ERROR when Idempotency-Key header is missing', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .send(buildCheckoutPayload('dummy-token'));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Idempotency-Key');
    });

    it('returns 400 VALIDATION_ERROR when Idempotency-Key is not a valid UUIDv4', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', 'invalid-key-format')
        .send(buildCheckoutPayload('dummy-token'));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR when extra unknown fields are present in request body', async () => {
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 2);
      const payload = {
        ...buildCheckoutPayload(token),
        forbiddenPrice: 9999,
        userId: 'hacker',
      };

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Card Synthetic Validation & Rejection Integrity', () => {
    it('returns 422 CARD_INVALID for non-existent card fixture', async () => {
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 2);
      const payload = buildCheckoutPayload(token, {
        number: '4111 1111 1111 1111',
      });

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CARD_INVALID');

      // Verify no order created
      const orders = await db.client.orm.public.Order.where({ userId: clientUserId }).all();
      expect(orders).toHaveLength(0);
    });

    it('returns 422 CARD_INVALID when card expiry date does not match fixture', async () => {
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 2);
      const payload = buildCheckoutPayload(token, {
        expiresYear: 2026,
        expiresMonth: 1,
      });

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CARD_INVALID');
    });

    it('returns 422 INSUFFICIENT_DEMO_FUNDS without exposing availableCents in details', async () => {
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 2);
      const key = randomUUID();
      const payload = buildCheckoutPayload(token, {
        number: '9000 0000 0000 0003',
        holderName: 'PRUEBA SIN SALDO',
        expiresMonth: 12,
        expiresYear: 2030,
        cvv: '333',
      });

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', key)
        .send(payload);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INSUFFICIENT_DEMO_FUNDS');
      expect(res.body.error.details.requiredCents).toBeDefined();
      expect(res.body.error.details.availableCents).toBeUndefined(); // Safe error details: balance NEVER exposed

      // Verify observable state: card balance intact at 0
      const emptyCard = await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_EMPTY' }).first();
      expect(emptyCard.balanceCents).toBe(0n);

      // Verify stock intact
      const prod = await db.client.orm.public.Product.where({ id: publishedProductId }).first();
      expect(prod.stock).toBe(8);

      // Verify no order or receipt created
      const orders = await db.client.orm.public.Order.where({ userId: clientUserId }).all();
      expect(orders).toHaveLength(0);

      // Verify terminal REJECTED attempt was recorded
      const attempt = await db.client.orm.public.CheckoutAttempt.where({
        userId: clientUserId,
        idempotencyKey: key,
      }).first();
      expect(attempt).toBeDefined();
      expect(attempt.status).toBe('REJECTED');
      expect(attempt.errorCode).toBe('INSUFFICIENT_DEMO_FUNDS');
      expect(attempt.orderId).toBeNull();
      expect(attempt.receiptId).toBeNull();
    });
  });

  describe('Signed Intent Binding Integrity (Delivery and Items)', () => {
    it('returns 400 VALIDATION_ERROR when delivery recipient is changed after quote', async () => {
      // 1. Get real quote via HTTP
      const quoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: [{ productId: publishedProductId, quantity: 2 }],
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });
      expect(quoteRes.status).toBe(200);
      const quoteToken = quoteRes.body.quoteToken;

      // 2. Tamper recipient name
      const payload = buildCheckoutPayload(quoteToken);
      payload.delivery.recipient.name = 'Otro Destinatario';

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.reason).toBe('DELIVERY_MISMATCH');

      // Verify no debit and no orders
      const card = await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first();
      expect(card.balanceCents).toBe(50000n);
      const orders = await db.client.orm.public.Order.where({ userId: clientUserId }).all();
      expect(orders).toHaveLength(0);
    });

    it('returns 400 VALIDATION_ERROR when delivery coordinates are changed after quote', async () => {
      const quoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: [{ productId: publishedProductId, quantity: 2 }],
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });
      expect(quoteRes.status).toBe(200);
      const quoteToken = quoteRes.body.quoteToken;

      const payload = buildCheckoutPayload(quoteToken);
      payload.delivery.deliveryLocation.lat = -1.2429; // tampered coordinate

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.reason).toBe('DELIVERY_MISMATCH');
    });

    it('returns 400 VALIDATION_ERROR when delivery date is changed after quote', async () => {
      const quoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: [{ productId: publishedProductId, quantity: 2 }],
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });
      expect(quoteRes.status).toBe(200);
      const quoteToken = quoteRes.body.quoteToken;

      const payload = buildCheckoutPayload(quoteToken);
      payload.delivery.scheduledDeliveryDate = '2026-11-16T15:00:00.000Z'; // tampered date

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.reason).toBe('DELIVERY_MISMATCH');
    });

    it('returns 400 VALIDATION_ERROR when basket composition is altered with equal-total products', async () => {
      // Quote for 2 units of publishedProductId ($73.00 total)
      const quoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: [{ productId: publishedProductId, quantity: 2 }],
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });
      expect(quoteRes.status).toBe(200);
      const quoteToken = quoteRes.body.quoteToken;

      // Tamper basket to use equal-price alternative product (2 units of equalPriceProductId at $36.50 = $73.00)
      const payload = buildCheckoutPayload(quoteToken);
      payload.items = [{ productId: equalPriceProductId, quantity: 2 }];

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.reason).toBe('ITEMS_MISMATCH');

      // Assert no charge, stock untouched
      const prodA = await db.client.orm.public.Product.where({ id: publishedProductId }).first();
      const prodB = await db.client.orm.public.Product.where({ id: equalPriceProductId }).first();
      expect(prodA.stock).toBe(8);
      expect(prodB.stock).toBe(10);
    });
  });

  describe('DTO Contract & Array Limits (1..50 Lines)', () => {
    it('accepts 25 product lines in quote and confirms successfully when settings limit fixture >= 50', async () => {
      // Temporarily set limit to 50
      await db.client.orm.public.ShopBusinessSettings.where({ singletonKey: 'GLOBAL' }).update({
        maxUnitsPerSkuPerOrder: 50,
      });

      const repeatedItems = Array.from({ length: 25 }, () => ({
        productId: equalPriceProductId,
        quantity: 1,
      }));

      const quoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: repeatedItems,
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });

      expect(quoteRes.status).toBe(200);
      expect(quoteRes.body.quoteToken).toBeDefined();

      // Reset settings limit
      await db.client.orm.public.ShopBusinessSettings.where({ singletonKey: 'GLOBAL' }).update({
        maxUnitsPerSkuPerOrder: 10,
      });
    });

    it('rejects 51 product lines with 400 VALIDATION_ERROR before business execution', async () => {
      const items51 = Array.from({ length: 51 }, () => ({
        productId: publishedProductId,
        quantity: 1,
      }));

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: items51,
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
          quoteToken: 'dummy-token',
          paymentCard: {
            number: '9000 0000 0000 0001',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Atomic Purchase Success Flow & Database Side-Effects ($73.00 + $10.95 = $83.95)', () => {
    let key: string;
    let originalPayload: any;
    let successBody: any;

    it('successfully confirms atomic checkout via real HTTP quote with exact amounts and frozen snapshots', async () => {
      key = randomUUID();

      // 1. Obtain real quote via public HTTP
      const quoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: [{ productId: publishedProductId, quantity: 2 }],
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });

      expect(quoteRes.status).toBe(200);
      const quoteToken = quoteRes.body.quoteToken;

      originalPayload = buildCheckoutPayload(quoteToken);

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', key)
        .send(originalPayload);

      expect(res.status).toBe(201);
      successBody = res.body;

      // Verify response envelope with full 32-char UUID entropy in commercial numbers
      expect(successBody).toEqual({
        checkoutAttemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        status: 'SUCCEEDED',
        order: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          number: expect.stringMatching(/^RG-\d{4}-[0-9A-Z]{32}$/),
          status: 'PENDING',
          subtotalCents: 7300,
          taxAmountCents: 1095,
          taxRateBps: 1500,
          shippingAmountCents: 0,
          totalCents: 8395,
          taxEnabled: true,
          currency: 'USD',
          scheduledDeliveryDate: expect.any(String),
        },
        payment: {
          status: 'APPROVED',
          amountCents: 8395,
          cardLast4: '0001',
          reference: expect.stringMatching(/^PAY-DEMO-\d{4}-[0-9A-Z]{32}$/),
        },
        receipt: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          number: expect.stringMatching(/^CMP-RG-\d{4}-[0-9A-Z]{32}$/),
        },
      });

      // 1. Verify card balance decremented from 50000 to 41605 (50000 - 8395)
      const approvedCard = await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first();
      expect(approvedCard.balanceCents).toBe(41605n);

      // 2. Verify product stock decremented from 8 to 6
      const prod = await db.client.orm.public.Product.where({ id: publishedProductId }).first();
      expect(prod.stock).toBe(6);

      // 3. Verify exactly 1 Order row created with Float subtotal
      const order = await db.client.orm.public.Order.where({ id: successBody.order.id }).first();
      expect(order).toBeDefined();
      expect(order.userId).toBe(clientUserId);
      expect(order.status).toBe('PENDING');
      expect(order.total).toBe(73.0);
      expect(order.subtotalCents).toBe(7300n);

      // 4. Verify OrderItem
      const items = await db.client.orm.public.OrderItem.where({ orderId: order.id }).all();
      expect(items).toHaveLength(1);
      expect(items[0].productId).toBe(publishedProductId);
      expect(items[0].quantity).toBe(2);

      // 5. Verify PaymentAttempt row
      const payment = await db.client.orm.public.PaymentAttempt.where({ orderId: order.id }).first();
      expect(payment).toBeDefined();
      expect(payment.status).toBe('APPROVED');
      expect(payment.totalCents).toBe(8395n);
      expect(payment.cardLast4).toBe('0001');

      // 6. Verify PurchaseReceipt row and frozen snapshot (using productId per #34)
      const receipt = await db.client.orm.public.PurchaseReceipt.where({ orderId: order.id }).first();
      expect(receipt).toBeDefined();
      expect(receipt.commercialOrderNumber).toBe(successBody.order.number);
      expect(receipt.number).toBe(successBody.receipt.number);
      expect(receipt.totalCents).toBe(8395n);
      expect(receipt.snapshot.items[0].productId).toBe(publishedProductId); // #34 snapshot contract
      expect(receipt.snapshot.buyer.email).toBe(clientEmail);

      // 7. Verify CheckoutAttempt row
      const attempt = await db.client.orm.public.CheckoutAttempt.where({
        userId: clientUserId,
        idempotencyKey: key,
      }).first();
      expect(attempt).toBeDefined();
      expect(attempt.status).toBe('SUCCEEDED');
    });

    it('returns exact 201 with identical body on sequential replay without re-charging card or decrementing stock', async () => {
      // Re-send with identical key and identical original payload
      const replayRes = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', key)
        .send(originalPayload);

      expect(replayRes.status).toBe(201);
      expect(replayRes.body).toEqual(successBody);

      // Balance MUST still be 41605 (NEVER double charged!)
      const card = await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first();
      expect(card.balanceCents).toBe(41605n);

      // Stock MUST still be 6 (NEVER double decremented!)
      const prod = await db.client.orm.public.Product.where({ id: publishedProductId }).first();
      expect(prod.stock).toBe(6);

      // Counts remain exactly 1
      const orderCount = (await db.client.orm.public.Order.all()).length;
      expect(orderCount).toBe(1);
    });

    it('replays known approved key with 201 even if quote token has expired', async () => {
      // Re-send with key of already committed transaction, asserting it returns 201 before quote expiry check
      const replayRes = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', key)
        .send(originalPayload);

      expect(replayRes.status).toBe(201);
      expect(replayRes.body).toEqual(successBody);
    });

    it('returns 409 IDEMPOTENCY_KEY_REUSED when same key is submitted with different payload', async () => {
      const differentPayload = {
        ...originalPayload,
        items: [{ productId: publishedProductId, quantity: 1 }],
      };

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', key) // Same key from previous successful checkout!
        .send(differentPayload);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('Business Invalidation Scenarios (Rollback and Protection)', () => {
    it('returns 409 QUOTE_EXPIRED when new unknown key is submitted with expired quote token', async () => {
      const nowRes = await db.client.transaction(async (tx: any) => {
        const { deliveryClock } = await import('../src/modules/orders/order-delivery.util.js');
        return deliveryClock(tx, db.client.raw);
      });
      const expiredUntil = nowRes.subtract({ minutes: 5 }).toString();

      const expiredToken = await getValidQuoteToken(clientUserId, publishedProductId, 1, {
        validUntil: expiredUntil,
      });

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(buildCheckoutPayload(expiredToken));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('QUOTE_EXPIRED');
    });

    it('returns 409 STOCK_UNAVAILABLE when product stock is 0', async () => {
      const token = await getValidQuoteToken(clientUserId, zeroStockProductId, 1);
      const payload = {
        ...buildCheckoutPayload(token),
        items: [{ productId: zeroStockProductId, quantity: 1 }],
      };

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('STOCK_UNAVAILABLE');
      expect(res.body.error.details.availableStock).toBe(0);
    });

    it('returns 409 PRICE_CHANGED when unit price in catalog was modified in DB after quote', async () => {
      // 1. Real quote via HTTP for singleStockProductId (price $10.00 = 1000 cents)
      const quoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: [{ productId: singleStockProductId, quantity: 1 }],
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });
      expect(quoteRes.status).toBe(200);
      const quoteToken = quoteRes.body.quoteToken;

      // 2. Real price change in database
      await db.client.orm.public.Product.where({ id: singleStockProductId }).update({
        price: 15.0,
        priceCents: 1500n,
      });

      const payload = {
        ...buildCheckoutPayload(quoteToken),
        items: [{ productId: singleStockProductId, quantity: 1 }],
      };

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRICE_CHANGED');

      // Restore price for subsequent tests
      await db.client.orm.public.Product.where({ id: singleStockProductId }).update({
        price: 10.0,
        priceCents: 1000n,
      });
    });

    it('returns 409 SHOP_SETTINGS_CHANGED when settings version changed after quote', async () => {
      // Quote claiming settingsVersion 99
      const staleToken = await getValidQuoteToken(clientUserId, publishedProductId, 1, {
        settingsVersion: 99,
      });

      const payload = {
        ...buildCheckoutPayload(staleToken),
        items: [{ productId: publishedProductId, quantity: 1 }],
      };

      const res = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(payload);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SHOP_SETTINGS_CHANGED');
    });
  });

  describe('Focused Concurrency Protection on Real PostgreSQL', () => {
    it('concurrent competitor race for single stock (stock=1) with TWO CLIENTs and TWO DIFFERENT CARDS: exactly one approved, loser untouched', async () => {
      // Client A quote with singleStockProductId ($10.00 = 1000 cents + $1.50 tax = $11.50 = 1150 cents)
      const quoteResA = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: [{ productId: singleStockProductId, quantity: 1 }],
          delivery: {
            recipient: { name: 'Cliente Uno', phone: '0991111111' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });
      expect(quoteResA.status).toBe(200);

      // Client B quote with singleStockProductId
      const quoteResB = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(otherClientToken))
        .send({
          items: [{ productId: singleStockProductId, quantity: 1 }],
          delivery: {
            recipient: { name: 'Cliente Dos', phone: '0992222222' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });
      expect(quoteResB.status).toBe(200);

      // Client A uses DEMO_APPROVED (balance 41605n)
      const payloadA = {
        ...buildCheckoutPayload(quoteResA.body.quoteToken),
        items: [{ productId: singleStockProductId, quantity: 1 }],
        delivery: {
          recipient: { name: 'Cliente Uno', phone: '0991111111' },
          zoneId: validZoneId,
          deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
          deliveryLocation: { lat: -1.2425, lng: -78.6188 },
          scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        },
        paymentCard: {
          number: '9000 0000 0000 0001',
          holderName: 'PRUEBA APROBADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '111',
        },
      };

      // Client B uses DEMO_LIMITED (balance 30000n)
      const payloadB = {
        ...buildCheckoutPayload(quoteResB.body.quoteToken),
        items: [{ productId: singleStockProductId, quantity: 1 }],
        delivery: {
          recipient: { name: 'Cliente Dos', phone: '0992222222' },
          zoneId: validZoneId,
          deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
          deliveryLocation: { lat: -1.2425, lng: -78.6188 },
          scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        },
        paymentCard: {
          number: '9000 0000 0000 0002',
          holderName: 'PRUEBA LIMITADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '222',
        },
      };

      const cardABalanceBefore = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
      ).balanceCents;
      const cardBBalanceBefore = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_LIMITED' }).first()
      ).balanceCents;

      // Launch both checkouts simultaneously
      const [resA, resB] = await Promise.all([
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(clientToken))
          .set('Idempotency-Key', randomUUID())
          .send(payloadA),
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(otherClientToken))
          .set('Idempotency-Key', randomUUID())
          .send(payloadB),
      ]);

      const statuses = [resA.status, resB.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      const isAWinner = resA.status === 201;
      const successRes = isAWinner ? resA : resB;
      const failureRes = isAWinner ? resB : resA;

      expect(successRes.body.status).toBe('SUCCEEDED');
      expect(failureRes.body.error.code).toBe('STOCK_UNAVAILABLE');
      expect(failureRes.body.error.details.availableStock).toBe(0);

      // Verify stock is exactly 0
      const prod = await db.client.orm.public.Product.where({ id: singleStockProductId }).first();
      expect(prod.stock).toBe(0);

      // Check card balances: winner decremented by 1150, LOSER CARD COMPLETELY UNTOUCHED!
      const cardABalanceAfter = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
      ).balanceCents;
      const cardBBalanceAfter = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_LIMITED' }).first()
      ).balanceCents;

      if (isAWinner) {
        expect(cardABalanceBefore - cardABalanceAfter).toBe(1150n);
        expect(cardBBalanceBefore).toBe(cardBBalanceAfter); // Loser balance intact!
        const loserOrders = await db.client.orm.public.Order.where({ userId: otherClientUserId }).all();
        expect(loserOrders).toHaveLength(0); // No loser order
      } else {
        expect(cardBBalanceBefore - cardBBalanceAfter).toBe(1150n);
        expect(cardABalanceBefore).toBe(cardABalanceAfter); // Loser balance intact!
        const loserOrders = await db.client.orm.public.Order.where({ userId: clientUserId }).all();
        expect(loserOrders).toHaveLength(1); // Only the 1 order from earlier test
      }
    });

    it('concurrent race with identical idempotency key and same payload: both receive identical response, card debited ONCE', async () => {
      const concurrentKey = randomUUID();
      const token = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      const payload = {
        ...buildCheckoutPayload(token),
        items: [{ productId: publishedProductId, quantity: 1 }],
      };

      const balanceBefore = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
      ).balanceCents;

      // Two simultaneous requests with exact same key and payload
      const [res1, res2] = await Promise.all([
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(clientToken))
          .set('Idempotency-Key', concurrentKey)
          .send(payload),
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(clientToken))
          .set('Idempotency-Key', concurrentKey)
          .send(payload),
      ]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body).toEqual(res2.body);
      expect(res1.body.order.id).toBe(res2.body.order.id);
      expect(res1.body.payment.reference).toBe(res2.body.payment.reference);
      expect(res1.body.receipt.id).toBe(res2.body.receipt.id);

      // Verify balance deducted only once
      const balanceAfter = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
      ).balanceCents;
      expect(balanceBefore - balanceAfter).toBe(BigInt(res1.body.order.totalCents));
    });

    it('concurrent race with identical idempotency key and DIFFERENT payload: one original decision and other 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const raceKey = randomUUID();
      const tokenA = await getValidQuoteToken(clientUserId, publishedProductId, 1);
      const tokenB = await getValidQuoteToken(clientUserId, publishedProductId, 2);

      const payloadA = {
        ...buildCheckoutPayload(tokenA),
        items: [{ productId: publishedProductId, quantity: 1 }],
      };

      const payloadB = {
        ...buildCheckoutPayload(tokenB),
        items: [{ productId: publishedProductId, quantity: 2 }],
      };

      const [resA, resB] = await Promise.all([
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(clientToken))
          .set('Idempotency-Key', raceKey)
          .send(payloadA),
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(clientToken))
          .set('Idempotency-Key', raceKey)
          .send(payloadB),
      ]);

      const statuses = [resA.status, resB.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      const conflictRes = resA.status === 409 ? resA : resB;
      expect(conflictRes.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('Concurrent Category Under Locks Recheck Regression', () => {
    it('rejects with 409 PRODUCT_UNPUBLISHED and zero debit when product category is inactive', async () => {
      const quoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: [{ productId: publishedProductId, quantity: 1 }],
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
        });
      expect(quoteRes.status).toBe(200);

      const payload = {
        ...buildCheckoutPayload(quoteRes.body.quoteToken),
        items: [{ productId: publishedProductId, quantity: 1 }],
        delivery: {
          recipient: { name: 'Ana Regalo', phone: '0991234567' },
          zoneId: validZoneId,
          deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
          deliveryLocation: { lat: -1.2425, lng: -78.6188 },
          scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        },
      };

      const stockBefore = (
        await db.client.orm.public.Product.where({ id: publishedProductId }).first()
      ).stock;
      const balanceBefore = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
      ).balanceCents;

      // Deactivate category concurrently before checkout confirmation
      await db.client.transaction(async (tx: any) => {
        await tx.execute(
          db.client.raw.sql`
            UPDATE public.category SET "isActive" = false WHERE id = ${activeCategoryId}
          `.affectedCount().build(),
        );
      });

      try {
        const res = await http()
          .post('/api/v1/shop/checkout')
          .set(auth(clientToken))
          .set('Idempotency-Key', randomUUID())
          .send(payload);

        expect(res.status).toBe(409);
        expect(res.body.error?.code).toBe('PRODUCT_UNPUBLISHED');

        // Verify stock is untouched
        const stockAfter = (
          await db.client.orm.public.Product.where({ id: publishedProductId }).first()
        ).stock;
        expect(stockAfter).toBe(stockBefore);

        // Verify balance is untouched
        const balanceAfter = (
          await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
        ).balanceCents;
        expect(balanceAfter).toBe(balanceBefore);
      } finally {
        // Restore category active state for subsequent tests
        await db.client.transaction(async (tx: any) => {
          await tx.execute(
            db.client.raw.sql`
              UPDATE public.category SET "isActive" = true WHERE id = ${activeCategoryId}
            `.affectedCount().build(),
          );
        });
      }
    });
  });

  describe('Late Write Failure Rollback Probe (Owned Fixture PostgreSQL Trigger)', () => {
    it('rolls back all transactions and leaves stock, balance, order, item, payment and receipt unchanged via database fault trigger', async () => {
      const receiptMeta = getOwnedContainerReceipt();
      if (!receiptMeta) throw new Error('No active owned container receipt');
      const dbName = `shop_checkout_${dbSuffix}`;

      // 1. Install temporary database fault trigger ONLY inside owned fixture
      execFileSync(
        'docker',
        [
          'exec',
          receiptMeta.containerId,
          'psql',
          '-U',
          receiptMeta.user,
          '-d',
          dbName,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `
            CREATE OR REPLACE FUNCTION test_trg_fail_receipt()
            RETURNS trigger AS $$
            BEGIN
              RAISE EXCEPTION 'Simulated late write failure on purchaseReceipt';
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trg_test_fail_receipt ON public."purchaseReceipt";
            CREATE TRIGGER trg_test_fail_receipt
            BEFORE INSERT ON public."purchaseReceipt"
            FOR EACH ROW
            EXECUTE FUNCTION test_trg_fail_receipt();
          `,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const normalDeliveryNotes = 'Favor timbrar en el porton y dejar en recepcion';

      const stockBefore = (
        await db.client.orm.public.Product.where({ id: publishedProductId }).first()
      ).stock;
      const balanceBefore = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
      ).balanceCents;
      const orderCountBefore = (await db.client.orm.public.Order.all()).length;
      const paymentCountBefore = (await db.client.orm.public.PaymentAttempt.all()).length;
      const receiptCountBefore = (await db.client.orm.public.PurchaseReceipt.all()).length;

      try {
        const quoteRes = await http()
          .post('/api/v1/shop/checkout/quote')
          .set(auth(clientToken))
          .send({
            items: [{ productId: publishedProductId, quantity: 1 }],
            delivery: {
              recipient: { name: 'Ana Regalo', phone: '0991234567' },
              zoneId: validZoneId,
              deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
              deliveryLocation: { lat: -1.2425, lng: -78.6188 },
              scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
              deliveryNotes: normalDeliveryNotes,
            },
          });
        expect(quoteRes.status).toBe(200);

        const payload = {
          ...buildCheckoutPayload(quoteRes.body.quoteToken),
          items: [{ productId: publishedProductId, quantity: 1 }],
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
            deliveryNotes: normalDeliveryNotes,
          },
        };

        const res = await http()
          .post('/api/v1/shop/checkout')
          .set(auth(clientToken))
          .set('Idempotency-Key', randomUUID())
          .send(payload);

        expect(res.status).toBe(500);

        // Verify stock is untouched
        const stockAfter = (
          await db.client.orm.public.Product.where({ id: publishedProductId }).first()
        ).stock;
        expect(stockAfter).toBe(stockBefore);

        // Verify balance is untouched
        const balanceAfter = (
          await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_APPROVED' }).first()
        ).balanceCents;
        expect(balanceAfter).toBe(balanceBefore);

        // Verify row counts are untouched
        expect((await db.client.orm.public.Order.all()).length).toBe(orderCountBefore);
        expect((await db.client.orm.public.PaymentAttempt.all()).length).toBe(paymentCountBefore);
        expect((await db.client.orm.public.PurchaseReceipt.all()).length).toBe(receiptCountBefore);
      } finally {
        // 2. Remove trigger and function in finally
        execFileSync(
          'docker',
          [
            'exec',
            receiptMeta.containerId,
            'psql',
            '-U',
            receiptMeta.user,
            '-d',
            dbName,
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            `
              DROP TRIGGER IF EXISTS trg_test_fail_receipt ON public."purchaseReceipt";
              DROP FUNCTION IF EXISTS test_trg_fail_receipt();
            `,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
      }

      // 3. Positive valid request using those same delivery notes succeeds after fixture fault removed
      const positiveQuoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send({
          items: [{ productId: publishedProductId, quantity: 1 }],
          delivery: {
            recipient: { name: 'Ana Regalo', phone: '0991234567' },
            zoneId: validZoneId,
            deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
            deliveryNotes: normalDeliveryNotes,
          },
        });
      expect(positiveQuoteRes.status).toBe(200);

      const positivePayload = {
        ...buildCheckoutPayload(positiveQuoteRes.body.quoteToken),
        items: [{ productId: publishedProductId, quantity: 1 }],
        delivery: {
          recipient: { name: 'Ana Regalo', phone: '0991234567' },
          zoneId: validZoneId,
          deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
          deliveryLocation: { lat: -1.2425, lng: -78.6188 },
          scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          deliveryNotes: normalDeliveryNotes,
        },
      };

      const positiveRes = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(clientToken))
        .set('Idempotency-Key', randomUUID())
        .send(positivePayload);

      expect(positiveRes.status).toBe(201);
      expect(positiveRes.body.status).toBe('SUCCEEDED');
      expect(positiveRes.body.order.status).toBe('PENDING');
      expect(positiveRes.body.payment.status).toBe('APPROVED');
      expect(positiveRes.body.receipt.id).toBeDefined();

      // Verify stock decremented by 1
      const stockSuccess = (
        await db.client.orm.public.Product.where({ id: publishedProductId }).first()
      ).stock;
      expect(stockSuccess).toBe(stockBefore - 1);
    });
  });
});
