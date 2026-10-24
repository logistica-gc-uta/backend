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

jest.setTimeout(240_000);

describe('Shop Quote v1.2 HTTP Contract & DB Verification (owned PostgreSQL fixture)', () => {
  let app: INestApplication;
  let db: any;
  let adminToken: string;
  let clientToken: string;
  let otherClientToken: string;
  let otherClientUserId: string;
  let driverToken: string;
  let clientUserId: string;
  let ownedContainerId: string | null = null;
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);
  let dbUrl: string;

  // Test fixture entities
  let activeCategoryId: string;
  let inactiveCategoryId: string;
  let publishedProductId: string; // $36.50 (3650 cents), stock 8
  let outOfStockProductId: string; // $20.00 (2000 cents), stock 0
  let unpublishedProductId: string;
  let inactiveCategoryProductId: string;
  let validZoneId: string;
  let zoneWithoutDepotId: string;
  let nonV4ZoneId: string;
  let nonV4ProductId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  const expectErrorEnvelope = (body: any, expectedCode: string) => {
    expect(body).toEqual({
      error: {
        code: expectedCode,
        message: expect.any(String),
        details: expect.any(Object),
        requestId: expect.any(String),
      },
    });
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/password|credential|postgresql:\/\/|secret/i);
  };

  const getValidQuoteBody = (overrides: Record<string, any> = {}) => ({
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
      scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
      deliveryNotes: 'Entregar en recepcion',
    },
    ...overrides,
  });

  beforeAll(async () => {
    const receipt = startOwnedContainer();
    ownedContainerId = receipt.containerId;
    console.log(`[TEST-CONTAINER-RECEIPT] containerId=${receipt.containerId}`);
    dbUrl = createOwnedDatabase(`shop_quote_${dbSuffix}`);
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

    // 1. Seed users
    for (const role of ['ADMIN', 'CLIENT', 'DRIVER'] as const) {
      const id = randomUUID();
      const email = `${role.toLowerCase()}-${id}@example.test`;
      await db.user.create({
        id,
        name: `Fixture ${role}`,
        email,
        password: 'fixture-password-not-real',
        role,
      });
      const token = jwt.sign({ sub: id, email, role });
      if (role === 'ADMIN') adminToken = token;
      if (role === 'CLIENT') {
        clientToken = token;
        clientUserId = id;
      }
      if (role === 'DRIVER') driverToken = token;
    }

    // Seed second CLIENT for buyer binding tests
    otherClientUserId = randomUUID();
    await db.user.create({
      id: otherClientUserId,
      name: 'Fixture Other Client',
      email: `other-client-${otherClientUserId}@example.test`,
      password: 'fixture-password-not-real',
      role: 'CLIENT',
    });
    otherClientToken = jwt.sign({ sub: otherClientUserId, email: `other-client-${otherClientUserId}@example.test`, role: 'CLIENT' });

    // 2. Seed Zones
    validZoneId = randomUUID();
    await db.zone.create({
      id: validZoneId,
      name: 'Zona Centro Ambato',
      code: `AMB-${dbSuffix.slice(0, 4)}`,
      depotLat: -1.242,
      depotLng: -78.618,
    });

    zoneWithoutDepotId = randomUUID();
    await db.zone.create({
      id: zoneWithoutDepotId,
      name: 'Zona Sin Deposito',
      code: `NODEP-${dbSuffix.slice(0, 4)}`,
      depotLat: null,
      depotLng: null,
    });

    nonV4ZoneId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    await db.zone.create({
      id: nonV4ZoneId,
      name: 'Zona Non-v4 Ambato',
      code: `NV4-${dbSuffix.slice(0, 4)}`,
      depotLat: -1.242,
      depotLng: -78.618,
    });

    // 3. Seed Categories
    activeCategoryId = randomUUID();
    await db.category.create({
      id: activeCategoryId,
      name: 'Navidad 2026',
      slug: `navidad-${dbSuffix}`,
      description: 'Regalos navideños',
      isActive: true,
      sortOrder: 1,
    });

    inactiveCategoryId = randomUUID();
    await db.category.create({
      id: inactiveCategoryId,
      name: 'Temporada Pasada',
      slug: `pasada-${dbSuffix}`,
      description: 'Categoría inactiva',
      isActive: false,
      sortOrder: 2,
    });

    // 4. Seed Products
    publishedProductId = randomUUID();
    await db.product.create({
      id: publishedProductId,
      name: 'Caja sorpresa navideña',
      description: 'Hermosa caja de regalos navideños con dulces y tarjeta',
      price: 36.5,
      priceCents: 3650n,
      sku: `REG-NAV-${dbSuffix.slice(0, 6)}`,
      categoryId: activeCategoryId,
      isPublished: true,
      isFeatured: true,
      stock: 8,
    });

    outOfStockProductId = randomUUID();
    await db.product.create({
      id: outOfStockProductId,
      name: 'Producto Agotado',
      description: 'Producto sin existencias para probar disponibilidad',
      price: 20.0,
      priceCents: 2000n,
      sku: `REG-OUT-${dbSuffix.slice(0, 6)}`,
      categoryId: activeCategoryId,
      isPublished: true,
      isFeatured: false,
      stock: 0,
    });

    unpublishedProductId = randomUUID();
    await db.product.create({
      id: unpublishedProductId,
      name: 'Borrador No Publicado',
      description: 'Producto borrador no publicado',
      price: 15.0,
      priceCents: 1500n,
      sku: `REG-UNP-${dbSuffix.slice(0, 6)}`,
      categoryId: activeCategoryId,
      isPublished: false,
      stock: 5,
    });

    inactiveCategoryProductId = randomUUID();
    await db.product.create({
      id: inactiveCategoryProductId,
      name: 'Producto Categoria Inactiva',
      description: 'Producto con categoría inactiva',
      price: 25.0,
      priceCents: 2500n,
      sku: `REG-INA-${dbSuffix.slice(0, 6)}`,
      categoryId: inactiveCategoryId,
      isPublished: true,
      stock: 10,
    });

    nonV4ProductId = '886313e1-3b8a-5372-9b90-0c9aee199e5d';
    await db.product.create({
      id: nonV4ProductId,
      name: 'Producto Non-v4 UUID',
      description: 'Producto para validar soporte de UUID no v4',
      price: 10.0,
      priceCents: 1000n,
      sku: `NV4-PRD-${dbSuffix.slice(0, 6)}`,
      categoryId: activeCategoryId,
      isPublished: true,
      stock: 5,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
    if (ownedContainerId) {
      console.log(`[TEST-CONTAINER-CLEANUP] containerId=${ownedContainerId}`);
    }
  });

  describe('1. Authentication & Role-Based Access Control', () => {
    it('rejects anonymous caller with 401 UNAUTHENTICATED', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .send(getValidQuoteBody())
        .expect(401);

      expectErrorEnvelope(res.body, 'UNAUTHENTICATED');
    });

    it('rejects ADMIN role with 403 FORBIDDEN', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(adminToken))
        .send(getValidQuoteBody())
        .expect(403);

      expectErrorEnvelope(res.body, 'FORBIDDEN');
    });

    it('rejects DRIVER role with 403 FORBIDDEN', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(driverToken))
        .send(getValidQuoteBody())
        .expect(403);

      expectErrorEnvelope(res.body, 'FORBIDDEN');
    });

    it('allows CLIENT role to quote successfully (200 OK)', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(getValidQuoteBody())
        .expect(200);

      expect(res.body.currency).toBe('USD');
      expect(res.body.quoteToken).toMatch(/^qtk_v1\..+\..+$/);
    });

    it('allows another authenticated CLIENT to quote with distinct token ownership', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(otherClientToken))
        .send(getValidQuoteBody())
        .expect(200);

      expect(res.body.currency).toBe('USD');
      expect(res.body.quoteToken).toMatch(/^qtk_v1\..+\..+$/);
      // Decoded token payload verifies otherClientUserId
      const payloadBase64 = res.body.quoteToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf-8'));
      expect(payload.buyerUserId).toBe(otherClientUserId);
      expect(payload.buyerUserId).not.toBe(clientUserId);
    });

    it('pins absence of quoteToken as an authentication bearer JWT', async () => {
      const quoteRes = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(getValidQuoteBody())
        .expect(200);

      const quoteToken = quoteRes.body.quoteToken;

      // Attempting to access protected endpoints with quoteToken as bearer must fail with 401
      const myOrdersRes = await http()
        .get('/api/v1/orders/my-orders')
        .set('Authorization', `Bearer ${quoteToken}`)
        .expect(401);

      expect(myOrdersRes.status).toBe(401);
    });
  });

  describe('2. Mandatory Authority Money & Response Contract', () => {
    it('covers the exact authoritative example: $73.00 subtotal + 15% IVA ($10.95) + $0 free shipping = $83.95 total', async () => {
      // 2 units * $36.50 (3650 cents) = $73.00 (7300 cents)
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(getValidQuoteBody())
        .expect(200);

      expect(res.body).toEqual({
        currency: 'USD',
        items: [
          {
            productId: publishedProductId,
            name: 'Caja sorpresa navideña',
            quantity: 2,
            unitPriceCents: 3650,
            lineTotalCents: 7300,
            availableStock: 8,
            available: true,
          },
        ],
        subtotalCents: 7300,
        shipping: {
          status: 'FREE_INCLUDED',
          amountCents: 0,
          includedInPrices: true,
        },
        tax: {
          mode: 'SIMULATED',
          enabled: true,
          rateBps: 1500,
          ratePercent: 15,
          amountCents: 1095,
        },
        totalCents: 8395,
        settingsVersion: 1,
        validUntil: expect.any(String),
        quoteToken: expect.stringMatching(/^qtk_v1\..+\..+$/),
      });

      // Assert validUntil is ~15 minutes in the future
      const validUntilDate = new Date(res.body.validUntil);
      const diffMs = validUntilDate.getTime() - Date.now();
      expect(diffMs).toBeGreaterThan(14 * 60 * 1000);
      expect(diffMs).toBeLessThanOrEqual(16 * 60 * 1000);
    });

    it('reports availability: false when product is out of stock without rejecting the quote', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            items: [
              {
                productId: outOfStockProductId,
                quantity: 1,
              },
            ],
          }),
        )
        .expect(200);

      expect(res.body.items[0]).toEqual({
        productId: outOfStockProductId,
        name: 'Producto Agotado',
        quantity: 1,
        unitPriceCents: 2000,
        lineTotalCents: 2000,
        availableStock: 0,
        available: false,
      });
      expect(res.body.subtotalCents).toBe(2000);
      expect(res.body.tax.amountCents).toBe(300); // 2000 * 15% = 300
      expect(res.body.totalCents).toBe(2300);
    });
  });

  describe('3. Duplicate Consolidation and Dynamic SKU Limits', () => {
    it('consolidates repeated SKU lines (6+5=11) and rejects exceeding limit (10) with 422 QUANTITY_LIMIT_EXCEEDED', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            items: [
              { productId: publishedProductId, quantity: 6 },
              { productId: publishedProductId, quantity: 5 },
            ],
          }),
        )
        .expect(422);

      expectErrorEnvelope(res.body, 'QUANTITY_LIMIT_EXCEEDED');
      expect(res.body.error.details).toEqual({
        productId: publishedProductId,
        requestedQuantity: 11,
        maximumAllowed: 10,
      });
    });

    it('accepts boundary consolidated quantity equal to the configured limit (10 units)', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            items: [
              { productId: publishedProductId, quantity: 6 },
              { productId: publishedProductId, quantity: 4 },
            ],
          }),
        )
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].quantity).toBe(10);
      expect(res.body.items[0].lineTotalCents).toBe(36500);
    });
  });

  describe('4. Strict Nested DTO Validation (null != absence & extra fields)', () => {
    it('rejects unknown/forbidden property with 400 VALIDATION_ERROR', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(getValidQuoteBody({ totalCents: 8395 }))
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects explicit null delivery object with 400 VALIDATION_ERROR', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(getValidQuoteBody({ delivery: null }))
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects explicit null recipient with 400 VALIDATION_ERROR', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              recipient: null,
            },
          }),
        )
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects explicit null coordinates with 400 VALIDATION_ERROR', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              deliveryLocation: { lat: null, lng: -78.6188 },
            },
          }),
        )
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects explicit null deliveryNotes (null != absence) with 400 VALIDATION_ERROR', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              deliveryNotes: null,
            },
          }),
        )
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects scheduledDeliveryDate without explicit offset with 400 VALIDATION_ERROR', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              scheduledDeliveryDate: '2026-11-15T10:00:00', // Missing timezone offset
            },
          }),
        )
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects empty items array with 400 VALIDATION_ERROR', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(getValidQuoteBody({ items: [] }))
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    test.each([
      {
        field: 'recipient name whitespace-only',
        buildBody: () => ({
          delivery: {
            ...getValidQuoteBody().delivery,
            recipient: { name: '   ', phone: '0991234567' },
          },
        }),
      },
      {
        field: 'recipient phone whitespace-only',
        buildBody: () => ({
          delivery: {
            ...getValidQuoteBody().delivery,
            recipient: { name: 'Ana Regalo', phone: '       ' },
          },
        }),
      },
      {
        field: 'recipient phone padded passes 7 raw but trims to 5',
        buildBody: () => ({
          delivery: {
            ...getValidQuoteBody().delivery,
            recipient: { name: 'Ana Regalo', phone: ' 12345 ' },
          },
        }),
      },
      {
        field: 'deliveryAddress whitespace-only',
        buildBody: () => ({
          delivery: {
            ...getValidQuoteBody().delivery,
            deliveryAddress: '     ',
          },
        }),
      },
      {
        field: 'recipient name non-string type guard',
        buildBody: () => ({
          delivery: {
            ...getValidQuoteBody().delivery,
            recipient: { name: 12345, phone: '0991234567' },
          },
        }),
      },
      {
        field: 'deliveryNotes non-string type guard',
        buildBody: () => ({
          delivery: {
            ...getValidQuoteBody().delivery,
            deliveryNotes: 12345,
          },
        }),
      },
    ])('rejects $field with 400 VALIDATION_ERROR', async ({ buildBody }) => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(getValidQuoteBody(buildBody()))
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('normalizes valid padded strings into signed delivery token payload and accepts request', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              recipient: {
                name: '  Ana Regalo Padded  ',
                phone: '  0991234567  ',
              },
              deliveryAddress: '  Av. Cevallos y Montalvo, Ambato  ',
              deliveryNotes: '  Por favor tocar el timbre  ',
            },
          }),
        )
        .expect(200);

      const payloadBase64 = res.body.quoteToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf-8'));
      expect(payload.delivery.recipient.name).toBe('Ana Regalo Padded');
      expect(payload.delivery.recipient.phone).toBe('0991234567');
      expect(payload.delivery.deliveryAddress).toBe('Av. Cevallos y Montalvo, Ambato');
      expect(payload.delivery.deliveryNotes).toBe('Por favor tocar el timbre');
    });

    it('accepts valid non-v4 UUID fixtures for product and zone through public quote', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            items: [{ productId: nonV4ProductId, quantity: 1 }],
            delivery: {
              ...getValidQuoteBody().delivery,
              zoneId: nonV4ZoneId,
            },
          }),
        )
        .expect(200);

      expect(res.body.currency).toBe('USD');
      expect(res.body.items[0].productId).toBe(nonV4ProductId);
    });

    it('normalizes scheduledDeliveryDate in signed token payload to UTC instant string', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
            },
          }),
        )
        .expect(200);

      const payloadBase64 = res.body.quoteToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf-8'));
      expect(payload.delivery.scheduledDeliveryDate).toBe('2026-11-15T15:00:00Z');
    });
  });

  describe('5. Delivery Scheduling and Business Hours (America/Guayaquil)', () => {
    it('rejects scheduled delivery date in the past with 422 DELIVERY_INVALID', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              scheduledDeliveryDate: '2020-01-01T10:00:00-05:00',
            },
          }),
        )
        .expect(422);

      expectErrorEnvelope(res.body, 'DELIVERY_INVALID');
    });

    it('rejects delivery at 06:59 local time with 422 DELIVERY_OUTSIDE_HOURS', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              scheduledDeliveryDate: '2026-11-15T06:59:00-05:00',
            },
          }),
        )
        .expect(422);

      expectErrorEnvelope(res.body, 'DELIVERY_OUTSIDE_HOURS');
      expect(res.body.error.details).toEqual({
        startTime: '07:00',
        endTime: '17:00',
        timeZone: 'America/Guayaquil',
        requestedTime: '06:59',
      });
    });

    it('rejects delivery at 17:01 local time with 422 DELIVERY_OUTSIDE_HOURS', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              scheduledDeliveryDate: '2026-11-15T17:01:00-05:00',
            },
          }),
        )
        .expect(422);

      expectErrorEnvelope(res.body, 'DELIVERY_OUTSIDE_HOURS');
    });

    it('accepts inclusive boundary times 07:00 and 17:00 local time', async () => {
      await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              scheduledDeliveryDate: '2026-11-15T07:00:00-05:00',
            },
          }),
        )
        .expect(200);

      await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              scheduledDeliveryDate: '2026-11-15T17:00:00-05:00',
            },
          }),
        )
        .expect(200);
    });
  });

  describe('6. Geographic and Zone Validation', () => {
    it('rejects non-existent zoneId with 404 ZONE_NOT_FOUND', async () => {
      const fakeZoneId = randomUUID();
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              zoneId: fakeZoneId,
            },
          }),
        )
        .expect(404);

      expectErrorEnvelope(res.body, 'ZONE_NOT_FOUND');
      expect(res.body.error.details).toEqual({ zoneId: fakeZoneId });
    });

    it('rejects zone without configured depot with 422 DELIVERY_INVALID', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            delivery: {
              ...getValidQuoteBody().delivery,
              zoneId: zoneWithoutDepotId,
            },
          }),
        )
        .expect(422);

      expectErrorEnvelope(res.body, 'DELIVERY_INVALID');
    });
  });

  describe('7. Catalog and Publication State Validation', () => {
    it('rejects non-existent productId with 404 PRODUCT_NOT_FOUND', async () => {
      const fakeProductId = randomUUID();
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            items: [{ productId: fakeProductId, quantity: 1 }],
          }),
        )
        .expect(404);

      expectErrorEnvelope(res.body, 'PRODUCT_NOT_FOUND');
      expect(res.body.error.details).toEqual({ productId: fakeProductId });
    });

    it('rejects unpublished product with 409 PRODUCT_UNPUBLISHED', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            items: [{ productId: unpublishedProductId, quantity: 1 }],
          }),
        )
        .expect(409);

      expectErrorEnvelope(res.body, 'PRODUCT_UNPUBLISHED');
      expect(res.body.error.details).toEqual({ productId: unpublishedProductId });
    });

    it('rejects product with inactive category with 409 PRODUCT_UNPUBLISHED', async () => {
      const res = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(
          getValidQuoteBody({
            items: [{ productId: inactiveCategoryProductId, quantity: 1 }],
          }),
        )
        .expect(409);

      expectErrorEnvelope(res.body, 'PRODUCT_UNPUBLISHED');
      expect(res.body.error.details).toEqual({ productId: inactiveCategoryProductId });
    });
  });

  describe('8. Immutability & Safety (stock and settings remain untouched)', () => {
    it('verifies stock, settings version, and audit trail are completely untouched by quote execution', async () => {
      const prodBefore = await db.client.orm.public.Product.where({ id: publishedProductId }).first();
      const settingsBefore = await db.client.orm.public.ShopBusinessSettings.first();
      const auditCountBefore = (await db.client.orm.public.ShopSettingsAudit.all()).length;

      // Execute quote
      await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(getValidQuoteBody())
        .expect(200);

      // Execute rejected quote
      await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(clientToken))
        .send(getValidQuoteBody({ items: [{ productId: publishedProductId, quantity: 20 }] }))
        .expect(422);

      const prodAfter = await db.client.orm.public.Product.where({ id: publishedProductId }).first();
      const settingsAfter = await db.client.orm.public.ShopBusinessSettings.first();
      const auditCountAfter = (await db.client.orm.public.ShopSettingsAudit.all()).length;

      expect(prodAfter.stock).toBe(prodBefore.stock);
      expect(settingsAfter.version).toBe(settingsBefore.version);
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  describe('9. Regressions: Existing Settings & Published Catalog', () => {
    it('verifies GET /api/v1/shop/settings remains operational and unchanged', async () => {
      const res = await http().get('/api/v1/shop/settings').expect(200);
      expect(res.body).toEqual({
        version: 1,
        currency: 'USD',
        shipping: {
          status: 'FREE_INCLUDED',
          amountCents: 0,
          includedInPrices: true,
        },
        tax: {
          mode: 'SIMULATED',
          enabled: true,
          rateBps: 1500,
          ratePercent: 15,
        },
        limits: {
          maxUnitsPerSkuPerOrder: 10,
        },
        deliverySchedule: {
          timeZone: 'America/Guayaquil',
          startTime: '07:00',
          endTime: '17:00',
          boundariesInclusive: true,
        },
        updatedAt: expect.any(String),
      });
    });

    it('verifies GET /api/v1/products legacy catalog remains operational', async () => {
      const res = await http().get('/api/v1/products').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      // All returned legacy products must have stock > 0
      for (const prod of res.body) {
        expect(prod.stock).toBeGreaterThan(0);
      }
    });
  });
});
