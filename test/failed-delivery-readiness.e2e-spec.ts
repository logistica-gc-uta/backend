import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from '../src/prisma/contract.d';
import contractJson from '../src/prisma/contract.json' with { type: 'json' };
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  execPsqlCommand,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(180_000);

describe('Failed-delivery early claim release & store readiness (T4 / S3, owned PostgreSQL)', () => {
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const oldSecret = process.env.JWT_SECRET;
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let receipt: ReturnType<typeof startOwnedContainer>;
  let database: string;

  const ids = {
    admin: randomUUID(),
    admin2: randomUUID(),
    client: randomUUID(),
    driverUser1: randomUUID(),
    driverUser2: randomUUID(),
    driver1: randomUUID(),
    driver2: randomUUID(),
    zone: randomUUID(),
  };

  const token = (sub: string, role = 'ADMIN') =>
    jwt.sign({ sub, role, email: `${sub}@fixture.invalid` });

  const api = (
    method: 'get' | 'post' | 'patch',
    path: string,
    body?: object,
    sub = ids.admin,
    role = 'ADMIN',
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .auth(token(sub, role), { type: 'bearer' });
    return body === undefined ? req : req.send(body);
  };

  const intervene = (
    body: Record<string, unknown>,
    sub = ids.admin,
    role = 'ADMIN',
  ) =>
    api(
      'post',
      '/dispatch/interventions',
      {
        requestId: randomUUID(),
        reason: 'Operational readiness verification',
        ...body,
      },
      sub,
      role,
    );

  const todayInstant = () =>
    Temporal.Now.instant().round({ smallestUnit: 'microsecond' });

  const futureSlotSameOrNextDay = (minutesAhead = 25) => {
    const zone = 'America/Guayaquil';
    const soon = Temporal.Now.instant()
      .add({ minutes: minutesAhead })
      .round({ smallestUnit: 'microsecond' });
    const start = soon.subtract({ minutes: 5 });
    const end = soon.add({ minutes: 5 });
    const day = (i: Temporal.Instant) =>
      i.toZonedDateTimeISO(zone).toPlainDate().toString();
    if (day(start) === day(end)) {
      return {
        scheduledDeliveryDate: soon,
        deliveryWindowStart: start,
        deliveryWindowEnd: end,
      };
    }
    const noonTomorrow = Temporal.Now.zonedDateTimeISO(zone)
      .toPlainDate()
      .add({ days: 1 })
      .toZonedDateTime({ timeZone: zone, plainTime: '12:00' })
      .toInstant()
      .round({ smallestUnit: 'microsecond' });
    return {
      scheduledDeliveryDate: noonTomorrow,
      deliveryWindowStart: noonTomorrow.subtract({ minutes: 10 }),
      deliveryWindowEnd: noonTomorrow.add({ minutes: 10 }),
    };
  };

  const seedProduct = async (stock = 10) =>
    db.orm.public.Product.create({
      name: `Product-${randomUUID().slice(0, 6)}`,
      price: 15,
      stock,
    });

  const seedOrder = async (productId?: string) => {
    const order = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      deliveryAddress: 'Av. Ceballos 123',
      scheduledDeliveryDate: todayInstant(),
      deliveryLat: -1.25,
      deliveryLng: -78.62,
    });
    if (productId) {
      await db.orm.public.OrderItem.create({
        orderId: order.id,
        productId,
        quantity: 1,
        price: 15,
      });
    }
    return order;
  };

  const createAndStartRoute = async (
    orderIds: string[],
    driverId = ids.driver1,
    driverUserId = ids.driverUser1,
  ) => {
    const route = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: todayInstant().toString(),
        orderIds,
      }).expect(201)
    ).body;
    await api('post', `/routes/${route.id}/assign`, { driverId }).expect(200);
    await api('post', `/routes/${route.id}/start`, {}, driverUserId, 'DRIVER').expect(200);
    const detail = (await api('get', `/routes/${route.id}`).expect(200)).body;
    return { route, detail };
  };

  const resetDrivers = async () => {
    ids.driverUser1 = randomUUID();
    ids.driverUser2 = randomUUID();
    ids.driver1 = randomUUID();
    ids.driver2 = randomUUID();
    for (const [userId, driverId, label] of [
      [ids.driverUser1, ids.driver1, 'Driver One'],
      [ids.driverUser2, ids.driver2, 'Driver Two'],
    ] as const) {
      await db.orm.public.User.create({
        id: userId,
        role: 'DRIVER',
        name: label,
        email: `${userId}@fixture.invalid`,
        password: 'fixture',
      });
      await db.orm.public.Driver.create({
        id: driverId,
        userId,
        vehicle: label,
      });
    }
  };

  beforeAll(async () => {
    receipt = startOwnedContainer();
    process.env.JWT_SECRET = secret;
    database = `failed_ready_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const url = createOwnedDatabase(database);
    runPrismaMigrate(url);
    execFileSync('pnpm', ['prisma', 'db', 'verify', '--db', url], {
      env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' },
      stdio: 'pipe',
    });
    db = postgres<Contract>({ contractJson, url });
    for (const [id, role] of [
      [ids.admin, 'ADMIN'],
      [ids.admin2, 'ADMIN'],
      [ids.client, 'CLIENT'],
    ] as const) {
      await db.orm.public.User.create({
        id,
        role,
        name: role,
        email: `${id}@fixture.invalid`,
        password: 'fixture',
      });
    }
    await db.orm.public.Zone.create({
      id: ids.zone,
      code: ids.zone,
      name: 'Zona Centro',
      depotLat: -1.24,
      depotLng: -78.61,
    });
    const prisma = {
      client: db,
      orm: db.orm,
      sql: db.sql,
      user: db.orm.public.User,
      driver: db.orm.public.Driver,
      zone: db.orm.public.Zone,
      order: db.orm.public.Order,
      orderItem: db.orm.public.OrderItem,
      product: db.orm.public.Product,
      route: db.orm.public.Route,
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  beforeEach(async () => {
    await resetDrivers();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    cleanupOwnedResources();
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
    expect(() =>
      execFileSync('docker', ['inspect', receipt.containerId], {
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(existsSync(receipt.scratchDir)).toBe(false);
  });

  it('releases the failed stop claim immediately, keeps admin hold, enforces CONFIRM_INCIDENT_READY with replay/concurrency, and completes original route after early replan/redelivery without touching newer claims', async () => {
    const order1 = await seedOrder();
    const order2 = await seedOrder();
    const { route: route1, detail } = await createAndStartRoute([
      order1.id,
      order2.id,
    ]);
    const stop1 = detail.stops.find((s: any) => s.orderId === order1.id);

    const failBody = {
      requestId: randomUUID(),
      reason: 'RECIPIENT_ABSENT',
      context: 'Recipient did not answer',
    };
    const failed = (
      await api(
        'post',
        `/routes/${route1.id}/stops/${stop1.id}/failure`,
        failBody,
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;
    const attemptId = failed.id as string;

    // Exact failed claim released at attempt.recordedAt; second stop claim remains active.
    const route1ClaimsAfterFail = await db.orm.public.OrderClaim.where({
      routeId: route1.id,
    }).all();
    expect(
      route1ClaimsAfterFail.find((c) => c.orderId === order1.id)?.releasedAt?.toString(),
    ).toBe(failed.recordedAt);
    expect(
      route1ClaimsAfterFail.find((c) => c.orderId === order2.id)?.releasedAt,
    ).toBeNull();
    // Administrative hold remains active so order1 is NOT automatically plannable.
    expect(
      await db.orm.public.Order.where({ id: order1.id }).first(),
    ).toMatchObject({
      status: 'ASSIGNED',
      routeId: route1.id,
      requiresAdministrativeReview: true,
    });
    const earlyPlan = await api('post', '/routes', {
      zoneId: ids.zone,
      routeDate: todayInstant().toString(),
      orderIds: [order1.id],
    });
    expect(earlyPlan.status).toBe(409);

    // CONTACT is allowed immediately while route1 is IN_PROGRESS and before readiness.
    const slot = futureSlotSameOrNextDay(30);
    const contact = (
      await intervene({
        action: 'CONTACT',
        orderId: order1.id,
        attemptId,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;

    // RESCHEDULE and PICKUP_AGREE reject until CONFIRM_INCIDENT_READY is recorded.
    expect(
      (
        await intervene({
          action: 'RESCHEDULE',
          orderId: order1.id,
          agreementId: contact.id,
        }).expect(409)
      ).body.code,
    ).toBe('INCIDENT_NOT_READY_AT_STORE');
    expect(
      (
        await intervene({
          action: 'PICKUP_AGREE',
          orderId: order1.id,
          attemptId,
        }).expect(409)
      ).body.code,
    ).toBe('INCIDENT_NOT_READY_AT_STORE');

    // Authorization & payload guards for CONFIRM_INCIDENT_READY.
    const readyBody = {
      requestId: randomUUID(),
      action: 'CONFIRM_INCIDENT_READY',
      orderId: order1.id,
      attemptId,
      reason: 'Driver returned parcel to store counter',
    };
    await request(app.getHttpServer())
      .post('/api/v1/dispatch/interventions')
      .send(readyBody)
      .expect(401);
    await api('post', '/dispatch/interventions', readyBody, ids.client, 'CLIENT').expect(403);
    await api('post', '/dispatch/interventions', readyBody, ids.driverUser1, 'DRIVER').expect(403);
    await api('post', '/dispatch/interventions', { ...readyBody, actorId: ids.admin2 }).expect(400);
    await api('post', '/dispatch/interventions', { ...readyBody, routeId: route1.id }).expect(400);

    // Concurrent readiness calls with distinct requestIds: exactly one applies, one rejects 409.
    const [rA, rB] = await Promise.all([
      api('post', '/dispatch/interventions', readyBody, ids.admin),
      api(
        'post',
        '/dispatch/interventions',
        { ...readyBody, requestId: randomUUID() },
        ids.admin2,
      ),
    ]);
    expect([rA.status, rB.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const winnerBody = rA.status === 200 ? readyBody : { ...readyBody, requestId: rB.body.requestId };
    const winnerActor = rA.status === 200 ? ids.admin : ids.admin2;
    const winnerAudit = rA.status === 200 ? rA.body : rB.body;
    expect(winnerAudit).toMatchObject({
      action: 'CONFIRM_INCIDENT_READY',
      outcome: 'APPLIED',
      orderId: order1.id,
      routeId: route1.id,
      result: { orderId: order1.id, routeId: route1.id, attemptId },
    });

    // Exact replay returns 200 identical audit; conflicting actor/payload rejects 409; new key rejects INCIDENT_ALREADY_READY.
    expect(
      (await api('post', '/dispatch/interventions', winnerBody, winnerActor).expect(200)).body,
    ).toEqual(winnerAudit);
    await api(
      'post',
      '/dispatch/interventions',
      winnerBody,
      winnerActor === ids.admin ? ids.admin2 : ids.admin,
    ).expect(409);
    await api(
      'post',
      '/dispatch/interventions',
      { ...winnerBody, reason: 'Modified reason' },
      winnerActor,
    ).expect(409);
    expect(
      (
        await intervene({
          action: 'CONFIRM_INCIDENT_READY',
          orderId: order1.id,
          attemptId,
        }).expect(409)
      ).body.code,
    ).toBe('INCIDENT_ALREADY_READY');

    // Readiness attestation alone does not mutate order, route, or claims.
    expect(
      await db.orm.public.Order.where({ id: order1.id }).first(),
    ).toMatchObject({
      status: 'ASSIGNED',
      routeId: route1.id,
      requiresAdministrativeReview: true,
    });
    expect(
      (await db.orm.public.Route.where({ id: route1.id }).first())?.status,
    ).toBe('IN_PROGRESS');

    // Early RESCHEDULE succeeds while route1 is still IN_PROGRESS.
    await intervene({
      action: 'RESCHEDULE',
      orderId: order1.id,
      agreementId: contact.id,
    }).expect(200);
    expect(
      await db.orm.public.Order.where({ id: order1.id }).first(),
    ).toMatchObject({
      status: 'PENDING',
      routeId: null,
      stopOrder: null,
      requiresAdministrativeReview: false,
    });

    // Replan order1 onto a new route2 (driver2) while route1 is STILL IN_PROGRESS.
    // Force scheduledDeliveryDate back to today if slot crossed midnight so same-day route planning applies.
    const route2Date = slot.scheduledDeliveryDate;
    const guayaquilToday = Temporal.Now.zonedDateTimeISO('America/Guayaquil')
      .toPlainDate()
      .toString();
    const slotDay = route2Date
      .toZonedDateTimeISO('America/Guayaquil')
      .toPlainDate()
      .toString();
    if (slotDay !== guayaquilToday) {
      await db.orm.public.Order.where({ id: order1.id }).update({
        scheduledDeliveryDate: todayInstant(),
        deliveryWindowStart: null,
        deliveryWindowEnd: null,
      });
    }
    const { route: route2 } = await createAndStartRoute(
      [order1.id],
      ids.driver2,
      ids.driverUser2,
    );
    const route2ClaimBefore = await db.orm.public.OrderClaim.where({
      routeId: route2.id,
      orderId: order1.id,
    }).first();
    expect(route2ClaimBefore?.releasedAt).toBeNull();

    // Replaying the original failure on route1 succeeds and leaves route2's newer claim untouched.
    expect(
      (
        await api(
          'post',
          `/routes/${route1.id}/stops/${stop1.id}/failure`,
          failBody,
          ids.driverUser1,
          'DRIVER',
        ).expect(200)
      ).body,
    ).toEqual(failed);
    expect(
      (
        await db.orm.public.OrderClaim.where({ id: route2ClaimBefore!.id }).first()
      )?.releasedAt,
    ).toBeNull();

    // Deliver Stop 2 on route1 and complete route1 WHILE order1 is actively claimed on route2.
    await api('patch', `/orders/${order2.id}/status`, { status: 'IN_TRANSIT' }, ids.driverUser1, 'DRIVER').expect(200);
    await api('patch', `/orders/${order2.id}/status`, { status: 'DELIVERED' }, ids.driverUser1, 'DRIVER').expect(200);
    const completed1 = (
      await api('post', `/routes/${route1.id}/complete`, {}, ids.driverUser1, 'DRIVER').expect(200)
    ).body;

    // Route 1 released only order2's claim at completedAt, preserved order1's earlier failed release, and left route2's active claim untouched!
    const route1ClaimsAfterComplete = await db.orm.public.OrderClaim.where({
      routeId: route1.id,
    }).all();
    expect(
      route1ClaimsAfterComplete.find((c) => c.orderId === order1.id)?.releasedAt?.toString(),
    ).toBe(failed.recordedAt);
    expect(
      route1ClaimsAfterComplete.find((c) => c.orderId === order2.id)?.releasedAt?.toString(),
    ).toBe(completed1.completedAt);
    expect(
      (
        await db.orm.public.OrderClaim.where({ id: route2ClaimBefore!.id }).first()
      )?.releasedAt,
    ).toBeNull();

    // Route 2 finishes redelivering order1 cleanly.
    await api('patch', `/orders/${order1.id}/status`, { status: 'IN_TRANSIT' }, ids.driverUser2, 'DRIVER').expect(200);
    await api('patch', `/orders/${order1.id}/status`, { status: 'DELIVERED' }, ids.driverUser2, 'DRIVER').expect(200);
    await api('post', `/routes/${route2.id}/complete`, {}, ids.driverUser2, 'DRIVER').expect(200);
    expect((await db.orm.public.Order.where({ id: order1.id }).first())?.status).toBe('DELIVERED');
  });

  it('completes the original route even after the failed order has already been redelivered on a newer route OR picked up in store', async () => {
    const orderPickup = await seedOrder();
    const orderRedeliver = await seedOrder();
    const { route: route1, detail } = await createAndStartRoute([
      orderPickup.id,
      orderRedeliver.id,
    ]);
    const stopPickup = detail.stops.find((s: any) => s.orderId === orderPickup.id);
    const stopRedeliver = detail.stops.find((s: any) => s.orderId === orderRedeliver.id);

    const failPickup = (
      await api(
        'post',
        `/routes/${route1.id}/stops/${stopPickup.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Absent' },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;
    const failRedeliver = (
      await api(
        'post',
        `/routes/${route1.id}/stops/${stopRedeliver.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_REFUSED', context: 'Refused' },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;

    // 1. Order 1: CONFIRM_INCIDENT_READY -> PICKUP_AGREE -> PICKUP_CONFIRM (DELIVERED) while route1 is still IN_PROGRESS!
    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: orderPickup.id,
      attemptId: failPickup.id,
    }).expect(200);
    await intervene({
      action: 'PICKUP_AGREE',
      orderId: orderPickup.id,
      attemptId: failPickup.id,
    }).expect(200);
    await intervene({
      action: 'PICKUP_CONFIRM',
      orderId: orderPickup.id,
    }).expect(200);
    expect(
      (await db.orm.public.Order.where({ id: orderPickup.id }).first())?.status,
    ).toBe('DELIVERED');

    // 2. Order 2: CONFIRM_INCIDENT_READY -> CONTACT -> RESCHEDULE -> redelivered & completed on route2 while route1 is still IN_PROGRESS!
    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: orderRedeliver.id,
      attemptId: failRedeliver.id,
    }).expect(200);
    const slot = futureSlotSameOrNextDay(20);
    const contact = (
      await intervene({
        action: 'CONTACT',
        orderId: orderRedeliver.id,
        attemptId: failRedeliver.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;
    await intervene({
      action: 'RESCHEDULE',
      orderId: orderRedeliver.id,
      agreementId: contact.id,
    }).expect(200);
    await db.orm.public.Order.where({ id: orderRedeliver.id }).update({
      scheduledDeliveryDate: todayInstant(),
      deliveryWindowStart: null,
      deliveryWindowEnd: null,
    });
    const { route: route2 } = await createAndStartRoute(
      [orderRedeliver.id],
      ids.driver2,
      ids.driverUser2,
    );
    await api('patch', `/orders/${orderRedeliver.id}/status`, { status: 'IN_TRANSIT' }, ids.driverUser2, 'DRIVER').expect(200);
    await api('patch', `/orders/${orderRedeliver.id}/status`, { status: 'DELIVERED' }, ids.driverUser2, 'DRIVER').expect(200);
    await api('post', `/routes/${route2.id}/complete`, {}, ids.driverUser2, 'DRIVER').expect(200);

    // 3. Original route1 (both stops FAILED and both orders already DELIVERED elsewhere!) completes cleanly using historical evidence.
    const completed1 = (
      await api('post', `/routes/${route1.id}/complete`, {}, ids.driverUser1, 'DRIVER').expect(200)
    ).body;
    expect(completed1.status).toBe('COMPLETED');
  });

  it('invalidates stale readiness from attempt 1 when attempt 2 fails on a subsequent route', async () => {
    const order = await seedOrder();
    const { route: route1, detail: d1 } = await createAndStartRoute([order.id]);
    const fail1 = (
      await api(
        'post',
        `/routes/${route1.id}/stops/${d1.stops[0].id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Attempt 1' },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;

    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: order.id,
      attemptId: fail1.id,
    }).expect(200);
    const slot1 = futureSlotSameOrNextDay(20);
    const contact1 = (
      await intervene({
        action: 'CONTACT',
        orderId: order.id,
        attemptId: fail1.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot1.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot1.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot1.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;
    await intervene({
      action: 'RESCHEDULE',
      orderId: order.id,
      agreementId: contact1.id,
    }).expect(200);
    await db.orm.public.Order.where({ id: order.id }).update({
      scheduledDeliveryDate: todayInstant(),
      deliveryWindowStart: null,
      deliveryWindowEnd: null,
    });

    // Second route fails again -> attempt 2 is now the latest canonical failed attempt.
    const { route: route2, detail: d2 } = await createAndStartRoute(
      [order.id],
      ids.driver2,
      ids.driverUser2,
    );
    const fail2 = (
      await api(
        'post',
        `/routes/${route2.id}/stops/${d2.stops[0].id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_REFUSED', context: 'Attempt 2' },
        ids.driverUser2,
        'DRIVER',
      ).expect(200)
    ).body;

    // Readiness from fail1 is stale and MUST NOT unlock fail2.
    const slot2 = futureSlotSameOrNextDay(35);
    const contact2 = (
      await intervene({
        action: 'CONTACT',
        orderId: order.id,
        attemptId: fail2.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot2.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot2.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot2.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;
    expect(
      (
        await intervene({
          action: 'RESCHEDULE',
          orderId: order.id,
          agreementId: contact2.id,
        }).expect(409)
      ).body.code,
    ).toBe('INCIDENT_NOT_READY_AT_STORE');
    expect(
      (
        await intervene({
          action: 'PICKUP_AGREE',
          orderId: order.id,
          attemptId: fail2.id,
        }).expect(409)
      ).body.code,
    ).toBe('INCIDENT_NOT_READY_AT_STORE');
    // Attesting superseded attempt 1 is rejected.
    expect(
      (
        await intervene({
          action: 'CONFIRM_INCIDENT_READY',
          orderId: order.id,
          attemptId: fail1.id,
        }).expect(409)
      ).body.code,
    ).toBe('STALE_FAILED_ATTEMPT');

    // Attesting attempt 2 unlocks resolution for attempt 2.
    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: order.id,
      attemptId: fail2.id,
    }).expect(200);
    await intervene({
      action: 'RESCHEDULE',
      orderId: order.id,
      agreementId: contact2.id,
    }).expect(200);
  });

  it('keeps emergency custody separate from CONFIRM_INCIDENT_READY and never treats prior failed/released stops as emergency custody', async () => {
    const product = await seedProduct(10);
    const failedOrder = await seedOrder(product.id);
    const pendingOrder = await seedOrder(product.id);
    const { route, detail } = await createAndStartRoute([
      failedOrder.id,
      pendingOrder.id,
    ]);
    const failedStop = detail.stops.find((s: any) => s.orderId === failedOrder.id);

    const failedAttempt = (
      await api(
        'post',
        `/routes/${route.id}/stops/${failedStop.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Absent before emergency' },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;

    const emergency = (
      await intervene({ action: 'EMERGENCY_DECLARE', routeId: route.id }).expect(200)
    ).body;
    const emergencyId = emergency.result.emergencyId as string;

    // Prior failed/released stop has zero RouteUnitRecovery rows and preserved its earlier release timestamp.
    const recoveries = await db.orm.public.RouteUnitRecovery.where({
      emergencyId,
    }).all();
    expect(recoveries.map((u) => u.orderId)).toEqual([pendingOrder.id]);
    expect(
      (
        await db.orm.public.OrderClaim.where({
          routeId: route.id,
          orderId: failedOrder.id,
        }).first()
      )?.releasedAt?.toString(),
    ).toBe(failedAttempt.recordedAt);

    // Emergency-only order rejects CONFIRM_INCIDENT_READY both before and after unit recovery.
    expect(
      (
        await intervene({
          action: 'CONFIRM_INCIDENT_READY',
          orderId: pendingOrder.id,
          attemptId: failedAttempt.id,
        }).expect(409)
      ).body.code,
    ).toBe('RECOVERY_PENDING');

    await intervene({
      action: 'UNIT_RECOVERY_CONFIRM',
      recoveryId: recoveries[0]!.id,
    }).expect(200);

    expect(
      (
        await intervene({
          action: 'CONFIRM_INCIDENT_READY',
          orderId: pendingOrder.id,
          attemptId: failedAttempt.id,
        }).expect(409)
      ).body.code,
    ).toBe('EMERGENCY_CUSTODY_SEPARATE');

    // Emergency recovery path still works cleanly via EMERGENCY_REQUEUE.
    await intervene({
      action: 'EMERGENCY_REQUEUE',
      orderId: pendingOrder.id,
      emergencyId,
    }).expect(200);
    expect(
      (await db.orm.public.Order.where({ id: pendingOrder.id }).first())
        ?.requiresAdministrativeReview,
    ).toBe(false);

    // Meanwhile the prior failed stop resolves through CONFIRM_INCIDENT_READY + PICKUP_AGREE.
    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: failedOrder.id,
      attemptId: failedAttempt.id,
    }).expect(200);
    await intervene({
      action: 'PICKUP_AGREE',
      orderId: failedOrder.id,
      attemptId: failedAttempt.id,
    }).expect(200);
  });

  it('enforces PostgreSQL defense-in-depth guards against direct SQL bypasses, omitted-release new failures, and concurrent readiness races', async () => {
    const order = await seedOrder();
    const pending = await seedOrder();
    const { route, detail } = await createAndStartRoute([order.id, pending.id]);
    const stop1 = detail.stops.find((s: any) => s.orderId === order.id);

    // 1. Direct SQL cannot release an active claim on a PENDING stop of an IN_PROGRESS route.
    expect(() =>
      execPsqlCommand(
        database,
        `UPDATE public."orderClaim" SET "releasedAt" = NOW() WHERE "routeId" = '${route.id}' AND "orderId" = '${pending.id}' AND "releasedAt" IS NULL;`,
      ),
    ).toThrow(/Order claim may be released only/);

    // 2. Record canonical failure (releases stop1 claim), record CONTACT, then attempt raw SQL RESCHEDULE without CONFIRM_INCIDENT_READY.
    const failed = (
      await api(
        'post',
        `/routes/${route.id}/stops/${stop1.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Absent' },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;
    const slot = futureSlotSameOrNextDay(25);
    const contact = (
      await intervene({
        action: 'CONTACT',
        orderId: order.id,
        attemptId: failed.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;

    expect(() =>
      execPsqlCommand(
        database,
        `BEGIN;
         INSERT INTO public."dispatchIntervention" (id, "requestId", "actorId", "orderId", "routeId", action, reason, outcome, payload, result)
         VALUES ('${randomUUID()}', '${randomUUID()}', '${ids.admin}', '${order.id}', '${route.id}', 'RESCHEDULE', 'Direct bypass', 'APPLIED', '{"agreementId":"${contact.id}"}'::json, '{"attemptId":"${failed.id}"}'::json);
         UPDATE public."order"
         SET status = 'PENDING', "requiresAdministrativeReview" = false, "routeId" = NULL, "stopOrder" = NULL,
             "scheduledDeliveryDate" = '${slot.scheduledDeliveryDate.toString()}'::timestamptz,
             "deliveryWindowStart" = '${slot.deliveryWindowStart.toString()}'::timestamptz,
             "deliveryWindowEnd" = '${slot.deliveryWindowEnd.toString()}'::timestamptz
         WHERE id = '${order.id}';
         COMMIT;`,
      ),
    ).toThrow(/store readiness confirmation/i);

    // 3. Direct SQL cannot insert a duplicate CONFIRM_INCIDENT_READY row for the same attempt.
    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: order.id,
      attemptId: failed.id,
    }).expect(200);
    expect(() =>
      execPsqlCommand(
        database,
        `INSERT INTO public."dispatchIntervention" (id, "requestId", "actorId", "orderId", "routeId", action, reason, outcome, payload, result)
         VALUES ('${randomUUID()}', '${randomUUID()}', '${ids.admin}', '${order.id}', '${route.id}', 'CONFIRM_INCIDENT_READY', 'Direct duplicate', 'APPLIED', '{"attemptId":"${failed.id}"}'::json, '{"attemptId":"${failed.id}"}'::json);`,
      ),
    ).toThrow(/already been recorded/i);

    // 4. Scoped deferred SQL enforcement: a NEW canonical FAILED deliveryAttempt MUST atomically
    //    release its exact orderClaim in the same transaction; omitting claim release rejects with 23514.
    const omittedOrder = await seedOrder();
    const { route: omittedRoute, detail: omittedDetail } = await createAndStartRoute(
      [omittedOrder.id],
      ids.driver2,
      ids.driverUser2,
    );
    const omittedStop = omittedDetail.stops[0];
    const omittedAttemptId = randomUUID();
    const omittedPayload = JSON.stringify({
      actorId: ids.driverUser2,
      reason: 'RECIPIENT_ABSENT',
      context: 'Omitted release regression',
    });
    expect(() =>
      execPsqlCommand(
        database,
        `BEGIN;
         INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", "recordedAt", outcome, "failureReason", context, "idempotencyKey", "requestPayload")
         VALUES ('${omittedAttemptId}', '${omittedStop.id}', '${ids.driver2}', NOW(), 'FAILED', 'RECIPIENT_ABSENT', '{"description":"Omitted release regression"}'::json, '${randomUUID()}', '${omittedPayload}'::json);
         UPDATE public."routeStop" SET outcome = 'FAILED' WHERE id = '${omittedStop.id}';
         UPDATE public."order" SET "requiresAdministrativeReview" = true WHERE id = '${omittedOrder.id}';
         COMMIT;`,
      ),
    ).toThrow(/atomically release its matching order claim|23514/i);
    expect(
      await db.orm.public.DeliveryAttempt.where({ id: omittedAttemptId }).first(),
    ).toBeNull();
    expect(
      (
        await db.orm.public.OrderClaim.where({
          routeId: omittedRoute.id,
          orderId: omittedOrder.id,
        }).first()
      )?.releasedAt,
    ).toBeNull();

    // 5. DB-level uniqueness for applied CONFIRM_INCIDENT_READY under raw concurrent SQL transactions
    //    (two parallel sessions bypassing app-level order locks): strictly one commits, the other rejects.
    const failedOmitted = (
      await api(
        'post',
        `/routes/${omittedRoute.id}/stops/${omittedStop.id}/failure`,
        {
          requestId: randomUUID(),
          reason: 'RECIPIENT_ABSENT',
          context: 'Valid failure for DB uniqueness race',
        },
        ids.driverUser2,
        'DRIVER',
      ).expect(200)
    ).body;

    let markTx1Inserted!: () => void;
    const tx1Inserted = new Promise<void>((resolve) => {
      markTx1Inserted = resolve;
    });
    let releaseTx1Commit!: () => void;
    const tx1CommitBarrier = new Promise<void>((resolve) => {
      releaseTx1Commit = resolve;
    });

    const readinessPayloadJson = JSON.stringify({ attemptId: failedOmitted.id });
    const tx1Promise = db.transaction(async (tx) => {
      await tx.execute(
        db.raw.sql`
          INSERT INTO public."dispatchIntervention" (id, "requestId", "actorId", "orderId", "routeId", action, reason, outcome, payload, result)
          VALUES (${randomUUID()}, ${randomUUID()}, ${ids.admin}, ${omittedOrder.id}, ${omittedRoute.id}, 'CONFIRM_INCIDENT_READY', 'Concurrent SQL tx1', 'APPLIED', ${readinessPayloadJson}::json, ${readinessPayloadJson}::json)
        `
          .affectedCount()
          .build(),
      );
      markTx1Inserted();
      await tx1CommitBarrier;
    });

    await tx1Inserted;
    const tx2Promise = db.transaction(async (tx) => {
      await tx.execute(
        db.raw.sql`
          INSERT INTO public."dispatchIntervention" (id, "requestId", "actorId", "orderId", "routeId", action, reason, outcome, payload, result)
          VALUES (${randomUUID()}, ${randomUUID()}, ${ids.admin2}, ${omittedOrder.id}, ${omittedRoute.id}, 'CONFIRM_INCIDENT_READY', 'Concurrent SQL tx2', 'APPLIED', ${readinessPayloadJson}::json, ${readinessPayloadJson}::json)
        `
          .affectedCount()
          .build(),
      );
    });
    // Allow tx2 to pass its BEFORE INSERT trigger while tx1 is still uncommitted, then commit tx1.
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseTx1Commit();

    const [tx1Res, tx2Res] = await Promise.allSettled([tx1Promise, tx2Promise]);
    expect(tx1Res.status).toBe('fulfilled');
    expect(tx2Res.status).toBe('rejected');

    const appliedReadinessRows = await db.orm.public.DispatchIntervention.where({
      orderId: omittedOrder.id,
      action: 'CONFIRM_INCIDENT_READY',
      outcome: 'APPLIED',
    }).all();
    expect(appliedReadinessRows).toHaveLength(1);
  });

  it('blocks CONTACT/RESCHEDULE sequentially, in SQL, and under competing writes when store pickup is agreed', async () => {
    const orderSeq = await seedOrder();
    const orderRace = await seedOrder();
    const { route, detail } = await createAndStartRoute([
      orderSeq.id,
      orderRace.id,
    ]);
    const stopSeq = detail.stops.find((s: any) => s.orderId === orderSeq.id);
    const stopRace = detail.stops.find((s: any) => s.orderId === orderRace.id);

    const failSeq = (
      await api(
        'post',
        `/routes/${route.id}/stops/${stopSeq.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Absent seq' },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;
    const failRace = (
      await api(
        'post',
        `/routes/${route.id}/stops/${stopRace.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Absent race' },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;

    const slot = futureSlotSameOrNextDay(30);
    const contactSeq = (
      await intervene({
        action: 'CONTACT',
        orderId: orderSeq.id,
        attemptId: failSeq.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;
    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: orderSeq.id,
      attemptId: failSeq.id,
    }).expect(200);
    await intervene({
      action: 'PICKUP_AGREE',
      orderId: orderSeq.id,
      attemptId: failSeq.id,
    }).expect(200);

    // Sequential API guard under order lock: both CONTACT and RESCHEDULE reject with PICKUP_ALREADY_AGREED.
    expect(
      (
        await intervene({
          action: 'CONTACT',
          orderId: orderSeq.id,
          attemptId: failSeq.id,
          agreementConfirmed: false,
        }).expect(409)
      ).body.code,
    ).toBe('PICKUP_ALREADY_AGREED');
    expect(
      (
        await intervene({
          action: 'RESCHEDULE',
          orderId: orderSeq.id,
          agreementId: contactSeq.id,
        }).expect(409)
      ).body.code,
    ).toBe('PICKUP_ALREADY_AGREED');

    // Direct SQL veto: inserting CONTACT/RESCHEDULE or updating order while pending orderPickup exists fails.
    expect(() =>
      execPsqlCommand(
        database,
        `INSERT INTO public."dispatchIntervention" (id, "requestId", "actorId", "orderId", "routeId", action, reason, outcome, payload, result)
         VALUES ('${randomUUID()}', '${randomUUID()}', '${ids.admin}', '${orderSeq.id}', NULL, 'CONTACT', 'Direct SQL contact bypass', 'APPLIED', '{"attemptId":"${failSeq.id}","agreementConfirmed":false}'::json, '{"attemptId":"${failSeq.id}"}'::json);`,
      ),
    ).toThrow(/store pickup already exists|23514/i);
    expect(() =>
      execPsqlCommand(
        database,
        `BEGIN;
         INSERT INTO public."dispatchIntervention" (id, "requestId", "actorId", "orderId", "routeId", action, reason, outcome, payload, result)
         VALUES ('${randomUUID()}', '${randomUUID()}', '${ids.admin}', '${orderSeq.id}', NULL, 'RESCHEDULE', 'Direct SQL reschedule bypass', 'APPLIED', '{"agreementId":"${contactSeq.id}"}'::json, '{"attemptId":"${failSeq.id}"}'::json);
         UPDATE public."order"
         SET status = 'PENDING', "requiresAdministrativeReview" = false, "routeId" = NULL, "stopOrder" = NULL,
             "scheduledDeliveryDate" = '${slot.scheduledDeliveryDate.toString()}'::timestamptz,
             "deliveryWindowStart" = '${slot.deliveryWindowStart.toString()}'::timestamptz,
             "deliveryWindowEnd" = '${slot.deliveryWindowEnd.toString()}'::timestamptz
         WHERE id = '${orderSeq.id}';
         COMMIT;`,
      ),
    ).toThrow(/store pickup|store readiness|23514/i);

    // Competing concurrent writes: PICKUP_AGREE vs RESCHEDULE on the same ready order.
    const contactRace = (
      await intervene({
        action: 'CONTACT',
        orderId: orderRace.id,
        attemptId: failRace.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;
    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: orderRace.id,
      attemptId: failRace.id,
    }).expect(200);

    const [pickupRes, rescheduleRes] = await Promise.all([
      intervene({
        action: 'PICKUP_AGREE',
        orderId: orderRace.id,
        attemptId: failRace.id,
      }),
      intervene({
        action: 'RESCHEDULE',
        orderId: orderRace.id,
        agreementId: contactRace.id,
      }),
    ]);
    expect([pickupRes.status, rescheduleRes.status].sort((a, b) => a - b)).toEqual([
      200,
      409,
    ]);

    const finalOrder = await db.orm.public.Order.where({
      id: orderRace.id,
    }).first();
    const finalPickup = await db.orm.public.OrderPickup.where({
      orderId: orderRace.id,
    }).first();
    const appliedReschedules = await db.orm.public.DispatchIntervention.where({
      orderId: orderRace.id,
      action: 'RESCHEDULE',
      outcome: 'APPLIED',
    }).all();
    if (pickupRes.status === 200) {
      expect(finalPickup).not.toBeNull();
      expect(finalOrder?.requiresAdministrativeReview).toBe(true);
      expect(appliedReschedules).toHaveLength(0);
    } else {
      expect(finalPickup).toBeNull();
      expect(finalOrder?.requiresAdministrativeReview).toBe(false);
      expect(appliedReschedules).toHaveLength(1);
    }

    // Concurrent HTTP CONFIRM_INCIDENT_READY race on a fresh failed order: strictly one 200 and one 409.
    const raceReadyOrder = await seedOrder();
    const { route: raceRoute, detail: raceDetail } = await createAndStartRoute(
      [raceReadyOrder.id],
      ids.driver2,
      ids.driverUser2,
    );
    const raceStop = raceDetail.stops[0];
    const raceFail = (
      await api(
        'post',
        `/routes/${raceRoute.id}/stops/${raceStop.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'HTTP readiness race' },
        ids.driverUser2,
        'DRIVER',
      ).expect(200)
    ).body;
    const [r1, r2] = await Promise.all([
      intervene({
        action: 'CONFIRM_INCIDENT_READY',
        orderId: raceReadyOrder.id,
        attemptId: raceFail.id,
      }),
      intervene(
        {
          action: 'CONFIRM_INCIDENT_READY',
          orderId: raceReadyOrder.id,
          attemptId: raceFail.id,
        },
        ids.admin2,
      ),
    ]);
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.code).toBe('INCIDENT_ALREADY_READY');
  });

  it('rejects ordinary attempt-scoped CONTACT/PICKUP_DECLINE under active emergency custody and scopes inbox counts to selected emergency', async () => {
    const product = await seedProduct(10);
    const order = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      deliveryAddress: 'Av. Multi Emergency 789',
      scheduledDeliveryDate: todayInstant(),
      deliveryLat: -1.25,
      deliveryLng: -78.62,
    });
    await db.orm.public.OrderItem.create({
      orderId: order.id,
      productId: product.id,
      quantity: 2,
      price: 15,
    });

    // 1. First route fails on order -> confirmed ready -> rescheduled.
    const { route: routeFail, detail: detailFail } = await createAndStartRoute([
      order.id,
    ]);
    const stopFail = detailFail.stops[0];
    const failed1 = (
      await api(
        'post',
        `/routes/${routeFail.id}/stops/${stopFail.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'First failure' },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;
    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: order.id,
      attemptId: failed1.id,
    }).expect(200);
    const slot1 = futureSlotSameOrNextDay(25);
    const contact1 = (
      await intervene({
        action: 'CONTACT',
        orderId: order.id,
        attemptId: failed1.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot1.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot1.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot1.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;
    await intervene({
      action: 'RESCHEDULE',
      orderId: order.id,
      agreementId: contact1.id,
    }).expect(200);

    // 2. Second route hits Emergency 1 (2 units), both recovered -> requeued.
    await resetDrivers();
    const { route: routeEm1 } = await createAndStartRoute([order.id]);
    const em1 = (
      await intervene({
        action: 'EMERGENCY_DECLARE',
        routeId: routeEm1.id,
        reason: 'First emergency breakdown',
      }).expect(200)
    ).body.result.emergencyId as string;
    const em1Recoveries = await db.orm.public.RouteUnitRecovery.where({
      emergencyId: em1,
      orderId: order.id,
    }).all();
    expect(em1Recoveries).toHaveLength(2);
    for (const unit of em1Recoveries) {
      await intervene({
        action: 'UNIT_RECOVERY_CONFIRM',
        recoveryId: unit.id,
        reason: 'Recovered from emergency 1',
      }).expect(200);
    }
    await intervene({
      action: 'EMERGENCY_REQUEUE',
      orderId: order.id,
      emergencyId: em1,
      reason: 'Requeue after emergency 1',
    }).expect(200);

    // 3. Third route hits Emergency 2 (2 units); recover 1 unit (1 still pending).
    await resetDrivers();
    const { route: routeEm2 } = await createAndStartRoute([order.id]);
    const em2 = (
      await intervene({
        action: 'EMERGENCY_DECLARE',
        routeId: routeEm2.id,
        reason: 'Second emergency breakdown',
      }).expect(200)
    ).body.result.emergencyId as string;
    const em2Recoveries = await db.orm.public.RouteUnitRecovery.where({
      emergencyId: em2,
      orderId: order.id,
    }).all();
    expect(em2Recoveries).toHaveLength(2);
    await intervene({
      action: 'UNIT_RECOVERY_CONFIRM',
      recoveryId: em2Recoveries[0]!.id,
      reason: 'Recovered first unit of emergency 2',
    }).expect(200);

    // Inbox must scope emergency counts to em2 (total 2, pending 1), NOT 4 across em1 + em2.
    const inboxPending = (await api('get', '/dispatch/inbox').expect(200)).body;
    const incPending = inboxPending.incidents.find(
      (i: any) => i.orderId === order.id,
    );
    expect(incPending).toMatchObject({
      ownership: 'EMERGENCY_CUSTODY',
      status: 'EMERGENCY_CUSTODY',
      emergencyId: em2,
      emergency: {
        emergencyId: em2,
        routeId: routeEm2.id,
        recoveryResolved: false,
        pendingUnitsCount: 1,
        totalUnitsCount: 2,
      },
    });

    // Recover second unit of em2 -> now recovery is resolved, but em2 STILL owns custody.
    await intervene({
      action: 'UNIT_RECOVERY_CONFIRM',
      recoveryId: em2Recoveries[1]!.id,
      reason: 'Recovered second unit of emergency 2',
    }).expect(200);

    // Ordinary attempt-scoped CONTACT and PICKUP_DECLINE (referencing older failed1) MUST reject with EMERGENCY_CUSTODY_SEPARATE.
    expect(
      (
        await intervene({
          action: 'CONTACT',
          orderId: order.id,
          attemptId: failed1.id,
          agreementConfirmed: false,
        }).expect(409)
      ).body.code,
    ).toBe('EMERGENCY_CUSTODY_SEPARATE');
    expect(
      (
        await intervene({
          action: 'PICKUP_DECLINE',
          orderId: order.id,
          attemptId: failed1.id,
        }).expect(409)
      ).body.code,
    ).toBe('EMERGENCY_CUSTODY_SEPARATE');

    // Emergency-scoped CONTACT with em2 succeeds.
    const slot2 = futureSlotSameOrNextDay(35);
    await intervene({
      action: 'CONTACT',
      orderId: order.id,
      emergencyId: em2,
      agreementConfirmed: true,
      scheduledDeliveryDate: slot2.scheduledDeliveryDate.toString(),
      deliveryWindowStart: slot2.deliveryWindowStart.toString(),
      deliveryWindowEnd: slot2.deliveryWindowEnd.toString(),
    }).expect(200);
  });

  it('evaluates GET /dispatch/inbox agreement expiry against PostgreSQL clock_timestamp() while keeping atomic POST checks', async () => {
    const order = await seedOrder();
    const { route, detail } = await createAndStartRoute([order.id]);
    const stop = detail.stops[0];
    const failed = (
      await api(
        'post',
        `/routes/${route.id}/stops/${stop.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Expiry check' },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;
    await intervene({
      action: 'CONFIRM_INCIDENT_READY',
      orderId: order.id,
      attemptId: failed.id,
    }).expect(200);

    // Create an agreement whose deliveryWindowStart expires in ~2 seconds.
    const base = Temporal.Now.instant()
      .add({ seconds: 2 })
      .round({ smallestUnit: 'microsecond' });
    const start = base;
    const end = base.add({ seconds: 10 });
    const scheduled = base.add({ seconds: 5 });
    const contact = (
      await intervene({
        action: 'CONTACT',
        orderId: order.id,
        attemptId: failed.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: scheduled.toString(),
        deliveryWindowStart: start.toString(),
        deliveryWindowEnd: end.toString(),
      }).expect(200)
    ).body;

    // Wait until PostgreSQL clock_timestamp() passes deliveryWindowStart.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const inboxAfterExpiry = (
      await api('get', '/dispatch/inbox').expect(200)
    ).body;
    const incExpired = inboxAfterExpiry.incidents.find(
      (i: any) => i.orderId === order.id,
    );
    expect(incExpired.activeAgreementId).toBeNull();
    expect(incExpired.allowedActions.RESCHEDULE.reasonCode).toBe(
      'RESCHEDULE_AGREEMENT_REQUIRED',
    );
    // Atomic POST write check still rejects the expired agreement.
    await intervene({
      action: 'RESCHEDULE',
      orderId: order.id,
      agreementId: contact.id,
    }).expect(400);
  });

  it('projects GET /dispatch/inbox incident status, readiness, emergency ownership, and allowedActions end-to-end without PII leakage', async () => {
    const product = await seedProduct(10);
    const urgentOrder = await seedOrder(product.id);
    const ordinaryOrder = await seedOrder(product.id);
    const emergencyOrder = await seedOrder(product.id);
    const { route: route1, detail: detail1 } = await createAndStartRoute([
      ordinaryOrder.id,
      emergencyOrder.id,
    ]);
    const stop1 = detail1.stops.find((s: any) => s.orderId === ordinaryOrder.id);

    // Stop 1 fails on IN_PROGRESS route -> claim released immediately.
    const failed1 = (
      await api(
        'post',
        `/routes/${route1.id}/stops/${stop1.id}/failure`,
        {
          requestId: randomUUID(),
          reason: 'RECIPIENT_ABSENT',
          context: 'Private door note should never appear in inbox',
        },
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;

    const inboxInitial = (await api('get', '/dispatch/inbox').expect(200)).body;
    expect(inboxInitial.urgencies.some((u: any) => u.orderId === urgentOrder.id)).toBe(true);
    const incInitial = inboxInitial.incidents.find(
      (i: any) => i.orderId === ordinaryOrder.id,
    );
    expect(incInitial).toMatchObject({
      orderId: ordinaryOrder.id,
      status: 'WAITING_STORE_READINESS',
      ownership: 'FAILED_DELIVERY',
      latestFailedAttemptId: failed1.id,
      readiness: null,
      emergencyId: null,
      emergency: null,
      activeAgreementId: null,
    });
    expect(incInitial.allowedActions.CONTACT.allowed).toBe(true);
    expect(incInitial.allowedActions.CONFIRM_INCIDENT_READY.allowed).toBe(true);
    expect(incInitial.allowedActions.RESCHEDULE.reasonCode).toBe('INCIDENT_NOT_READY_AT_STORE');
    expect(incInitial.allowedActions.PICKUP_AGREE.reasonCode).toBe('INCIDENT_NOT_READY_AT_STORE');
    expect(incInitial.allowedActions.PICKUP_CONFIRM.reasonCode).toBe('PICKUP_NOT_AGREED');

    // Declare emergency on remaining Stop 2: Stop 1 stays FAILED_DELIVERY; Stop 2 becomes EMERGENCY_CUSTODY.
    const emDeclared = (
      await intervene({
        action: 'EMERGENCY_DECLARE',
        routeId: route1.id,
        reason: 'Engine breakdown during delivery',
      }).expect(200)
    ).body;
    const emergencyId = emDeclared.result.emergencyId as string;

    const inboxAfterEmergency = (await api('get', '/dispatch/inbox').expect(200)).body;
    const stop1AfterEm = inboxAfterEmergency.incidents.find(
      (i: any) => i.orderId === ordinaryOrder.id,
    );
    const stop2AfterEm = inboxAfterEmergency.incidents.find(
      (i: any) => i.orderId === emergencyOrder.id,
    );
    expect(stop1AfterEm).toMatchObject({
      ownership: 'FAILED_DELIVERY',
      status: 'WAITING_STORE_READINESS',
      emergencyId: null,
      emergency: null,
    });
    expect(stop2AfterEm).toMatchObject({
      ownership: 'EMERGENCY_CUSTODY',
      status: 'EMERGENCY_CUSTODY',
      emergencyId,
      latestFailedAttemptId: null,
      readiness: null,
      emergency: {
        emergencyId,
        routeId: route1.id,
        recoveryResolved: false,
        pendingUnitsCount: 1,
        totalUnitsCount: 1,
      },
    });
    expect(stop2AfterEm.allowedActions.CONFIRM_INCIDENT_READY.reasonCode).toBe('RECOVERY_PENDING');

    // Contact + confirm store readiness on ordinaryOrder -> CONTACTED -> READY_AT_STORE -> PENDING_PICKUP.
    const slot = futureSlotSameOrNextDay(30);
    const contact = (
      await intervene({
        action: 'CONTACT',
        orderId: ordinaryOrder.id,
        attemptId: failed1.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;

    const inboxContacted = (await api('get', '/dispatch/inbox').expect(200)).body;
    const incContacted = inboxContacted.incidents.find(
      (i: any) => i.orderId === ordinaryOrder.id,
    );
    expect(incContacted.status).toBe('CONTACTED');
    expect(incContacted.activeAgreementId).toBe(contact.id);
    expect(incContacted.allowedActions.RESCHEDULE.reasonCode).toBe('INCIDENT_NOT_READY_AT_STORE');

    const ready = (
      await intervene({
        action: 'CONFIRM_INCIDENT_READY',
        orderId: ordinaryOrder.id,
        attemptId: failed1.id,
        reason: 'Confidential warehouse bin 42',
      }).expect(200)
    ).body;

    const inboxReady = (await api('get', '/dispatch/inbox').expect(200)).body;
    const incReady = inboxReady.incidents.find(
      (i: any) => i.orderId === ordinaryOrder.id,
    );
    expect(incReady.status).toBe('READY_AT_STORE');
    expect(incReady.readiness).toEqual({
      auditId: ready.id,
      attemptId: failed1.id,
      confirmedAt: ready.recordedAt,
      confirmedById: ids.admin,
    });
    expect(incReady.allowedActions.CONFIRM_INCIDENT_READY.reasonCode).toBe('INCIDENT_ALREADY_READY');
    expect(incReady.allowedActions.RESCHEDULE.allowed).toBe(true);
    expect(incReady.allowedActions.PICKUP_AGREE.allowed).toBe(true);
    expect(JSON.stringify(inboxReady)).not.toContain(
      'Private door note should never appear in inbox',
    );
    expect(JSON.stringify(inboxReady)).not.toContain(
      'Confidential warehouse bin 42',
    );

    await intervene({
      action: 'PICKUP_AGREE',
      orderId: ordinaryOrder.id,
      attemptId: failed1.id,
    }).expect(200);
    const inboxPickup = (await api('get', '/dispatch/inbox').expect(200)).body;
    const incPickup = inboxPickup.incidents.find(
      (i: any) => i.orderId === ordinaryOrder.id,
    );
    expect(incPickup.status).toBe('PENDING_PICKUP');
    expect(incPickup.allowedActions.PICKUP_CONFIRM.allowed).toBe(true);
    expect(incPickup.allowedActions.PICKUP_AGREE.reasonCode).toBe('PICKUP_ALREADY_AGREED');
  });
});
