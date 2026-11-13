import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from '../src/prisma/contract.d';
import contractJson from '../src/prisma/contract.json' with { type: 'json' };
import {
  startOwnedContainer,
  createOwnedDatabase,
  runPrismaMigrate,
  cleanupOwnedResources,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(240000);

/**
 * Issue #51: emergency route interruption, individual unit recovery, independent driver return/release,
 * and integration with #50 (store pickup), #52 (loss/replacement/LOSS_CANCEL), and #44 (driver absences)
 * against owned PostgreSQL 16 and real JWT HTTP endpoints.
 */
describe('Route emergency interruption and unit recovery (#51): PostgreSQL + JWT HTTP', () => {
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const ids = {
    admin: randomUUID(),
    admin2: randomUUID(),
    client: randomUUID(),
    otherClient: randomUUID(),
    driverUser: randomUUID(),
    driver: randomUUID(),
    driverUser2: randomUUID(),
    driver2: randomUUID(),
    zone: randomUUID(),
  };

  const token = (sub: string, role: string) =>
    jwt.sign({ sub, role, email: `${sub}@fixture.invalid` });

  const api = (
    method: 'get' | 'post' | 'patch',
    path: string,
    body?: object,
    sub = ids.admin,
    role = 'ADMIN',
  ) =>
    request(app.getHttpServer())[method]('/api/v1' + path).auth(token(sub, role), { type: 'bearer' }).send(body);

  const intervene = (
    body: Record<string, unknown>,
    sub = ids.admin,
    role = 'ADMIN',
  ) =>
    api(
      'post',
      '/dispatch/interventions',
      { requestId: randomUUID(), reason: 'Operational route emergency', ...body },
      sub,
      role,
    );

  const now = () => Temporal.Now.instant();
  const guayaquilDay = (offsetDays = 0) =>
    Temporal.Now.zonedDateTimeISO('America/Guayaquil')
      .toPlainDate()
      .add({ days: offsetDays })
      .toString();

  const seedProduct = (stock: number, price = 10) =>
    db.orm.public.Product.create({
      name: 'Bouquet ' + randomUUID().slice(0, 8),
      price,
      stock,
    });

  const seedOrder = async (
    items: Array<{ productId: string; quantity: number; price?: number }>,
    scheduledDeliveryDate = now(),
    withReceiptAndPayment = false,
  ) => {
    const total = items.reduce((sum, item) => sum + item.quantity * (item.price ?? 10), 0);
    const totalCents = BigInt(Math.round(total * 100));
    const order = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      deliveryAddress: 'Fixture Avenue 123',
      scheduledDeliveryDate,
      deliveryLat: -1.25,
      deliveryLng: -78.62,
      total,
      subtotalCents: totalCents,
    });
    const createdItems = [];
    for (const entry of items) {
      const unitPrice = entry.price ?? 10;
      const item = await db.orm.public.OrderItem.create({
        orderId: order.id,
        productId: entry.productId,
        quantity: entry.quantity,
        price: unitPrice,
        unitPriceCents: BigInt(Math.round(unitPrice * 100)),
      });
      createdItems.push(item);
    }
    if (withReceiptAndPayment) {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      await db.orm.public.PurchaseReceipt.create({
        orderId: order.id,
        number: `REC-${suffix}`,
        commercialOrderNumber: `ORD-${suffix}`,
        buyerId: ids.client,
        subtotalCents: totalCents,
        taxEnabled: false,
        taxRateBps: 0,
        taxAmountCents: 0n,
        totalCents,
        snapshot: { orderId: order.id },
      });
      await db.orm.public.PaymentAttempt.create({
        orderId: order.id,
        buyerId: ids.client,
        cardFixtureId: 'card-1',
        subtotalCents: totalCents,
        taxEnabled: false,
        taxRateBps: 0,
        taxAmountCents: 0n,
        totalCents,
        amountCents: totalCents,
        cardLast4: '4242',
        reference: `PAY-${suffix}`,
      });
    }
    return { order, items: createdItems };
  };

  const createAndStartRoute = async (
    orderIds: string[],
    driverId = ids.driver,
    driverUserId = ids.driverUser,
  ) => {
    const route = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: now().toString(),
        orderIds,
      }).expect(201)
    ).body;
    await api('post', `/routes/${route.id}/assign`, { driverId }).expect(200);
    await api('post', `/routes/${route.id}/start`, {}, driverUserId, 'DRIVER').expect(200);
    const detail = (await api('get', `/routes/${route.id}`).expect(200)).body;
    return { route, detail };
  };

  const expectSqlState = async (operation: Promise<unknown>, expected = '23514') => {
    let caught: unknown;
    try {
      await operation;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const states: string[] = [];
    let current: unknown = caught;
    for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
      const record = current as { sqlState?: unknown; code?: unknown; cause?: unknown };
      if (typeof record.sqlState === 'string') states.push(record.sqlState);
      if (typeof record.code === 'string') states.push(record.code);
      current = record.cause;
    }
    expect(states).toContain(expected);
  };

  beforeAll(async () => {
    startOwnedContainer();
    const dbName = 'emerg_' + randomUUID().replaceAll('-', '').slice(0, 8);
    const url = createOwnedDatabase(dbName);
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    db = postgres<Contract>({ contractJson, url });

    for (const [id, role] of [
      [ids.admin, 'ADMIN'],
      [ids.admin2, 'ADMIN'],
      [ids.client, 'CLIENT'],
      [ids.otherClient, 'CLIENT'],
      [ids.driverUser, 'DRIVER'],
      [ids.driverUser2, 'DRIVER'],
    ] as const) {
      await db.orm.public.User.create({
        id,
        role,
        name: role,
        email: `${id}@fixture.invalid`,
        password: 'not-a-real-password',
      });
    }
    await db.orm.public.Driver.create({
      id: ids.driver,
      userId: ids.driverUser,
      vehicle: 'Van 1',
      isAvailable: true,
    });
    await db.orm.public.Driver.create({
      id: ids.driver2,
      userId: ids.driverUser2,
      vehicle: 'Van 2',
      isAvailable: true,
    });
    await db.orm.public.Zone.create({
      id: ids.zone,
      code: ids.zone,
      name: 'Central Zone',
      depotLat: -1.24,
      depotLng: -78.61,
    });
    await db.orm.public.SimulatedCard.create({
      fixtureId: 'card-1',
      last4: '4242',
      active: true,
      balanceCents: 500000n,
    });

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const prisma = {
      client: db,
      orm: db.orm,
      sql: db.sql,
      user: db.orm.public.User,
      driver: db.orm.public.Driver,
      zone: db.orm.public.Zone,
      storeCoverage: db.orm.public.StoreCoverage,
      product: db.orm.public.Product,
      category: db.orm.public.Category,
      productImage: db.orm.public.ProductImage,
      uploadedAsset: db.orm.public.UploadedAsset,
      order: db.orm.public.Order,
      orderItem: db.orm.public.OrderItem,
      route: db.orm.public.Route,
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    cleanupOwnedResources();
  });

  describe('S1 & S7 — Emergency declaration, preserved completed stops, detached pending stops, and guards', () => {
    it('declares emergency on IN_PROGRESS route, preserves SUCCESSFUL and FAILED stops, releases claims, detaches pending orders, and blocks driver mutations', async () => {
      const productA = await seedProduct(10, 12);
      const productB = await seedProduct(10, 15);
      const o1 = await seedOrder([{ productId: productA.id, quantity: 1, price: 12 }]);
      const o2 = await seedOrder([{ productId: productA.id, quantity: 1, price: 12 }]);
      const o3 = await seedOrder([
        { productId: productA.id, quantity: 2, price: 12 },
        { productId: productB.id, quantity: 1, price: 15 },
      ]);
      const o4 = await seedOrder([{ productId: productB.id, quantity: 1, price: 15 }]);

      const { route, detail } = await createAndStartRoute([
        o1.order.id,
        o2.order.id,
        o3.order.id,
        o4.order.id,
      ]);
      const stop1 = detail.stops[0];
      const stop2 = detail.stops[1];
      const stop3 = detail.stops[2];

      // Stop 1 delivered (SUCCESSFUL)
      await api('patch', `/orders/${o1.order.id}/status`, { status: 'IN_TRANSIT' }, ids.driverUser, 'DRIVER').expect(200);
      await api('patch', `/orders/${o1.order.id}/status`, { status: 'DELIVERED' }, ids.driverUser, 'DRIVER').expect(200);

      // Stop 2 failed (FAILED)
      await api(
        'post',
        `/routes/${route.id}/stops/${stop2.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Nobody answered bell' },
        ids.driverUser,
        'DRIVER',
      ).expect(200);

      // Stop 3 in transit (still PENDING stop)
      await api('patch', `/orders/${o3.order.id}/status`, { status: 'IN_TRANSIT' }, ids.driverUser, 'DRIVER').expect(200);

      // Authorization checks: DRIVER, CLIENT, unauthenticated, and body actorId must fail cleanly.
      const forbiddenBody = {
        requestId: randomUUID(),
        action: 'EMERGENCY_DECLARE',
        routeId: route.id,
        reason: 'Mechanical failure',
      };
      await api('post', '/dispatch/interventions', forbiddenBody, ids.driverUser, 'DRIVER').expect(403);
      await api('post', '/dispatch/interventions', forbiddenBody, ids.client, 'CLIENT').expect(403);
      await request(app.getHttpServer()).post('/api/v1/dispatch/interventions').send(forbiddenBody).expect(401);
      await api('post', '/dispatch/interventions', { ...forbiddenBody, actorId: ids.admin2 }).expect(400);

      const declareBody = {
        requestId: randomUUID(),
        action: 'EMERGENCY_DECLARE',
        routeId: route.id,
        reason: 'Vehicle transmission failure',
      };
      const declared = await api('post', '/dispatch/interventions', declareBody, ids.admin).expect(200);
      expect(declared.body).toMatchObject({
        action: 'EMERGENCY_DECLARE',
        outcome: 'APPLIED',
        actorId: ids.admin,
        routeId: route.id,
        orderId: null,
      });
      const emergencyId = declared.body.result.emergencyId as string;
      expect(declared.body.result).toMatchObject({
        emergencyId,
        routeId: route.id,
        unitRecoveryCount: 4,
      });
      expect([...(declared.body.result.detachedOrderIds as string[])].sort((a, b) => a.localeCompare(b))).toEqual(
        [o3.order.id, o4.order.id].sort((a, b) => a.localeCompare(b)),
      );
      expect(
        [...(declared.body.result.preservedCompletedStopIds as string[])].sort((a, b) => a.localeCompare(b)),
      ).toEqual([stop1.id, stop2.id].sort((a, b) => a.localeCompare(b)));

      // Idempotent replay with same requestId + actor + body returns identical 200; actor/payload conflict returns 409.
      const replay = await api('post', '/dispatch/interventions', declareBody, ids.admin).expect(200);
      expect(replay.body).toEqual(declared.body);
      await api('post', '/dispatch/interventions', declareBody, ids.admin2).expect(409);
      await api('post', '/dispatch/interventions', { ...declareBody, reason: 'Changed reason' }, ids.admin).expect(409);

      // Duplicate EMERGENCY_DECLARE with new requestId rejects with 409 EMERGENCY_ALREADY_DECLARED.
      const dup = await intervene({ action: 'EMERGENCY_DECLARE', routeId: route.id }).expect(409);
      expect(dup.body.code).toBe('EMERGENCY_ALREADY_DECLARED');

      // Persisted state checks in PostgreSQL.
      const persistedRoute = await db.orm.public.Route.where({ id: route.id }).first();
      expect(persistedRoute).toMatchObject({ status: 'INTERRUPTED', completedAt: null, returnedAt: null });

      const emergencyRow = await db.orm.public.RouteEmergency.where({ routeId: route.id }).first();
      expect(emergencyRow).toMatchObject({
        id: emergencyId,
        routeId: route.id,
        declaredById: ids.admin,
        closedAt: null,
      });

      // Completed stops & attempts preserved; all claims on route released at declaredAt.
      const persistedStops = await db.orm.public.RouteStop.where({ routeId: route.id }).all();
      expect(persistedStops.find((s) => s.id === stop1.id)?.outcome).toBe('SUCCESSFUL');
      expect(persistedStops.find((s) => s.id === stop2.id)?.outcome).toBe('FAILED');
      expect(await db.orm.public.DeliveryAttempt.where({ stopId: stop1.id }).all()).toHaveLength(1);
      expect(await db.orm.public.DeliveryAttempt.where({ stopId: stop2.id }).all()).toHaveLength(1);

      const claims = await db.orm.public.OrderClaim.where({ routeId: route.id }).all();
      expect(claims).toHaveLength(4);
      expect(claims.every((c) => c.releasedAt?.toString() === emergencyRow!.declaredAt.toString())).toBe(true);

      // Completed order 1 stays DELIVERED; failed order 2 stays ASSIGNED with requiresAdministrativeReview = true.
      expect(await db.orm.public.Order.where({ id: o1.order.id }).first()).toMatchObject({
        status: 'DELIVERED',
        routeId: route.id,
        requiresAdministrativeReview: false,
      });
      expect(await db.orm.public.Order.where({ id: o2.order.id }).first()).toMatchObject({
        status: 'ASSIGNED',
        routeId: route.id,
        requiresAdministrativeReview: true,
      });

      // Pending orders 3 & 4 detached to PENDING with requiresAdministrativeReview = true.
      for (const pendingId of [o3.order.id, o4.order.id]) {
        expect(await db.orm.public.Order.where({ id: pendingId }).first()).toMatchObject({
          status: 'PENDING',
          routeId: null,
          stopOrder: null,
          requiresAdministrativeReview: true,
        });
      }

      // Exact RouteUnitRecovery rows created per (orderItemId, unitNumber).
      const recoveries = await db.orm.public.RouteUnitRecovery.where({ emergencyId }).all();
      expect(recoveries).toHaveLength(4);
      const unitKeys = recoveries
        .map((u) => `${u.orderItemId}:${u.unitNumber}`)
        .sort((a, b) => a.localeCompare(b));
      const expectedKeys = [
        `${o3.items[0]!.id}:1`,
        `${o3.items[0]!.id}:2`,
        `${o3.items[1]!.id}:1`,
        `${o4.items[0]!.id}:1`,
      ].sort((a, b) => a.localeCompare(b));
      expect(unitKeys).toEqual(expectedKeys);

      // Query endpoints (S7): GET /dispatch/emergencies, GET /dispatch/routes/:id/emergency, GET /dispatch/inbox, GET /routes/:id.
      const list = (await api('get', '/dispatch/emergencies').expect(200)).body;
      const summary = list.find((e: any) => e.id === emergencyId);
      expect(summary).toMatchObject({
        id: emergencyId,
        routeId: route.id,
        driverId: ids.driver,
        returnedAt: null,
        counts: {
          totalUnits: 4,
          recoveredUnits: 0,
          lostPreparedUnits: 0,
          lostPendingUnits: 0,
          pendingUnits: 4,
        },
      });
      expect(summary.pendingUnits).toHaveLength(4);

      const routeEmergency = (await api('get', `/dispatch/routes/${route.id}/emergency`).expect(200)).body;
      expect(routeEmergency.units).toHaveLength(4);

      const inbox = (await api('get', '/dispatch/inbox').expect(200)).body;
      expect(inbox.interruptedRoutes.find((r: any) => r.routeId === route.id)).toMatchObject({
        routeId: route.id,
        emergencyId,
        pendingUnitsCount: 4,
        totalUnitsCount: 4,
      });

      // Driver stop mutations & route complete reject with 409 on INTERRUPTED route.
      await api(
        'post',
        `/routes/${route.id}/stops/${stop3.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'After emergency' },
        ids.driverUser,
        'DRIVER',
      ).expect(409);
      await api(
        'patch',
        `/orders/${o2.order.id}/status`,
        { status: 'DELIVERED' },
        ids.driverUser,
        'DRIVER',
      ).expect(409);
      await api('post', `/routes/${route.id}/complete`, {}, ids.driverUser, 'DRIVER').expect(409);

      // Release driver so driver 1 is free for subsequent tests.
      await intervene({ action: 'EMERGENCY_DRIVER_RELEASE', routeId: route.id }).expect(200);
    });

    it('preserves Stop 1 FAILED with its DeliveryAttempt when emergency is declared on remaining pending stops', async () => {
      const product = await seedProduct(5);
      const o1 = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const o2 = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const { route, detail } = await createAndStartRoute([o1.order.id, o2.order.id]);

      await api(
        'post',
        `/routes/${route.id}/stops/${detail.stops[0].id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_REFUSED', context: 'Refused at door' },
        ids.driverUser,
        'DRIVER',
      ).expect(200);
      const attemptId = (await api('get', `/routes/${route.id}`).expect(200)).body.stops[0].attempts[0].id as string;

      const res = await intervene({ action: 'EMERGENCY_DECLARE', routeId: route.id }).expect(200);
      expect(res.body.result.preservedCompletedStopIds).toEqual([detail.stops[0].id]);
      expect(res.body.result.detachedOrderIds).toEqual([o2.order.id]);

      const order1 = await db.orm.public.Order.where({ id: o1.order.id }).first();
      expect(order1).toMatchObject({
        status: 'ASSIGNED',
        routeId: route.id,
        requiresAdministrativeReview: true,
      });

      // Failed Stop 1 can still be resolved independently via its attemptId.
      await intervene({ action: 'PICKUP_AGREE', orderId: o1.order.id, attemptId }).expect(200);
      await intervene({ action: 'EMERGENCY_DRIVER_RELEASE', routeId: route.id }).expect(200);
    });
  });

  describe('S2 & S5 — Individual unit recovery, stock/receipt/payment invariance, partial unblock guard, and explicit resolution', () => {
    it('keeps order blocked until all units recover, preserves stock/receipt/payment/total, enforces PG guard, and allows EMERGENCY_REQUEUE / RESCHEDULE / PICKUP after full recovery', async () => {
      const product = await seedProduct(5, 10);
      const multi = await seedOrder([{ productId: product.id, quantity: 2, price: 10 }], now(), true);
      const forReschedule = await seedOrder([{ productId: product.id, quantity: 1, price: 10 }]);
      const forPickup = await seedOrder([{ productId: product.id, quantity: 1, price: 10 }]);

      const stockBefore = (await db.orm.public.Product.where({ id: product.id }).first())!.stock;
      const receiptBefore = await db.orm.public.PurchaseReceipt.where({ orderId: multi.order.id }).first();
      const paymentBefore = await db.orm.public.PaymentAttempt.where({ orderId: multi.order.id }).first();

      const { route } = await createAndStartRoute([
        multi.order.id,
        forReschedule.order.id,
        forPickup.order.id,
      ]);
      const emergencyId = (await intervene({ action: 'EMERGENCY_DECLARE', routeId: route.id }).expect(200)).body.result
        .emergencyId as string;
      await intervene({ action: 'EMERGENCY_DRIVER_RELEASE', routeId: route.id }).expect(200);

      const multiUnits = (
        await db.orm.public.RouteUnitRecovery.where({ emergencyId, orderId: multi.order.id }).all()
      ).sort((a, b) => a.unitNumber - b.unitNumber);
      expect(multiUnits).toHaveLength(2);

      // Confirm unit 1 of 2
      const unit1Req = {
        requestId: randomUUID(),
        action: 'UNIT_RECOVERY_CONFIRM',
        recoveryId: multiUnits[0]!.id,
        reason: 'Unit 1 returned intact',
      };
      const confirm1 = await api('post', '/dispatch/interventions', unit1Req, ids.admin).expect(200);
      expect(confirm1.body.result).toMatchObject({
        recoveryId: multiUnits[0]!.id,
        unitNumber: 1,
        orderAllUnitsResolved: false,
      });

      // Replay idempotent; new requestId for already recovered unit -> 409 UNIT_ALREADY_RECOVERED
      expect((await api('post', '/dispatch/interventions', unit1Req, ids.admin).expect(200)).body).toEqual(confirm1.body);
      const dupUnit1 = await intervene({
        action: 'UNIT_RECOVERY_CONFIRM',
        recoveryId: multiUnits[0]!.id,
      }).expect(409);
      expect(dupUnit1.body.code).toBe('UNIT_ALREADY_RECOVERED');

      // Stock, StockMovement, PurchaseReceipt, PaymentAttempt, and Order.total are untouched.
      expect((await db.orm.public.Product.where({ id: product.id }).first())!.stock).toBe(stockBefore);
      expect(await db.orm.public.ProductStockMovement.where({ productId: product.id }).all()).toHaveLength(0);
      expect(await db.orm.public.PurchaseReceipt.where({ orderId: multi.order.id }).first()).toEqual(receiptBefore);
      expect(await db.orm.public.PaymentAttempt.where({ orderId: multi.order.id }).first()).toEqual(paymentBefore);
      expect((await db.orm.public.Order.where({ id: multi.order.id }).first())!.total).toBe(20);

      // Partial recovery keeps the order blocked (409 RECOVERY_PENDING) across all dispatch/planning paths.
      const requeueBlocked = await intervene({
        action: 'EMERGENCY_REQUEUE',
        orderId: multi.order.id,
        emergencyId,
      }).expect(409);
      expect(requeueBlocked.body.code).toBe('RECOVERY_PENDING');

      const tomorrow = guayaquilDay(1);
      const contactBlocked = await intervene({
        action: 'CONTACT',
        orderId: multi.order.id,
        emergencyId,
        agreementConfirmed: true,
        scheduledDeliveryDate: `${tomorrow}T14:00:00-05:00`,
        deliveryWindowStart: `${tomorrow}T13:00:00-05:00`,
        deliveryWindowEnd: `${tomorrow}T16:00:00-05:00`,
      }).expect(409);
      expect(contactBlocked.body.code).toBe('RECOVERY_PENDING');

      const pickupBlocked = await intervene({
        action: 'PICKUP_AGREE',
        orderId: multi.order.id,
        emergencyId,
      }).expect(409);
      expect(pickupBlocked.body.code).toBe('RECOVERY_PENDING');

      const todayStr = guayaquilDay(0);
      const proposalsBlocked = (await api('get', `/route-proposals?date=${todayStr}`).expect(200)).body;
      expect(proposalsBlocked.proposals.flatMap((p: any) => p.orderIds)).not.toContain(multi.order.id);
      expect(proposalsBlocked.excluded.find((e: any) => e.orderId === multi.order.id)?.reasons).toContain(
        'ADMINISTRATIVE_REVIEW_REQUIRED',
      );

      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: now().toString(),
        orderIds: [multi.order.id],
      }).expect(409);

      const urgencyBlocked = (await api('get', `/dispatch/orders/${multi.order.id}/proposal`).expect(200)).body;
      expect(urgencyBlocked.kind).toBe('BLOCKED');
      expect(urgencyBlocked.reasons).toEqual(
        expect.arrayContaining(['ADMINISTRATIVE_REVIEW_REQUIRED', 'RECOVERY_PENDING']),
      );

      // Direct PostgreSQL trigger dispatch_review_resolution_guard rejects clearing requiresAdministrativeReview while units remain pending (SQLSTATE 23514).
      await expectSqlState(
        db.orm.public.Order.where({ id: multi.order.id }).update({
          requiresAdministrativeReview: false,
        }),
        '23514',
      );

      // Confirm unit 2 of 2
      const confirm2 = await intervene(
        { action: 'UNIT_RECOVERY_CONFIRM', recoveryId: multiUnits[1]!.id },
        ids.admin2,
      ).expect(200);
      expect(confirm2.body.result).toMatchObject({ orderAllUnitsResolved: true });

      // Stock/receipt/payment/total still untouched, and order is NEVER auto-dispatched.
      expect((await db.orm.public.Product.where({ id: product.id }).first())!.stock).toBe(stockBefore);
      expect(await db.orm.public.Order.where({ id: multi.order.id }).first()).toMatchObject({
        status: 'PENDING',
        routeId: null,
        requiresAdministrativeReview: true,
      });

      // EMERGENCY_REQUEUE now succeeds and makes the order eligible for same-day planning.
      await intervene({
        action: 'EMERGENCY_REQUEUE',
        orderId: multi.order.id,
        emergencyId,
      }).expect(200);
      expect(await db.orm.public.Order.where({ id: multi.order.id }).first()).toMatchObject({
        status: 'PENDING',
        routeId: null,
        requiresAdministrativeReview: false,
      });

      const proposalsAfter = (await api('get', `/route-proposals?date=${todayStr}`).expect(200)).body;
      expect(proposalsAfter.proposals.flatMap((p: any) => p.orderIds)).toContain(multi.order.id);
      const urgencyAfter = (await api('get', `/dispatch/orders/${multi.order.id}/proposal`).expect(200)).body;
      expect(urgencyAfter.reasons).not.toContain('RECOVERY_PENDING');
      expect(urgencyAfter.reasons).not.toContain('ADMINISTRATIVE_REVIEW_REQUIRED');

      // Recover forReschedule and complete CONTACT + RESCHEDULE with emergencyId and future Guayaquil delivery window.
      const reschedUnit = (
        await db.orm.public.RouteUnitRecovery.where({ emergencyId, orderId: forReschedule.order.id }).first()
      )!;
      await intervene({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: reschedUnit.id }).expect(200);
      const contact = (
        await intervene({
          action: 'CONTACT',
          orderId: forReschedule.order.id,
          emergencyId,
          agreementConfirmed: true,
          scheduledDeliveryDate: `${tomorrow}T14:00:00-05:00`,
          deliveryWindowStart: `${tomorrow}T13:00:00-05:00`,
          deliveryWindowEnd: `${tomorrow}T16:00:00-05:00`,
        }).expect(200)
      ).body;
      await intervene({
        action: 'RESCHEDULE',
        orderId: forReschedule.order.id,
        agreementId: contact.id,
      }).expect(200);
      expect(await db.orm.public.Order.where({ id: forReschedule.order.id }).first()).toMatchObject({
        status: 'PENDING',
        routeId: null,
        requiresAdministrativeReview: false,
      });
      const tomorrowProposals = (await api('get', `/route-proposals?date=${tomorrow}`).expect(200)).body;
      expect(tomorrowProposals.proposals.flatMap((p: any) => p.orderIds)).toContain(forReschedule.order.id);

      // Recover forPickup and complete #50 PICKUP_AGREE + PICKUP_CONFIRM flow.
      const pickupUnit = (
        await db.orm.public.RouteUnitRecovery.where({ emergencyId, orderId: forPickup.order.id }).first()
      )!;
      await intervene({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: pickupUnit.id }).expect(200);
      await intervene({
        action: 'PICKUP_AGREE',
        orderId: forPickup.order.id,
        emergencyId,
      }).expect(200);
      await intervene({
        action: 'PICKUP_CONFIRM',
        orderId: forPickup.order.id,
      }).expect(200);
      expect(await db.orm.public.Order.where({ id: forPickup.order.id }).first()).toMatchObject({
        status: 'DELIVERED',
        requiresAdministrativeReview: false,
      });
    });
  });

  describe('S3 — Emergency closure with pending units', () => {
    it('closes emergency while unrecovered units remain visible and their orders stay blocked until resolved', async () => {
      const product = await seedProduct(5);
      const o1 = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const o2 = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const { route } = await createAndStartRoute([o1.order.id, o2.order.id]);
      const emergencyId = (await intervene({ action: 'EMERGENCY_DECLARE', routeId: route.id }).expect(200)).body.result
        .emergencyId as string;
      await intervene({ action: 'EMERGENCY_DRIVER_RELEASE', routeId: route.id }).expect(200);

      const unit1 = (await db.orm.public.RouteUnitRecovery.where({ emergencyId, orderId: o1.order.id }).first())!;
      const unit2 = (await db.orm.public.RouteUnitRecovery.where({ emergencyId, orderId: o2.order.id }).first())!;
      await intervene({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unit1.id }).expect(200);

      const closeBody = {
        requestId: randomUUID(),
        action: 'EMERGENCY_CLOSE',
        routeId: route.id,
        reason: 'Route closed administratively while pending custody unit 2',
      };
      const closed = await api('post', '/dispatch/interventions', closeBody, ids.admin2).expect(200);
      expect(closed.body.result).toMatchObject({ emergencyId, routeId: route.id });
      expect((await api('post', '/dispatch/interventions', closeBody, ids.admin2).expect(200)).body).toEqual(
        closed.body,
      );
      expect(
        (await intervene({ action: 'EMERGENCY_CLOSE', routeId: route.id }).expect(409)).body.code,
      ).toBe('EMERGENCY_ALREADY_CLOSED');

      const detail = (await api('get', `/dispatch/routes/${route.id}/emergency`).expect(200)).body;
      expect(detail.closedAt).toEqual(expect.any(String));
      expect(detail.closedById).toBe(ids.admin2);
      expect(detail.counts).toMatchObject({ totalUnits: 2, recoveredUnits: 1, pendingUnits: 1 });
      expect(detail.pendingUnits.map((u: any) => u.id)).toEqual([unit2.id]);

      const list = (await api('get', '/dispatch/emergencies').expect(200)).body;
      expect(list.find((e: any) => e.id === emergencyId)?.pendingUnits.map((u: any) => u.id)).toEqual([unit2.id]);

      // Order 2 remains blocked until unit 2 is confirmed recovered.
      const blocked = await intervene({
        action: 'EMERGENCY_REQUEUE',
        orderId: o2.order.id,
        emergencyId,
      }).expect(409);
      expect(blocked.body.code).toBe('RECOVERY_PENDING');

      await intervene({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unit2.id }).expect(200);
      await intervene({ action: 'EMERGENCY_REQUEUE', orderId: o2.order.id, emergencyId }).expect(200);
      expect(await db.orm.public.Order.where({ id: o2.order.id }).first()).toMatchObject({
        requiresAdministrativeReview: false,
      });
    });
  });

  describe('S4 — Independent driver return/release and #44 DriverAbsence interaction', () => {
    it('keeps driver blocked while returnedAt IS NULL, supports independent DRIVER return and ADMIN release, and respects active DriverAbsence', async () => {
      const product = await seedProduct(10);
      const todayStr = guayaquilDay(0);

      // Path A: DRIVER self-return via POST /routes/:id/return before unit recovery or emergency closure
      const oA = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const oExtra = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const { route: routeA } = await createAndStartRoute([oA.order.id], ids.driver, ids.driverUser);
      await intervene({ action: 'EMERGENCY_DECLARE', routeId: routeA.id }).expect(200);

      const availBlocked = (
        await api('get', '/drivers/me/availability', undefined, ids.driverUser, 'DRIVER').expect(200)
      ).body;
      expect(availBlocked).toMatchObject({
        isAvailable: false,
        hasPersistedHolds: true,
        blockingRouteIds: [routeA.id],
      });

      const draftNext = (
        await api('post', '/routes', {
          zoneId: ids.zone,
          routeDate: now().toString(),
          orderIds: [oExtra.order.id],
        }).expect(201)
      ).body;
      await api('post', `/routes/${draftNext.id}/assign`, { driverId: ids.driver }).expect(409);

      const driverReturned = (
        await api('post', `/routes/${routeA.id}/return`, {}, ids.driverUser, 'DRIVER').expect(200)
      ).body;
      expect(driverReturned).toMatchObject({
        id: routeA.id,
        status: 'INTERRUPTED',
        availability: { isAvailable: true, hasPersistedHolds: false, blockingRouteIds: [] },
      });
      expect(driverReturned.returnedAt).toEqual(expect.any(String));

      // Replay idempotent; ADMIN release afterwards conflicts.
      expect(
        (await api('post', `/routes/${routeA.id}/return`, {}, ids.driverUser, 'DRIVER').expect(200)).body,
      ).toEqual(driverReturned);
      expect(
        (await intervene({ action: 'EMERGENCY_DRIVER_RELEASE', routeId: routeA.id }).expect(409)).body.code,
      ).toBe('DRIVER_ALREADY_RELEASED');

      const resA = await db.orm.public.DriverReservation.where({ routeId: routeA.id }).first();
      const routeARow = await db.orm.public.Route.where({ id: routeA.id }).first();
      expect(resA!.releasedAt?.toString()).toBe(routeARow!.returnedAt?.toString());
      expect(routeARow!.returnedById).toBe(ids.driverUser);

      // Driver can now be assigned to draftNext; clean up by completing and returning draftNext.
      await api('post', `/routes/${draftNext.id}/assign`, { driverId: ids.driver }).expect(200);
      await api('post', `/routes/${draftNext.id}/start`, {}, ids.driverUser, 'DRIVER').expect(200);
      await api('patch', `/orders/${oExtra.order.id}/status`, { status: 'IN_TRANSIT' }, ids.driverUser, 'DRIVER').expect(200);
      await api('patch', `/orders/${oExtra.order.id}/status`, { status: 'DELIVERED' }, ids.driverUser, 'DRIVER').expect(200);
      await api('post', `/routes/${draftNext.id}/complete`, {}, ids.driverUser, 'DRIVER').expect(200);
      await api('post', `/routes/${draftNext.id}/return`, {}, ids.driverUser, 'DRIVER').expect(200);

      // Path B + #44 DriverAbsence: active absence covering today keeps driver unavailable after ADMIN release
      const oB = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const oC = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const { route: routeB } = await createAndStartRoute([oB.order.id], ids.driver2, ids.driverUser2);
      const absence = (
        await api('post', `/drivers/${ids.driver2}/absences`, {
          startDate: todayStr,
          endDate: todayStr,
          reason: 'Driver medical leave',
        }).expect(201)
      ).body;
      expect(absence.conflicts.map((c: any) => c.routeId)).toContain(routeB.id);

      await intervene({ action: 'EMERGENCY_DECLARE', routeId: routeB.id }).expect(200);
      await intervene({ action: 'EMERGENCY_DRIVER_RELEASE', routeId: routeB.id }, ids.admin2).expect(200);

      const routeBRow = await db.orm.public.Route.where({ id: routeB.id }).first();
      const resB = await db.orm.public.DriverReservation.where({ routeId: routeB.id }).first();
      expect(routeBRow!.returnedById).toBe(ids.admin2);
      expect(resB!.releasedAt?.toString()).toBe(routeBRow!.returnedAt?.toString());

      // Driver endpoint after admin release rejects; duplicate release rejects.
      await api('post', `/routes/${routeB.id}/return`, {}, ids.driverUser2, 'DRIVER').expect(409);
      expect(
        (await intervene({ action: 'EMERGENCY_DRIVER_RELEASE', routeId: routeB.id }).expect(409)).body.code,
      ).toBe('DRIVER_ALREADY_RELEASED');

      // Effective availability for today still reports unavailable due to active #44 DriverAbsence, and new route assignment rejects.
      const dayAvailability = (
        await api('get', `/drivers/${ids.driver2}/availability?date=${todayStr}`).expect(200)
      ).body;
      expect(dayAvailability).toMatchObject({
        isAvailable: false,
        hasPersistedHolds: false,
        absence: { id: absence.id, startDate: todayStr, endDate: todayStr },
      });

      const draftC = (
        await api('post', '/routes', {
          zoneId: ids.zone,
          routeDate: now().toString(),
          orderIds: [oC.order.id],
        }).expect(201)
      ).body;
      const blockedByAbsence = await api('post', `/routes/${draftC.id}/assign`, { driverId: ids.driver2 }).expect(409);
      expect(blockedByAbsence.body.code).toBe('DRIVER_ABSENT');
    });
  });

  describe('S6 — Emergency unit + #52 loss + replacement + LOSS_CANCEL + #50 pickup', () => {
    it('enforces unit mutual exclusion, keeps order blocked on PENDING loss until PREPARED, handles LOSS_CANCEL re-lock & re-declare, and completes via PICKUP', async () => {
      const product = await seedProduct(0, 25);
      const { order, items } = await seedOrder([{ productId: product.id, quantity: 2, price: 25 }]);
      const item = items[0]!;

      const { route } = await createAndStartRoute([order.id]);
      const emergencyId = (await intervene({ action: 'EMERGENCY_DECLARE', routeId: route.id }).expect(200)).body.result
        .emergencyId as string;
      await intervene({ action: 'EMERGENCY_DRIVER_RELEASE', routeId: route.id }).expect(200);

      const units = (
        await db.orm.public.RouteUnitRecovery.where({ emergencyId, orderId: order.id }).all()
      ).sort((a, b) => a.unitNumber - b.unitNumber);
      const unit1 = units[0]!;
      const unit2 = units[1]!;

      // Confirm unit 1 recovered -> cannot declare loss on already recovered unit 1 (409 UNIT_ALREADY_RECOVERED)
      await intervene({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unit1.id }).expect(200);
      const lossOnRecovered = await intervene({
        action: 'LOSS_DECLARE',
        orderId: order.id,
        orderItemId: item.id,
        unitNumber: 1,
        emergencyId,
      }).expect(409);
      expect(lossOnRecovered.body.code).toBe('UNIT_ALREADY_RECOVERED');

      // Declare unit 2 lost with stock = 0 -> PENDING replacement; order still blocked; unit 2 cannot be confirmed recovered
      const declaredLoss = await intervene({
        action: 'LOSS_DECLARE',
        orderId: order.id,
        orderItemId: item.id,
        unitNumber: 2,
        emergencyId,
      }).expect(200);
      const lossId = declaredLoss.body.result.lossId as string;
      expect(declaredLoss.body.result).toMatchObject({ replacement: 'PENDING', stock: '0' });

      const confirmOnLost = await intervene({
        action: 'UNIT_RECOVERY_CONFIRM',
        recoveryId: unit2.id,
      }).expect(409);
      expect(confirmOnLost.body.code).toBe('UNIT_HAS_ACTIVE_LOSS');

      const stillBlocked = await intervene({
        action: 'EMERGENCY_REQUEUE',
        orderId: order.id,
        emergencyId,
      }).expect(409);
      expect(stillBlocked.body.code).toBe('RECOVERY_PENDING');

      // Replenish stock = 1, prepare replacement -> stock drops to 0, order unblocked for EMERGENCY_REQUEUE
      await db.orm.public.Product.where({ id: product.id }).update({ stock: 1 });
      const prepared = await intervene({ action: 'REPLACEMENT_PREPARE', lossId }).expect(200);
      expect(prepared.body.result).toMatchObject({ replacement: 'PREPARED', stock: '0' });
      expect((await db.orm.public.Product.where({ id: product.id }).first())!.stock).toBe(0);

      await intervene({ action: 'EMERGENCY_REQUEUE', orderId: order.id, emergencyId }).expect(200);
      expect((await db.orm.public.Order.where({ id: order.id }).first())!.requiresAdministrativeReview).toBe(false);

      // LOSS_CANCEL on the PREPARED emergency loss restores stock +1 with REPLACEMENT_CANCEL_IN and re-locks administrative review
      const cancelled = await intervene({ action: 'LOSS_CANCEL', lossId }).expect(200);
      expect(cancelled.body.result).toMatchObject({ lossId, stock: '1' });
      expect((await db.orm.public.Product.where({ id: product.id }).first())!.stock).toBe(1);
      expect((await db.orm.public.Order.where({ id: order.id }).first())!.requiresAdministrativeReview).toBe(true);
      expect(
        (await db.orm.public.ProductStockMovement.where({ lossId }).all())
          .map((m) => m.kind)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(['REPLACEMENT_CANCEL_IN', 'REPLACEMENT_OUT']);

      // Requeue is blocked again until unit 2 is resolved; partial unique index allows declaring real loss on unit 2.
      expect(
        (await intervene({ action: 'EMERGENCY_REQUEUE', orderId: order.id, emergencyId }).expect(409)).body.code,
      ).toBe('RECOVERY_PENDING');

      const realLoss = await intervene({
        action: 'LOSS_DECLARE',
        orderId: order.id,
        orderItemId: item.id,
        unitNumber: 2,
        emergencyId,
      }).expect(200);
      expect(realLoss.body.result).toMatchObject({ replacement: 'PREPARED', stock: '0' });
      expect((await db.orm.public.Product.where({ id: product.id }).first())!.stock).toBe(0);

      // Now PICKUP_AGREE + PICKUP_CONFIRM (#50) delivers the order cleanly.
      await intervene({ action: 'PICKUP_AGREE', orderId: order.id, emergencyId }).expect(200);
      await intervene({ action: 'PICKUP_CONFIRM', orderId: order.id }).expect(200);
      expect(await db.orm.public.Order.where({ id: order.id }).first()).toMatchObject({
        status: 'DELIVERED',
        requiresAdministrativeReview: false,
      });
    });
  });

  describe('S8 — PostgreSQL trigger hardening against raw SQL bypasses', () => {
    it('rejects INTERRUPTED regression, invented completedAt, unauthorized claim/reservation release, and unverified review resolution with SQLSTATE 23514', async () => {
      const product = await seedProduct(5);
      const o1 = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const o2 = await seedOrder([{ productId: product.id, quantity: 1 }]);
      const { route } = await createAndStartRoute([o1.order.id, o2.order.id]);

      // 1. t1e_claim_history_guard rejects direct SQL claim release on IN_PROGRESS or INTERRUPTED without EMERGENCY_DECLARE
      await expectSqlState(
        db.transaction(async (tx) => {
          await tx.execute(
            db.raw.sql`UPDATE public."orderClaim" SET "releasedAt" = NOW() WHERE "routeId" = ${route.id} AND "releasedAt" IS NULL`
              .affectedCount()
              .build(),
          );
        }),
        '23514',
      );
      await expectSqlState(
        db.transaction(async (tx) => {
          await tx.execute(
            db.raw.sql`UPDATE public.route SET status = 'INTERRUPTED' WHERE id = ${route.id}`
              .affectedCount()
              .build(),
          );
          await tx.execute(
            db.raw.sql`UPDATE public."orderClaim" SET "releasedAt" = NOW() WHERE "routeId" = ${route.id} AND "releasedAt" IS NULL`
              .affectedCount()
              .build(),
          );
        }),
        '23514',
      );

      // Now declare emergency legitimately via API.
      const emergencyId = (await intervene({ action: 'EMERGENCY_DECLARE', routeId: route.id }).expect(200)).body.result
        .emergencyId as string;

      // 2. route_integrity_guard rejects reverting INTERRUPTED -> ASSIGNED or setting completedAt on INTERRUPTED
      await expectSqlState(
        db.transaction(async (tx) => {
          await tx.execute(
            db.raw.sql`UPDATE public.route SET status = 'ASSIGNED' WHERE id = ${route.id}`
              .affectedCount()
              .build(),
          );
        }),
        '23514',
      );
      await expectSqlState(
        db.transaction(async (tx) => {
          await tx.execute(
            db.raw.sql`UPDATE public.route SET "completedAt" = NOW(), "completedById" = ${ids.admin} WHERE id = ${route.id}`
              .affectedCount()
              .build(),
          );
        }),
        '23514',
      );

      // 3. t1e_reservation_history_guard rejects releasing DriverReservation on INTERRUPTED when Route.returnedAt IS NULL
      await expectSqlState(
        db.transaction(async (tx) => {
          await tx.execute(
            db.raw.sql`UPDATE public."driverReservation" SET "releasedAt" = NOW() WHERE "routeId" = ${route.id} AND "releasedAt" IS NULL`
              .affectedCount()
              .build(),
          );
        }),
        '23514',
      );

      // 4. dispatch_review_resolution_guard rejects clearing requiresAdministrativeReview directly via SQL
      await expectSqlState(
        db.transaction(async (tx) => {
          await tx.execute(
            db.raw.sql`UPDATE public."order" SET "requiresAdministrativeReview" = false WHERE id = ${o1.order.id}`
              .affectedCount()
              .build(),
          );
        }),
        '23514',
      );

      // Even after unit recovery, raw SQL still cannot bypass EMERGENCY_REQUEUE / RESCHEDULE / PICKUP_CONFIRM
      const unit1 = (await db.orm.public.RouteUnitRecovery.where({ emergencyId, orderId: o1.order.id }).first())!;
      await intervene({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unit1.id }).expect(200);
      await expectSqlState(
        db.transaction(async (tx) => {
          await tx.execute(
            db.raw.sql`UPDATE public."order" SET "requiresAdministrativeReview" = false WHERE id = ${o1.order.id}`
              .affectedCount()
              .build(),
          );
        }),
        '23514',
      );
    });
  });
});
