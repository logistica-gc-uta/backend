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
import {
  performCheckout,
  seedCatalog,
  seedTestUsers,
  SeededCatalog,
  SeededUsers,
} from './shop-orders-v12.fixtures.js';

jest.setTimeout(240_000);

describe('Shop Orders v1.2 History, Detail & Immutable Receipt E2E (owned PostgreSQL fixture)', () => {
  let app: INestApplication;
  let db: any;
  let ownedContainerId: string | null = null;
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);
  let dbUrl: string;

  let users: SeededUsers;
  let catalog: SeededCatalog;
  let order1: {
    orderId: string;
    receiptId: string;
    commercialOrderNumber: string;
    receiptNumber: string;
    idempotencyKey: string;
    checkoutPayload: any;
  };
  let order2: {
    orderId: string;
    receiptId: string;
    commercialOrderNumber: string;
    receiptNumber: string;
    idempotencyKey: string;
    checkoutPayload: any;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

    const receipt = startOwnedContainer();
    ownedContainerId = receipt.containerId;
    console.log(`[TEST-CONTAINER-RECEIPT] containerId=${receipt.containerId}`);
    dbUrl = createOwnedDatabase(`shop_orders_${dbSuffix}`);
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

    users = await seedTestUsers(db, jwt, dbSuffix);
    catalog = await seedCatalog(db, dbSuffix);

    // Perform two real purchases via public quote -> checkout seam to test pagination & stable ordering
    order1 = await performCheckout(app, db, users, catalog, 2);
    // Slight pause to guarantee distinct createdAt timestamps
    await new Promise((resolve) => setTimeout(resolve, 50));
    order2 = await performCheckout(app, db, users, catalog, 1);
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
    if (ownedContainerId) {
      console.log(`[TEST-CONTAINER-CLEANUP] containerId=${ownedContainerId}`);
    }
  });

  describe('1. Security, Roles & IDOR/BOLA Protection', () => {
    it('returns 401 when anonymous requests /shop/orders, /:id, or /:id/receipt', async () => {
      const listRes = await http().get('/api/v1/shop/orders');
      expect(listRes.status).toBe(401);
      expect(listRes.body.error.code).toBe('UNAUTHENTICATED');

      const detailRes = await http().get(`/api/v1/shop/orders/${order1.orderId}`);
      expect(detailRes.status).toBe(401);
      expect(detailRes.body.error.code).toBe('UNAUTHENTICATED');

      const receiptRes = await http().get(`/api/v1/shop/orders/${order1.orderId}/receipt`);
      expect(receiptRes.status).toBe(401);
      expect(receiptRes.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 401 when invalid JWT is used', async () => {
      const res = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}`)
        .set(auth('invalid-bearer-token'));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 403 when ADMIN attempts to access CLIENT /shop/orders endpoints', async () => {
      const listRes = await http().get('/api/v1/shop/orders').set(auth(users.adminToken));
      expect(listRes.status).toBe(403);
      expect(listRes.body.error.code).toBe('FORBIDDEN');

      const detailRes = await http().get(`/api/v1/shop/orders/${order1.orderId}`).set(auth(users.adminToken));
      expect(detailRes.status).toBe(403);
      expect(detailRes.body.error.code).toBe('FORBIDDEN');

      const receiptRes = await http().get(`/api/v1/shop/orders/${order1.orderId}/receipt`).set(auth(users.adminToken));
      expect(receiptRes.status).toBe(403);
      expect(receiptRes.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 403 when DRIVER attempts to access CLIENT /shop/orders endpoints', async () => {
      const listRes = await http().get('/api/v1/shop/orders').set(auth(users.driverToken));
      expect(listRes.status).toBe(403);
      expect(listRes.body.error.code).toBe('FORBIDDEN');

      const detailRes = await http().get(`/api/v1/shop/orders/${order1.orderId}`).set(auth(users.driverToken));
      expect(detailRes.status).toBe(403);
      expect(detailRes.body.error.code).toBe('FORBIDDEN');

      const receiptRes = await http().get(`/api/v1/shop/orders/${order1.orderId}/receipt`).set(auth(users.driverToken));
      expect(receiptRes.status).toBe(403);
      expect(receiptRes.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 404 ORDER_NOT_FOUND when CLIENT B requests CLIENT A order or receipt (no BOLA leakage)', async () => {
      const detailRes = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}`)
        .set(auth(users.otherClientToken));
      expect(detailRes.status).toBe(404);
      expect(detailRes.body.error.code).toBe('ORDER_NOT_FOUND');

      const receiptRes = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}/receipt`)
        .set(auth(users.otherClientToken));
      expect(receiptRes.status).toBe(404);
      expect(receiptRes.body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('returns identical 404 ORDER_NOT_FOUND for non-existent order UUID', async () => {
      const nonExistent = randomUUID();
      const detailRes = await http()
        .get(`/api/v1/shop/orders/${nonExistent}`)
        .set(auth(users.clientToken));
      expect(detailRes.status).toBe(404);
      expect(detailRes.body.error.code).toBe('ORDER_NOT_FOUND');

      const receiptRes = await http()
        .get(`/api/v1/shop/orders/${nonExistent}/receipt`)
        .set(auth(users.clientToken));
      expect(receiptRes.status).toBe(404);
      expect(receiptRes.body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('returns 400 VALIDATION_ERROR for non-UUID path parameters', async () => {
      const detailRes = await http()
        .get('/api/v1/shop/orders/not-a-valid-uuid')
        .set(auth(users.clientToken));
      expect(detailRes.status).toBe(400);
      expect(detailRes.body.error.code).toBe('VALIDATION_ERROR');

      const receiptRes = await http()
        .get('/api/v1/shop/orders/not-a-valid-uuid/receipt')
        .set(auth(users.clientToken));
      expect(receiptRes.status).toBe(400);
      expect(receiptRes.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR when query userId or unknown fields are injected', async () => {
      const res = await http()
        .get(`/api/v1/shop/orders?userId=${users.otherClientUserId}`)
        .set(auth(users.clientToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('2. Paging, Filter, Status & Stable Ordering', () => {
    it('returns default pagination page=1, pageSize=10 with total >= 2 and stable desc ordering', async () => {
      const res = await http()
        .get('/api/v1/shop/orders')
        .set(auth(users.clientToken));

      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(10);
      expect(res.body.totalPages).toBeGreaterThanOrEqual(1);
      expect(res.body.items.length).toBeGreaterThanOrEqual(2);

      // Verify stable ordering: createdAt desc, id desc (order2 was created after order1)
      const idx2 = res.body.items.findIndex((i: any) => i.id === order2.orderId);
      const idx1 = res.body.items.findIndex((i: any) => i.id === order1.orderId);
      expect(idx2).toBeLessThan(idx1);
    });

    it('supports custom pageSize and page traversal cleanly', async () => {
      const page1Res = await http()
        .get('/api/v1/shop/orders?page=1&pageSize=1')
        .set(auth(users.clientToken));
      expect(page1Res.status).toBe(200);
      expect(page1Res.body.pageSize).toBe(1);
      expect(page1Res.body.items).toHaveLength(1);
      const firstId = page1Res.body.items[0].id;

      const page2Res = await http()
        .get('/api/v1/shop/orders?page=2&pageSize=1')
        .set(auth(users.clientToken));
      expect(page2Res.status).toBe(200);
      expect(page2Res.body.pageSize).toBe(1);
      expect(page2Res.body.items).toHaveLength(1);
      const secondId = page2Res.body.items[0].id;

      expect(firstId).not.toBe(secondId);
    });

    it('returns empty items and valid envelope when page is out of range', async () => {
      const res = await http()
        .get('/api/v1/shop/orders?page=999&pageSize=10')
        .set(auth(users.clientToken));
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.page).toBe(999);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
    });

    it('returns 400 for invalid page (< 1) or invalid pageSize (< 1 or > 50)', async () => {
      const pZero = await http().get('/api/v1/shop/orders?page=0').set(auth(users.clientToken));
      expect(pZero.status).toBe(400);

      const psZero = await http().get('/api/v1/shop/orders?pageSize=0').set(auth(users.clientToken));
      expect(psZero.status).toBe(400);

      const psOver = await http().get('/api/v1/shop/orders?pageSize=51').set(auth(users.clientToken));
      expect(psOver.status).toBe(400);
    });

    it('filters orders by status correctly and rejects invalid status enum', async () => {
      const pendingRes = await http()
        .get('/api/v1/shop/orders?status=PENDING')
        .set(auth(users.clientToken));
      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.items.some((i: any) => i.id === order1.orderId)).toBe(true);

      const cancelledRes = await http()
        .get('/api/v1/shop/orders?status=CANCELLED')
        .set(auth(users.clientToken));
      expect(cancelledRes.status).toBe(200);
      expect(cancelledRes.body.items.some((i: any) => i.id === order1.orderId)).toBe(false);

      const invalidRes = await http()
        .get('/api/v1/shop/orders?status=INVALID_STATUS')
        .set(auth(users.clientToken));
      expect(invalidRes.status).toBe(400);
    });

    it('returns empty items array and total 0 for user with no approved purchases', async () => {
      const res = await http()
        .get('/api/v1/shop/orders')
        .set(auth(users.otherClientToken));
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
      expect(res.body.totalPages).toBe(0);
    });

    it('excludes legacy unpaid orders (without PurchaseReceipt) from list', async () => {
      // Direct SQL seed of an unpaid legacy order belonging to client
      const legacyOrderId = randomUUID();
      await db.client.orm.public.Order.create({
        id: legacyOrderId,
        userId: users.clientUserId,
        zoneId: catalog.zoneId,
        deliveryAddress: 'Direccion Legada 123',
        status: 'PENDING',
        total: 15.0,
      });

      const res = await http()
        .get('/api/v1/shop/orders')
        .set(auth(users.clientToken));

      expect(res.body.items.some((i: any) => i.id === legacyOrderId)).toBe(false);
    });
  });

  describe('3. Operational Lifecycle, Driver Profile & Verified Timeline', () => {
    it('updates timeline with real events via operational routes APIs in verified order', async () => {
      // 1. Initial detail: only real PENDING event
      const initialDetail = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}`)
        .set(auth(users.clientToken));
      expect(initialDetail.status).toBe(200);
      expect(initialDetail.body.timeline).toHaveLength(1);
      expect(initialDetail.body.timeline[0].code).toBe('PENDING');

      // 2. ADMIN creates operational route via public API for both orders
      const createRouteRes = await http()
        .post('/api/v1/routes')
        .set(auth(users.adminToken))
        .send({
          zoneId: catalog.zoneId,
          orderIds: [order1.orderId, order2.orderId],
          routeDate: '2026-11-15T15:00:00Z',
        });
      expect(createRouteRes.status).toBe(201);
      const routeId = createRouteRes.body.id;

      // 3. ADMIN assigns route to actual Driver profile
      const assignRes = await http()
        .post(`/api/v1/routes/${routeId}/assign`)
        .set(auth(users.adminToken))
        .send({
          driverId: users.driverProfileId,
        });
      expect(assignRes.status).toBe(200);

      // Verify ASSIGNED event in client detail timeline for both orders
      const assignedDetail1 = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}`)
        .set(auth(users.clientToken));
      expect(assignedDetail1.body.timeline.map((t: any) => t.code)).toContain('ASSIGNED');

      // 4. DRIVER starts route via public API
      const startRes = await http()
        .post(`/api/v1/routes/${routeId}/start`)
        .set(auth(users.driverToken))
        .set('Content-Type', 'application/json')
        .send({});
      expect(startRes.status).toBe(200);

      // Verify IN_TRANSIT event in client detail timeline
      const startedDetail = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}`)
        .set(auth(users.clientToken));
      expect(startedDetail.body.timeline.map((t: any) => t.code)).toContain('IN_TRANSIT');

      // 5. DRIVER records failed visit on order1 (recipient absent)
      const stop1 = await db.client.orm.public.RouteStop.where({
        routeId,
        orderId: order1.orderId,
      }).first();
      expect(stop1).toBeDefined();

      const failRes = await http()
        .post(`/api/v1/routes/${routeId}/stops/${stop1.id}/failure`)
        .set(auth(users.driverToken))
        .send({
          reason: 'RECIPIENT_ABSENT',
          context: 'No responde en portería tras varios llamados',
          requestId: randomUUID(),
        });
      expect(failRes.status).toBe(200);

      // Verify ATTEMPT_FAILED event in timeline with exact label
      const failDetail = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}`)
        .set(auth(users.clientToken));
      const failEntry = failDetail.body.timeline.find((t: any) => t.code === 'ATTEMPT_FAILED');
      expect(failEntry).toBeDefined();
      expect(failEntry.label).toBe('Intento de entrega fallido: destinatario ausente');

      // 6. DRIVER successfully delivers order2 (IN_TRANSIT -> DELIVERED)
      const inTransitRes2 = await http()
        .patch(`/api/v1/orders/${order2.orderId}/status`)
        .set(auth(users.driverToken))
        .send({
          status: 'IN_TRANSIT',
        });
      expect(inTransitRes2.status).toBe(200);

      const deliverRes2 = await http()
        .patch(`/api/v1/orders/${order2.orderId}/status`)
        .set(auth(users.driverToken))
        .send({
          status: 'DELIVERED',
        });
      expect(deliverRes2.status).toBe(200);

      // 7. Verify chronological timeline containing all distinct real events for order2
      const finalDetail2 = await http()
        .get(`/api/v1/shop/orders/${order2.orderId}`)
        .set(auth(users.clientToken));

      expect(finalDetail2.status).toBe(200);
      expect(finalDetail2.body.status).toBe('DELIVERED');
      const codes2 = finalDetail2.body.timeline.map((t: any) => t.code);
      expect(codes2).toEqual(['PENDING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED']);

      // Strict chronological validation: each timestamp >= preceding timestamp
      for (let i = 1; i < finalDetail2.body.timeline.length; i++) {
        const prev = new Date(finalDetail2.body.timeline[i - 1].at).getTime();
        const curr = new Date(finalDetail2.body.timeline[i].at).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }

      // Verify order1 timeline has PENDING, ASSIGNED, IN_TRANSIT, ATTEMPT_FAILED in chronological order
      const finalDetail1 = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}`)
        .set(auth(users.clientToken));
      const codes1 = finalDetail1.body.timeline.map((t: any) => t.code);
      expect(codes1).toEqual(['PENDING', 'ASSIGNED', 'IN_TRANSIT', 'ATTEMPT_FAILED']);
      for (let i = 1; i < finalDetail1.body.timeline.length; i++) {
        const prev = new Date(finalDetail1.body.timeline[i - 1].at).getTime();
        const curr = new Date(finalDetail1.body.timeline[i].at).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });
  });

  describe('4. Immutable Receipt Projection & Safe Data Handling', () => {
    it('returns sanitized receipt projection with literal disclaimer, zero shipping, and typed tax', async () => {
      const res = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}/receipt`)
        .set(auth(users.clientToken));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(order1.receiptId);
      expect(res.body.number).toBe(order1.receiptNumber);
      expect(res.body.orderId).toBe(order1.orderId);
      expect(res.body.merchantName).toBe('REGALÍA');
      expect(res.body.disclaimer).toBe('COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA');
      expect(res.body.currency).toBe('USD');

      // Safe projection: no PAN, no CVV, no balance, no secrets
      expect(res.body.payment).toEqual({
        status: 'APPROVED',
        reference: expect.stringMatching(/^PAY-DEMO-/),
        cardLast4: '0001',
      });
      expect(res.body.payment.pan).toBeUndefined();
      expect(res.body.payment.cvv).toBeUndefined();
      expect(res.body.payment.balanceCents).toBeUndefined();

      // Recipient phone is not exposed in receipt
      expect(res.body.recipient.phone).toBeUndefined();

      // Tax matches typed contract with ratePercent and HALF_UP calculation
      expect(res.body.tax.mode).toBe('SIMULATED');
      expect(res.body.tax.enabled).toBe(true);
      expect(res.body.tax.rateBps).toBe(1500);
      expect(res.body.tax.ratePercent).toBe(15);
      expect(res.body.shipping).toEqual({
        status: 'FREE_INCLUDED',
        amountCents: 0,
        includedInPrices: true,
      });

      // Total strictly equals subtotal + tax
      expect(res.body.totalCents).toBe(res.body.subtotalCents + res.body.tax.amountCents);
    });

    it('preserves immutable financial and product data even after ADMIN modifies catalog and settings via public routes', async () => {
      // 1. ADMIN updates settings via public endpoint PATCH /api/v1/admin/shop-settings
      const currentAdminSettings = await http()
        .get('/api/v1/admin/shop-settings')
        .set(auth(users.adminToken));
      expect(currentAdminSettings.status).toBe(200);

      const patchSettingsRes = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(users.adminToken))
        .send({
          expectedVersion: currentAdminSettings.body.version,
          tax: {
            rateBps: 1200, // 12%
          },
        });
      expect(patchSettingsRes.status).toBe(200);
      expect(patchSettingsRes.body.tax.rateBps).toBe(1200);
      expect(patchSettingsRes.body.tax.ratePercent).toBe(12);

      // Verify settings persisted in DB
      const updatedSettings = await db.client.orm.public.ShopBusinessSettings.where({ singletonKey: 'GLOBAL' }).first();
      expect(updatedSettings?.taxRateBps).toBe(1200);

      // 2. ADMIN modifies category and product in database
      const newCategoryId = randomUUID();
      await db.client.orm.public.Category.create({
        id: newCategoryId,
        name: 'Categoría Alterada',
        slug: `categoria-alterada-${randomUUID().slice(0, 6)}`,
        isActive: true,
      });

      await db.client.orm.public.Product.where({ id: catalog.productId }).update({
        name: 'PRODUCTO MODIFICADO POR ADMIN',
        sku: 'SKU-MODIFICADO',
        price: 99.99,
        priceCents: 9999n,
        categoryId: newCategoryId,
      });

      // Verify product mutation persisted
      const modifiedProduct = await db.client.orm.public.Product.where({ id: catalog.productId }).first();
      expect(modifiedProduct?.name).toBe('PRODUCTO MODIFICADO POR ADMIN');
      expect(modifiedProduct?.categoryId).toBe(newCategoryId);

      // 3. Detail must still return original frozen name, SKU, and unitPriceCents
      const detailRes = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}`)
        .set(auth(users.clientToken));

      expect(detailRes.body.items[0].name).toBe(catalog.productName);
      expect(detailRes.body.items[0].sku).toBe(catalog.productSku);
      expect(detailRes.body.items[0].unitPriceCents).toBe(3650);
      expect(detailRes.body.items[0].lineTotalCents).toBe(7300);

      // 4. Receipt must still return original frozen amounts and tax rate (15%, not 12%)
      const receiptRes = await http()
        .get(`/api/v1/shop/orders/${order1.orderId}/receipt`)
        .set(auth(users.clientToken));

      expect(receiptRes.body.items[0].name).toBe(catalog.productName);
      expect(receiptRes.body.items[0].unitPriceCents).toBe(3650);
      expect(receiptRes.body.items[0].lineTotalCents).toBe(7300);
      expect(receiptRes.body.subtotalCents).toBe(7300);
      expect(receiptRes.body.totalCents).toBe(8395);
      expect(receiptRes.body.tax.rateBps).toBe(1500);
      expect(receiptRes.body.tax.ratePercent).toBe(15);
      expect(receiptRes.body.tax.amountCents).toBe(1095);
    });

    it('verifies disabled tax (0%) and alternative tax rate with HALF_UP rounding in receipt projection', async () => {
      // 1. Setup product with price that tests HALF_UP: 1055 cents ($10.55)
      // At 12% (1200 bps): 1055 * 1200 / 10000 = 126.6 cents -> HALF_UP = 127 cents
      const halfUpProduct = await db.client.orm.public.Product.create({
        id: randomUUID(),
        name: 'Producto Half Up',
        description: 'Test rounding',
        sku: `SKU-HALFUP-${randomUUID().slice(0, 6)}`,
        price: 10.55,
        priceCents: 1055n,
        stock: 50,
        isPublished: true,
        isFeatured: false,
        categoryId: catalog.categoryId,
      });

      // Settings currently has taxRateBps = 1200 (from previous test)
      const quoteRes12 = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(users.clientToken))
        .send({
          items: [{ productId: halfUpProduct.id, quantity: 1 }],
          delivery: {
            recipient: { name: 'Comprador Test', phone: '0999999999' },
            zoneId: catalog.zoneId,
            deliveryAddress: 'Dirección Test',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
          },
        });
      expect(quoteRes12.status).toBe(200);
      expect(quoteRes12.body.tax.amountCents).toBe(127); // 126.6 -> 127
      expect(quoteRes12.body.totalCents).toBe(1055 + 127); // 1182

      const checkoutRes12 = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(users.clientToken))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ productId: halfUpProduct.id, quantity: 1 }],
          delivery: {
            recipient: { name: 'Comprador Test', phone: '0999999999' },
            zoneId: catalog.zoneId,
            deliveryAddress: 'Dirección Test',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
          },
          quoteToken: quoteRes12.body.quoteToken,
          paymentCard: {
            number: '9000 0000 0000 0001',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
        });
      expect(checkoutRes12.status).toBe(201);
      const order12Id = checkoutRes12.body.order.id;

      // Verify receipt projection for 12% HALF_UP
      const receiptRes12 = await http()
        .get(`/api/v1/shop/orders/${order12Id}/receipt`)
        .set(auth(users.clientToken));
      expect(receiptRes12.status).toBe(200);
      expect(receiptRes12.body.subtotalCents).toBe(1055);
      expect(receiptRes12.body.tax.enabled).toBe(true);
      expect(receiptRes12.body.tax.rateBps).toBe(1200);
      expect(receiptRes12.body.tax.ratePercent).toBe(12);
      expect(receiptRes12.body.tax.amountCents).toBe(127);
      expect(receiptRes12.body.totalCents).toBe(1182);

      // 2. Now ADMIN disables tax (tax.enabled: false)
      const currentSettings = await http()
        .get('/api/v1/admin/shop-settings')
        .set(auth(users.adminToken));

      const disableTaxRes = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(users.adminToken))
        .send({
          expectedVersion: currentSettings.body.version,
          tax: {
            enabled: false,
          },
        });
      expect(disableTaxRes.status).toBe(200);
      expect(disableTaxRes.body.tax.enabled).toBe(false);

      // Checkout with tax disabled
      const quoteResDisabled = await http()
        .post('/api/v1/shop/checkout/quote')
        .set(auth(users.clientToken))
        .send({
          items: [{ productId: halfUpProduct.id, quantity: 1 }],
          delivery: {
            recipient: { name: 'Comprador Test', phone: '0999999999' },
            zoneId: catalog.zoneId,
            deliveryAddress: 'Dirección Test',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
          },
        });
      expect(quoteResDisabled.status).toBe(200);
      expect(quoteResDisabled.body.tax.enabled).toBe(false);
      expect(quoteResDisabled.body.tax.amountCents).toBe(0);
      expect(quoteResDisabled.body.totalCents).toBe(1055);

      const checkoutResDisabled = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(users.clientToken))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ productId: halfUpProduct.id, quantity: 1 }],
          delivery: {
            recipient: { name: 'Comprador Test', phone: '0999999999' },
            zoneId: catalog.zoneId,
            deliveryAddress: 'Dirección Test',
            deliveryLocation: { lat: -1.2425, lng: -78.6188 },
            scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
          },
          quoteToken: quoteResDisabled.body.quoteToken,
          paymentCard: {
            number: '9000 0000 0000 0001',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
        });
      expect(checkoutResDisabled.status).toBe(201);
      const orderDisabledId = checkoutResDisabled.body.order.id;

      // Verify receipt projection for tax disabled: amountCents = 0, enabled = false, total = subtotal
      const receiptResDisabled = await http()
        .get(`/api/v1/shop/orders/${orderDisabledId}/receipt`)
        .set(auth(users.clientToken));
      expect(receiptResDisabled.status).toBe(200);
      expect(receiptResDisabled.body.subtotalCents).toBe(1055);
      expect(receiptResDisabled.body.tax.enabled).toBe(false);
      expect(receiptResDisabled.body.tax.amountCents).toBe(0);
      expect(receiptResDisabled.body.totalCents).toBe(1055);
    });

    it('replaying the same checkout returns the exact same receipt without creating duplicate orders or stock debits', async () => {
      const initialStock = (await db.client.orm.public.Product.where({ id: catalog.productId }).first()).stock;

      const replayRes = await http()
        .post('/api/v1/shop/checkout')
        .set(auth(users.clientToken))
        .set('Idempotency-Key', order1.idempotencyKey)
        .send(order1.checkoutPayload);

      expect(replayRes.status).toBe(201);
      expect(replayRes.body.order.id).toBe(order1.orderId);
      expect(replayRes.body.receipt.id).toBe(order1.receiptId);

      // Verify no extra stock was decremented
      const finalStock = (await db.client.orm.public.Product.where({ id: catalog.productId }).first()).stock;
      expect(finalStock).toBe(initialStock);

      // Verify receipt count in DB remains exactly 1 for this order
      const receipts = await db.client.orm.public.PurchaseReceipt.where({
        orderId: order1.orderId,
      }).all();
      expect(receipts.length).toBe(1);
    });
  });
});
