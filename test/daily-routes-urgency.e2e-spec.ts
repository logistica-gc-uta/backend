import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

jest.setTimeout(120_000);

const BUSINESS_TZ = 'America/Guayaquil';

function localDay(offsetDays: number) {
  return Temporal.Now.zonedDateTimeISO(BUSINESS_TZ)
    .toPlainDate()
    .add({ days: offsetDays })
    .toString();
}

function localNoonInstant(offsetDays: number) {
  return Temporal.Now.zonedDateTimeISO(BUSINESS_TZ)
    .toPlainDate()
    .add({ days: offsetDays })
    .toZonedDateTime({ timeZone: BUSINESS_TZ, plainTime: '12:00:00' })
    .toInstant();
}

describe('Daily operational window and midnight continuity (PostgreSQL16 + HTTP)', () => {
  let receipt: ReturnType<typeof startOwnedContainer>;
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const oldSecret = process.env.JWT_SECRET;

  const ids = {
    admin: randomUUID(),
    client: randomUUID(),
    driverUser: randomUUID(),
    driver: randomUUID(),
    zone: randomUUID(),
    product: randomUUID(),
  };

  const token = (sub = ids.admin, role = 'ADMIN') =>
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
    return body ? req.send(body) : req;
  };

  beforeAll(() => {
    receipt = startOwnedContainer();
  });

  beforeEach(async () => {
    const database = `daily_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const url = createOwnedDatabase(database);
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    db = postgres<Contract>({ contractJson, url });

    for (const user of [
      {
        id: ids.admin,
        role: 'ADMIN' as const,
        name: 'Admin',
        email: `${ids.admin}@fixture.invalid`,
        password: 'fixture-password',
      },
      {
        id: ids.client,
        role: 'CLIENT' as const,
        name: 'Client',
        email: `${ids.client}@fixture.invalid`,
        password: 'fixture-password',
      },
      {
        id: ids.driverUser,
        role: 'DRIVER' as const,
        name: 'Driver',
        email: `${ids.driverUser}@fixture.invalid`,
        password: 'fixture-password',
      },
    ]) {
      await db.orm.public.User.create(user);
    }

    await db.orm.public.Driver.create({
      id: ids.driver,
      userId: ids.driverUser,
      vehicle: 'Truck',
      isAvailable: true,
    });

    await db.orm.public.Zone.create({
      id: ids.zone,
      code: 'CENTRAL',
      name: 'Central',
      depotLat: -1.2491,
      depotLng: -78.6167,
    });

    await db.orm.public.StoreCoverage.create({
      singletonKey: 'GLOBAL',
      lat: -1.2491,
      lng: -78.6167,
      coverage: {
        type: 'Polygon',
        coordinates: [
          [
            [-78.65, -1.28],
            [-78.58, -1.28],
            [-78.58, -1.22],
            [-78.65, -1.22],
            [-78.65, -1.28],
          ],
        ],
      },
    });

    await db.orm.public.Product.create({
      id: ids.product,
      name: 'Water Jug',
      price: 2.5,
      stock: 50,
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
      order: db.orm.public.Order,
      orderItem: db.orm.public.OrderItem,
      product: db.orm.public.Product,
      route: db.orm.public.Route,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
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

  afterEach(async () => {
    await app?.close();
    await db?.close();
  });

  afterAll(() => {
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
    cleanupOwnedResources();
    expect(() =>
      execFileSync('docker', ['inspect', receipt.containerId], {
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(existsSync(receipt.scratchDir)).toBe(false);
  });

  it('allows future purchases without creating routes and exposes read-only preview metadata on GET /route-proposals', async () => {
    const tomorrowDay = localDay(1);
    const tomorrowNoon = localNoonInstant(1).toString();
    const todayDay = localDay(0);

    const created = await api(
      'post',
      '/orders',
      {
        zoneId: ids.zone,
        deliveryAddress: 'Av. Cevallos 100',
        deliveryLat: -1.251,
        deliveryLng: -78.618,
        scheduledDeliveryDate: tomorrowNoon,
        items: [{ productId: ids.product, quantity: 1 }],
      },
      ids.client,
      'CLIENT',
    ).expect(201);

    expect(created.body.status).toBe('PENDING');
    expect(await db.orm.public.Route.all()).toHaveLength(0);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(0);

    const futureProposal = await api(
      'get',
      `/route-proposals?date=${tomorrowDay}`,
    ).expect(200);
    expect(futureProposal.body).toMatchObject({
      date: tomorrowDay,
      isToday: false,
      canConfirm: false,
      summary: {
        candidateOrders: 1,
        plannedOrders: 1,
      },
    });
    expect(futureProposal.body.proposals.length).toBeGreaterThanOrEqual(1);
    expect(await db.orm.public.Route.all()).toHaveLength(0);

    const rejectConfirm = await api('post', '/routes', {
      zoneId: ids.zone,
      routeDate: tomorrowNoon,
      orderIds: [created.body.id],
    }).expect(409);
    expect(rejectConfirm.body).toMatchObject({
      code: 'ROUTE_DATE_NOT_TODAY',
    });
    expect(await db.orm.public.Route.all()).toHaveLength(0);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(0);

    const todayProposal = await api(
      'get',
      `/route-proposals?date=${todayDay}`,
    ).expect(200);
    expect(todayProposal.body).toMatchObject({
      date: todayDay,
      isToday: true,
      canConfirm: true,
      summary: {
        candidateOrders: 0,
        plannedOrders: 0,
      },
    });
  });

  it('blocks assigning an expired unassigned DRAFT with 409, then releases its stops/claims via RELEASE_DRAFT for today planning', async () => {
    const yesterdayNoon = localNoonInstant(-1);
    const todayNoon = localNoonInstant(0);
    const todayDay = localDay(0);

    const order = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      status: 'PENDING',
      deliveryAddress: 'Expired Draft St',
      deliveryLat: -1.251,
      deliveryLng: -78.618,
      scheduledDeliveryDate: yesterdayNoon,
    });
    const expiredRoute = await db.transaction(async (tx) => {
      const created = await tx.orm.public.Route.create({
        zoneId: ids.zone,
        date: yesterdayNoon,
        status: 'DRAFT',
      });
      await tx.orm.public.OrderClaim.create({
        orderId: order.id,
        routeId: created.id,
        claimedAt: yesterdayNoon,
      });
      await tx.orm.public.RouteStop.create({
        routeId: created.id,
        orderId: order.id,
        sequence: 1,
        outcome: 'PENDING',
        isLegacy: false,
      });
      return created;
    });

    const assignBlocked = await api('post', `/routes/${expiredRoute.id}/assign`, {
      driverId: ids.driver,
    }).expect(409);
    expect(assignBlocked.body).toMatchObject({
      code: 'ROUTE_DATE_NOT_TODAY',
    });
    expect(await db.orm.public.DriverReservation.all()).toHaveLength(0);

    const released = await api('post', '/dispatch/interventions', {
      action: 'RELEASE_DRAFT',
      routeId: expiredRoute.id,
      requestId: randomUUID(),
      reason: 'Draft crossed operational midnight without driver assignment',
    }).expect(200);
    expect(released.body).toMatchObject({
      action: 'RELEASE_DRAFT',
      routeId: expiredRoute.id,
    });

    expect(
      await db.orm.public.RouteStop.where({ routeId: expiredRoute.id }).all(),
    ).toHaveLength(0);
    const claims = await db.orm.public.OrderClaim.where({
      routeId: expiredRoute.id,
    }).all();
    expect(claims).toHaveLength(1);
    expect(claims[0].releasedAt).not.toBeNull();
    const audits = await db.orm.public.DispatchIntervention.where({
      routeId: expiredRoute.id,
    }).all();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('RELEASE_DRAFT');

    // Once released, an order scheduled for today is immediately plannable and assignable.
    await db.orm.public.Order.where({ id: order.id }).update({
      scheduledDeliveryDate: todayNoon,
    });

    const todayProposal = await api(
      'get',
      `/route-proposals?date=${todayDay}`,
    ).expect(200);
    expect(todayProposal.body.canConfirm).toBe(true);
    expect(todayProposal.body.summary.plannedOrders).toBe(1);

    const freshDraft = await api('post', '/routes', {
      zoneId: ids.zone,
      routeDate: todayNoon.toString(),
      orderIds: [order.id],
    }).expect(201);
    const freshAssigned = await api('post', `/routes/${freshDraft.body.id}/assign`, {
      driverId: ids.driver,
    }).expect(200);
    expect(freshAssigned.body.status).toBe('ASSIGNED');
  });

  it('keeps an already ASSIGNED route crossing midnight operable through start, delivery, complete, and return', async () => {
    const yesterdayNoon = localNoonInstant(-1);
    const order = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      status: 'ASSIGNED',
      deliveryAddress: 'Overnight Assigned St',
      deliveryLat: -1.251,
      deliveryLng: -78.618,
      scheduledDeliveryDate: yesterdayNoon,
    });
    const route = await db.transaction(async (tx) => {
      const created = await tx.orm.public.Route.create({
        driverId: ids.driver,
        zoneId: ids.zone,
        date: yesterdayNoon,
        status: 'ASSIGNED',
      });
      await tx.orm.public.Order.where({ id: order.id }).update({
        routeId: created.id,
      });
      await tx.orm.public.OrderClaim.create({
        orderId: order.id,
        routeId: created.id,
        claimedAt: yesterdayNoon,
      });
      await tx.orm.public.RouteStop.create({
        routeId: created.id,
        orderId: order.id,
        sequence: 1,
        outcome: 'PENDING',
        isLegacy: false,
      });
      await tx.orm.public.Driver.where({ id: ids.driver }).update({
        isAvailable: false,
      });
      await tx.orm.public.DriverReservation.create({
        driverId: ids.driver,
        routeId: created.id,
        reservedAt: yesterdayNoon,
      });
      return created;
    });

    const started = await api(
      'post',
      `/routes/${route.id}/start`,
      undefined,
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    expect(started.body.status).toBe('IN_PROGRESS');

    await api(
      'patch',
      `/orders/${order.id}/status`,
      { status: 'IN_TRANSIT' },
      ids.driverUser,
      'DRIVER',
    ).expect(200);

    await api(
      'patch',
      `/orders/${order.id}/status`,
      { status: 'DELIVERED' },
      ids.driverUser,
      'DRIVER',
    ).expect(200);

    const completed = await api(
      'post',
      `/routes/${route.id}/complete`,
      {},
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    expect(completed.body.status).toBe('COMPLETED');

    const returned = await api(
      'post',
      `/routes/${route.id}/return`,
      {},
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    expect(returned.body).toMatchObject({
      id: route.id,
    });
    expect(returned.body.returnedAt).toBeTruthy();
    expect(
      (await db.orm.public.Driver.where({ id: ids.driver }).first())
        ?.isAvailable,
    ).toBe(true);
    expect(
      (await db.orm.public.Order.where({ id: order.id }).first())?.status,
    ).toBe('DELIVERED');
  });

  it('runs a full zone-free (zoneId null) daily lifecycle: order -> proposal -> confirm -> assign -> start -> deliver -> complete -> return', async () => {
    const todayDay = localDay(0);
    const futureToday = Temporal.Now.instant().add({ minutes: 30 });
    const futureLocal = futureToday.toZonedDateTimeISO(BUSINESS_TZ);
    const futureTime = futureLocal.toPlainTime();
    const isSameToday =
      futureLocal.toPlainDate().toString() === todayDay &&
      Temporal.PlainTime.compare(futureTime, Temporal.PlainTime.from('07:00')) >= 0 &&
      Temporal.PlainTime.compare(futureTime, Temporal.PlainTime.from('17:00')) <= 0;
    const slot = isSameToday ? futureToday : localNoonInstant(0);

    let orderId: string;
    if (isSameToday) {
      const created = await api(
        'post',
        '/orders',
        {
          deliveryAddress: 'Av. Los Chasquis 200, Ambato',
          deliveryLat: -1.251,
          deliveryLng: -78.618,
          scheduledDeliveryDate: slot.toString(),
          items: [{ productId: ids.product, quantity: 1 }],
        },
        ids.client,
        'CLIENT',
      ).expect(201);
      expect(created.body.zoneId).toBeNull();
      orderId = created.body.id;
    } else {
      const seeded = await db.orm.public.Order.create({
        userId: ids.client,
        zoneId: null,
        status: 'PENDING',
        deliveryAddress: 'Av. Los Chasquis 200, Ambato',
        deliveryLat: -1.251,
        deliveryLng: -78.618,
        scheduledDeliveryDate: slot,
      });
      orderId = seeded.id;
    }

    const proposalRes = await api(
      'get',
      `/route-proposals?date=${todayDay}`,
    ).expect(200);
    expect(proposalRes.body.canConfirm).toBe(true);
    expect(proposalRes.body.excluded).toEqual([]);
    expect(proposalRes.body.proposals).toHaveLength(1);
    const proposal = proposalRes.body.proposals[0];
    expect(proposal).toMatchObject({
      zoneId: null,
      zoneCode: null,
      depot: { lat: -1.2491, lng: -78.6167 },
      orderIds: [orderId],
    });

    // Confirm without zoneId
    const draft = await api('post', '/routes', {
      routeDate: proposal.routeDate,
      orderIds: proposal.orderIds,
    }).expect(201);
    expect(draft.body).toMatchObject({
      status: 'DRAFT',
      zoneId: null,
    });

    const assigned = await api('post', `/routes/${draft.body.id}/assign`, {
      driverId: ids.driver,
    }).expect(200);
    expect(assigned.body).toMatchObject({
      status: 'ASSIGNED',
      zoneId: null,
      driverId: ids.driver,
    });

    const started = await api(
      'post',
      `/routes/${draft.body.id}/start`,
      {},
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    expect(started.body.status).toBe('IN_PROGRESS');

    await api(
      'patch',
      `/orders/${orderId}/status`,
      { status: 'IN_TRANSIT' },
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    await api(
      'patch',
      `/orders/${orderId}/status`,
      { status: 'DELIVERED' },
      ids.driverUser,
      'DRIVER',
    ).expect(200);

    const completed = await api(
      'post',
      `/routes/${draft.body.id}/complete`,
      {},
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    expect(completed.body.status).toBe('COMPLETED');

    const returned = await api(
      'post',
      `/routes/${draft.body.id}/return`,
      {},
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    expect(returned.body.returnedAt).toBeTruthy();
    expect(
      (await db.orm.public.Driver.where({ id: ids.driver }).first())?.isAvailable,
    ).toBe(true);
    expect(
      (await db.orm.public.Order.where({ id: orderId }).first())?.status,
    ).toBe('DELIVERED');
  });

  it('handles urgent dispatch for zoneId null orders: INSERT into today DRAFT/ASSIGNED ignoring 0-stop/expired/IN_PROGRESS, NEW_ROUTE, and BLOCKED NO_AVAILABLE_DRIVER', async () => {
    const todayNoon = localNoonInstant(0);
    const yesterdayNoon = localNoonInstant(-1);

    // Second driver for IN_PROGRESS route so primary driver remains free later
    const driver2UserId = randomUUID();
    const driver2Id = randomUUID();
    await db.orm.public.User.create({
      id: driver2UserId,
      role: 'DRIVER',
      name: 'Driver 2',
      email: `${driver2UserId}@fixture.invalid`,
      password: 'fixture-password',
    });
    await db.orm.public.Driver.create({
      id: driver2Id,
      userId: driver2UserId,
      vehicle: 'Van',
      isAvailable: true,
    });

    // 1. 0-stop empty released DRAFT (today) - must be ignored
    await db.orm.public.Route.create({
      status: 'DRAFT',
      driverId: null,
      zoneId: null,
      date: todayNoon,
    });

    // 2. Expired yesterday DRAFT with 1 stop - must be ignored
    const yesterdayOrder = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: null,
      status: 'PENDING',
      deliveryAddress: 'Expired Draft St',
      deliveryLat: -1.252,
      deliveryLng: -78.619,
      scheduledDeliveryDate: yesterdayNoon,
    });
    await db.transaction(async (tx) => {
      const stale = await tx.orm.public.Route.create({
        status: 'DRAFT',
        driverId: null,
        zoneId: null,
        date: yesterdayNoon,
      });
      await tx.orm.public.OrderClaim.create({
        orderId: yesterdayOrder.id,
        routeId: stale.id,
        claimedAt: yesterdayNoon,
      });
      await tx.orm.public.RouteStop.create({
        routeId: stale.id,
        orderId: yesterdayOrder.id,
        sequence: 1,
        outcome: 'PENDING',
        isLegacy: false,
      });
    });

    // 3. Today IN_PROGRESS route with 1 stop - must be ignored
    const inProgressOrder = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: null,
      status: 'PENDING',
      deliveryAddress: 'In Progress St',
      deliveryLat: -1.253,
      deliveryLng: -78.62,
      scheduledDeliveryDate: todayNoon,
    });
    const activeDraft = await api('post', '/routes', {
      routeDate: todayNoon.toString(),
      orderIds: [inProgressOrder.id],
    }).expect(201);
    await api('post', `/routes/${activeDraft.body.id}/assign`, {
      driverId: driver2Id,
    }).expect(200);
    await api(
      'post',
      `/routes/${activeDraft.body.id}/start`,
      {},
      driver2UserId,
      'DRIVER',
    ).expect(200);

    // 4. Valid today non-empty zoneId: null DRAFT route - must be chosen for INSERT
    const draftOrder = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: null,
      status: 'PENDING',
      deliveryAddress: 'Today Draft St',
      deliveryLat: -1.25,
      deliveryLng: -78.617,
      scheduledDeliveryDate: todayNoon,
    });
    const todayDraftRes = await api('post', '/routes', {
      routeDate: todayNoon.toString(),
      orderIds: [draftOrder.id],
    }).expect(201);

    const urgentInsertOrder = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: null,
      status: 'PENDING',
      deliveryAddress: 'Urgent Insert St',
      deliveryLat: -1.251,
      deliveryLng: -78.618,
      scheduledDeliveryDate: todayNoon,
    });

    const insertProposal = await api(
      'get',
      `/dispatch/orders/${urgentInsertOrder.id}/proposal`,
    ).expect(200);
    expect(insertProposal.body).toMatchObject({
      kind: 'INSERT',
      routeId: todayDraftRes.body.id,
      zoneId: null,
    });
    expect(insertProposal.body.orderIds).toEqual(
      expect.arrayContaining([draftOrder.id, urgentInsertOrder.id]),
    );

    const confirmedInsert = await api('post', '/dispatch/interventions', {
      requestId: randomUUID(),
      action: 'CONFIRM',
      orderId: urgentInsertOrder.id,
      reason: 'Insert urgent zone-free order into today draft',
      fingerprint: insertProposal.body.fingerprint,
    }).expect(200);
    expect(confirmedInsert.body).toMatchObject({
      action: 'CONFIRM',
      outcome: 'APPLIED',
      routeId: todayDraftRes.body.id,
    });

    // 5. Assign todayDraft so we have a clean test, or fill it / release not needed:
    // Mark todayDraft COMPLETED? Instead create a separate ASSIGNED? Wait: ASSIGNED < 4 would also match INSERT.
    // Let's release todayDraft using RELEASE_DRAFT (wait: todayDraft is not expired! Instead, assign it and fill to 4 stops or mark it COMPLETED):
    // Easiest way to leave ZERO insertable routes: insert 2 more urgent orders OR assign & fill capacity 4.
    // Actually we can assign todayDraft and add 2 orders or assign a new urgent order after setting todayDraft to ASSIGNED with 4 stops? No, let's assign todayDraft to driver2? driver2 is busy; assign to ids.driver -> then ids.driver becomes busy.
    // Let's seed a NEW third driver and fill todayDraft stops directly? Better: mark todayDraft status ASSIGNED -> IN_PROGRESS is forbidden by trigger without start; simply fill stops 3 and 4 on todayDraft via RouteStop or assign + let driver2 be unavailable, and seed driver3!
    // Even simpler: use db.transaction only for 2 filler stops on todayDraft so it reaches capacity 4!
    const f3 = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: null,
      status: 'PENDING',
      deliveryAddress: 'Filler 3 St',
      deliveryLat: -1.254,
      deliveryLng: -78.621,
      scheduledDeliveryDate: todayNoon,
    });
    const f4 = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: null,
      status: 'PENDING',
      deliveryAddress: 'Filler 4 St',
      deliveryLat: -1.255,
      deliveryLng: -78.622,
      scheduledDeliveryDate: todayNoon,
    });
    await db.transaction(async (tx) => {
      await tx.orm.public.OrderClaim.create({
        orderId: f3.id,
        routeId: todayDraftRes.body.id,
        claimedAt: todayNoon,
      });
      await tx.orm.public.RouteStop.create({
        routeId: todayDraftRes.body.id,
        orderId: f3.id,
        sequence: 3,
        outcome: 'PENDING',
        isLegacy: false,
      });
      await tx.orm.public.OrderClaim.create({
        orderId: f4.id,
        routeId: todayDraftRes.body.id,
        claimedAt: todayNoon,
      });
      await tx.orm.public.RouteStop.create({
        routeId: todayDraftRes.body.id,
        orderId: f4.id,
        sequence: 4,
        outcome: 'PENDING',
        isLegacy: false,
      });
    });

    // Now no route can accept INSERT -> urgent order proposes NEW_ROUTE with zoneId: null
    const urgentNewRouteOrder = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: null,
      status: 'PENDING',
      deliveryAddress: 'Urgent New Route St',
      deliveryLat: -1.256,
      deliveryLng: -78.623,
      scheduledDeliveryDate: todayNoon,
    });
    const newRouteProposal = await api(
      'get',
      `/dispatch/orders/${urgentNewRouteOrder.id}/proposal`,
    ).expect(200);
    expect(newRouteProposal.body).toMatchObject({
      kind: 'NEW_ROUTE',
      zoneId: null,
      routeId: null,
      orderIds: [urgentNewRouteOrder.id],
      availableDriverIds: [ids.driver],
    });

    const confirmedNewRoute = await api('post', '/dispatch/interventions', {
      requestId: randomUUID(),
      action: 'CONFIRM',
      orderId: urgentNewRouteOrder.id,
      driverId: ids.driver,
      reason: 'Confirm zone-free NEW_ROUTE departure',
      fingerprint: newRouteProposal.body.fingerprint,
    }).expect(200);
    expect(confirmedNewRoute.body).toMatchObject({
      action: 'CONFIRM',
      outcome: 'APPLIED',
      orderId: urgentNewRouteOrder.id,
    });
    const createdRoute = await db.orm.public.Route.where({
      id: confirmedNewRoute.body.routeId,
    }).first();
    expect(createdRoute?.zoneId).toBeNull();
    expect(createdRoute?.status).toBe('ASSIGNED');

    // Now all drivers are reserved/unavailable and the newly created ASSIGNED route has 1 stop -> wait:
    // That newly created ASSIGNED route has 1 stop and would accept INSERT!
    // To test BLOCKED NO_AVAILABLE_DRIVER cleanly, block all drivers AND mark the newly created ASSIGNED route as full (or IN_PROGRESS via HTTP start)!
    await api(
      'post',
      `/routes/${confirmedNewRoute.body.routeId}/start`,
      {},
      ids.driverUser,
      'DRIVER',
    ).expect(200);

    const blockedOrder = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: null,
      status: 'PENDING',
      deliveryAddress: 'Blocked No Driver St',
      deliveryLat: -1.257,
      deliveryLng: -78.624,
      scheduledDeliveryDate: todayNoon,
    });
    const blockedProposal = await api(
      'get',
      `/dispatch/orders/${blockedOrder.id}/proposal`,
    ).expect(200);
    expect(blockedProposal.body).toMatchObject({
      kind: 'BLOCKED',
      zoneId: null,
      reasons: ['NO_AVAILABLE_DRIVER'],
      availableDriverIds: [],
    });
    expect(
      (await db.orm.public.Order.where({ id: blockedOrder.id }).first())?.status,
    ).toBe('PENDING');
  });
});
