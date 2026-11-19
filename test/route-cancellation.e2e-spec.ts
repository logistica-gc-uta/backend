import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from '../src/prisma/contract.d';
import contractJson from '../src/prisma/contract.json' with { type: 'json' };
import {
  REALTIME_PUBLISHER,
  type RealtimeChange,
  type RealtimePublisher,
} from '../src/modules/realtime/realtime.contract.js';
import { RouteAvailabilityService } from '../src/modules/routes/route-availability.service.js';
import { RouteExecutionService } from '../src/modules/routes/route-execution.service.js';
import {
  startOwnedContainer,
  createOwnedDatabase,
  runPrismaMigrate,
  cleanupOwnedResources,
  execPsqlCommand,
} from './geolocation-migration.fixtures.js';
import { barrier, awaitHeld } from './route-claim-cancellation.fixtures.js';

jest.setTimeout(240000);

describe('Admin route cancellation before start (T2 / S2): PostgreSQL + JWT HTTP', () => {
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let dbName: string;
  const publishedBatches: Array<readonly RealtimeChange[]> = [];
  const realtimeStub: RealtimePublisher = {
    publish: jest.fn(async (changes: readonly RealtimeChange[]) => {
      publishedBatches.push(changes);
    }),
  };
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const ids = {
    admin: randomUUID(),
    admin2: randomUUID(),
    client: randomUUID(),
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
    request(app.getHttpServer())
      [method]('/api/v1' + path)
      .auth(token(sub, role), { type: 'bearer' })
      .send(body);

  const intervene = (
    body: Record<string, unknown>,
    sub = ids.admin,
    role = 'ADMIN',
  ) =>
    api(
      'post',
      '/dispatch/interventions',
      { requestId: randomUUID(), reason: 'Vehicle cannot depart', ...body },
      sub,
      role,
    );

  const now = () => Temporal.Now.instant();
  const todayGuayaquil = () =>
    Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate().toString();

  const seedOrder = async (scheduledDeliveryDate = now()) => {
    const product = await db.orm.public.Product.create({
      name: 'Bouquet ' + randomUUID().slice(0, 8),
      price: 25,
      stock: 10,
    });
    const order = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      deliveryAddress: 'Av. Cevallos 100',
      scheduledDeliveryDate,
      deliveryLat: -1.25,
      deliveryLng: -78.62,
      total: 25,
      subtotalCents: 2500n,
    });
    await db.orm.public.OrderItem.create({
      orderId: order.id,
      productId: product.id,
      quantity: 1,
      price: 25,
      unitPriceCents: 2500n,
    });
    return order;
  };

  const createAssignedRoute = async (
    orderIds: string[],
    driverId = ids.driver,
  ) => {
    const draft = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: now().toString(),
        orderIds,
      }).expect(201)
    ).body;
    await api('post', `/routes/${draft.id}/assign`, { driverId }).expect(200);
    return draft;
  };

  const expectSqlState = async (operation: PromiseLike<unknown>, expected = '23514') => {
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

  const waitForDbLockWait = async (database: string) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const count = Number(
        execPsqlCommand(
          database,
          `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0;`,
        ),
      );
      if (count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('No actual PostgreSQL lock wait observed');
  };

  beforeAll(async () => {
    startOwnedContainer();
    dbName = 'cancel_' + randomUUID().replaceAll('-', '').slice(0, 8);
    const url = createOwnedDatabase(dbName);
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    db = postgres<Contract>({ contractJson, url });

    for (const [id, role] of [
      [ids.admin, 'ADMIN'],
      [ids.admin2, 'ADMIN'],
      [ids.client, 'CLIENT'],
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
      vehicleCapacity: 6,
      isAvailable: true,
    });
    await db.orm.public.Driver.create({
      id: ids.driver2,
      userId: ids.driverUser2,
      vehicle: 'Van 2',
      vehicleCapacity: 6,
      isAvailable: true,
    });
    await db.orm.public.Zone.create({
      id: ids.zone,
      code: ids.zone,
      name: 'Central Zone',
      depotLat: -1.24,
      depotLng: -78.61,
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
      .overrideProvider(REALTIME_PUBLISHER)
      .useValue(realtimeStub)
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

  beforeEach(() => {
    publishedBatches.length = 0;
    (realtimeStub.publish as jest.Mock).mockClear();
  });

  it('cancels an ASSIGNED route before start, preserves history/driver, restores PENDING orders, releases driver hold, excludes from DRIVER own-work, and supports exact replay', async () => {
    const orderA = await seedOrder();
    const orderB = await seedOrder();
    const route = await createAssignedRoute([orderA.id, orderB.id], ids.driver);
    publishedBatches.length = 0;

    const requestId = randomUUID();
    const reason = 'El vehículo presentó falla mecánica antes de salir';

    const cancelled = (
      await api('post', '/dispatch/interventions', {
        action: 'CANCEL_ROUTE',
        requestId,
        routeId: route.id,
        reason,
      }).expect(200)
    ).body;

    expect(cancelled).toMatchObject({
      requestId,
      actorId: ids.admin,
      orderId: null,
      routeId: route.id,
      action: 'CANCEL_ROUTE',
      reason,
      outcome: 'APPLIED',
      result: expect.objectContaining({
        routeId: route.id,
        driverId: ids.driver,
        releasedOrderCount: 2,
      }),
    });

    // Persisted route state: terminal CANCELLED, driverId retained, no fabricated start/complete/return.
    const persistedRoute = await db.orm.public.Route.where({ id: route.id }).first();
    expect(persistedRoute).toMatchObject({
      id: route.id,
      status: 'CANCELLED',
      driverId: ids.driver,
      startedAt: null,
      startedById: null,
      completedAt: null,
      completedById: null,
      returnedAt: null,
      returnedById: null,
      cancelledById: ids.admin,
      cancelReason: reason,
    });
    expect(persistedRoute?.cancelledAt).not.toBeNull();

    // Stops preserved (not deleted!), claims & reservation released at cancelledAt.
    const persistedStops = await db.orm.public.RouteStop.where({ routeId: route.id }).all();
    expect(persistedStops).toHaveLength(2);
    expect(persistedStops.every((s) => s.outcome === 'PENDING')).toBe(true);

    const persistedClaims = await db.orm.public.OrderClaim.where({ routeId: route.id }).all();
    expect(persistedClaims).toHaveLength(2);
    expect(
      persistedClaims.every(
        (c) => c.releasedAt?.toString() === persistedRoute?.cancelledAt?.toString(),
      ),
    ).toBe(true);

    const persistedReservations = await db.orm.public.DriverReservation.where({
      routeId: route.id,
    }).all();
    expect(persistedReservations).toHaveLength(1);
    expect(persistedReservations[0]?.releasedAt?.toString()).toBe(
      persistedRoute?.cancelledAt?.toString(),
    );

    // Orders restored to plannable PENDING (not commercially CANCELLED).
    for (const orderId of [orderA.id, orderB.id]) {
      const order = await db.orm.public.Order.where({ id: orderId }).first();
      expect(order).toMatchObject({
        id: orderId,
        status: 'PENDING',
        routeId: null,
        stopOrder: null,
        requiresAdministrativeReview: false,
      });
    }

    // Typed post-commit realtime invalidation: route, orders, driver — no dispatch.incident.updated.
    expect(publishedBatches).toHaveLength(1);
    const changes = publishedBatches[0]!;
    expect(changes).toContainEqual({
      type: 'route.updated',
      routeId: route.id,
      status: 'CANCELLED',
    });
    expect(changes).toContainEqual({
      type: 'driver.availability.updated',
      driverId: ids.driver,
      available: true,
    });
    for (const orderId of [orderA.id, orderB.id]) {
      expect(changes).toContainEqual({
        type: 'order.status.updated',
        orderId,
        status: 'PENDING',
        requiresAdministrativeReview: false,
      });
    }
    expect(changes.some((c) => c.type === 'dispatch.incident.updated')).toBe(false);

    // Exact replay returns original audit with ZERO extra business writes and ZERO extra realtime publishes.
    publishedBatches.length = 0;
    const replayed = (
      await api('post', '/dispatch/interventions', {
        action: 'CANCEL_ROUTE',
        requestId,
        routeId: route.id,
        reason,
      }).expect(200)
    ).body;
    expect(replayed).toEqual(cancelled);
    expect(publishedBatches).toHaveLength(0);

    // Conflicting replay (different reason or different ADMIN) returns 409 with zero writes.
    await api('post', '/dispatch/interventions', {
      action: 'CANCEL_ROUTE',
      requestId,
      routeId: route.id,
      reason: 'Different reason',
    }).expect(409);
    await api(
      'post',
      '/dispatch/interventions',
      { action: 'CANCEL_ROUTE', requestId, routeId: route.id, reason },
      ids.admin2,
      'ADMIN',
    ).expect(409);
    expect(publishedBatches).toHaveLength(0);

    // Admin history retains the cancelled route with driver, stops, reason, and CANCELLED event.
    const adminDetail = (await api('get', `/routes/${route.id}`).expect(200)).body;
    expect(adminDetail).toMatchObject({
      id: route.id,
      status: 'CANCELLED',
      driverId: ids.driver,
      cancelledById: ids.admin,
      cancelReason: reason,
      startedAt: null,
      completedAt: null,
      returnedAt: null,
    });
    expect(adminDetail.driver?.id).toBe(ids.driver);
    expect(adminDetail.stops).toHaveLength(2);
    expect(adminDetail.events).toEqual([
      {
        kind: 'CANCELLED',
        actorId: ids.admin,
        recordedAt: persistedRoute?.cancelledAt?.toString(),
      },
    ]);

    // Current DRIVER own-work projection excludes cancelled routes; availability is released.
    const driverRoutes = (
      await api('get', '/drivers/me/routes', undefined, ids.driverUser, 'DRIVER').expect(200)
    ).body;
    expect(driverRoutes.some((r: { id: string }) => r.id === route.id)).toBe(false);

    const availability = (
      await api('get', '/drivers/me/availability', undefined, ids.driverUser, 'DRIVER').expect(200)
    ).body;
    expect(availability).toMatchObject({
      isAvailable: true,
      hasPersistedHolds: false,
      blockingRouteIds: [],
    });

    // Restored orders are plannable again and can be assigned to a new route with the released driver.
    const plan = (
      await api('get', `/route-proposals?date=${todayGuayaquil()}`).expect(200)
    ).body;
    const plannedOrderIds = plan.proposals.flatMap(
      (p: { orderIds: string[] }) => p.orderIds,
    );
    expect(plannedOrderIds).toEqual(expect.arrayContaining([orderA.id, orderB.id]));

    const replanned = await createAssignedRoute([orderA.id, orderB.id], ids.driver);
    expect(replanned.id).not.toBe(route.id);
    // Clean up replanned route by cancelling it too so driver stays free for subsequent tests.
    await intervene({ action: 'CANCEL_ROUTE', routeId: replanned.id }).expect(200);
  });

  it('rejects non-ADMIN, actor impersonation, invalid fields, non-eligible routes with zero writes, and preserves RELEASE_DRAFT', async () => {
    const orderDraft = await seedOrder();
    const draft = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: now().toString(),
        orderIds: [orderDraft.id],
      }).expect(201)
    ).body;

    // Unauthenticated & non-ADMIN rejected.
    await request(app.getHttpServer())
      .post('/api/v1/dispatch/interventions')
      .send({
        action: 'CANCEL_ROUTE',
        requestId: randomUUID(),
        routeId: draft.id,
        reason: 'No auth',
      })
      .expect(401);
    await intervene({ action: 'CANCEL_ROUTE', routeId: draft.id }, ids.driverUser, 'DRIVER').expect(
      403,
    );
    await intervene({ action: 'CANCEL_ROUTE', routeId: draft.id }, ids.client, 'CLIENT').expect(
      403,
    );

    // Actor impersonation / extra fields / blank reason rejected with 400.
    await intervene({
      action: 'CANCEL_ROUTE',
      routeId: draft.id,
      actorId: ids.admin2,
    }).expect(400);
    await intervene({
      action: 'CANCEL_ROUTE',
      routeId: draft.id,
      orderId: orderDraft.id,
    }).expect(400);
    await intervene({
      action: 'CANCEL_ROUTE',
      routeId: draft.id,
      reason: '   ',
    }).expect(400);

    // Unassigned DRAFT cannot use CANCEL_ROUTE (409, zero writes); RELEASE_DRAFT remains intact.
    publishedBatches.length = 0;
    await intervene({ action: 'CANCEL_ROUTE', routeId: draft.id }).expect(409);
    expect((await db.orm.public.Route.where({ id: draft.id }).first())?.status).toBe('DRAFT');
    expect(publishedBatches).toHaveLength(0);

    const releasedDraft = (
      await intervene({
        action: 'RELEASE_DRAFT',
        routeId: draft.id,
        reason: 'Releasing unassigned draft',
      }).expect(200)
    ).body;
    expect(releasedDraft.action).toBe('RELEASE_DRAFT');
    expect((await db.orm.public.Route.where({ id: draft.id }).first())?.status).toBe('DRAFT');
    expect(await db.orm.public.RouteStop.where({ routeId: draft.id }).all()).toHaveLength(0);

    // Missing route returns 404.
    await intervene({ action: 'CANCEL_ROUTE', routeId: randomUUID() }).expect(404);

    // Started IN_PROGRESS route cannot be cancelled (409, zero writes).
    const startedRoute = await createAssignedRoute([orderDraft.id], ids.driver);
    await api('post', `/routes/${startedRoute.id}/start`, {}, ids.driverUser, 'DRIVER').expect(200);
    publishedBatches.length = 0;

    await intervene({ action: 'CANCEL_ROUTE', routeId: startedRoute.id }).expect(409);
    const stillInProgress = await db.orm.public.Route.where({ id: startedRoute.id }).first();
    expect(stillInProgress).toMatchObject({
      status: 'IN_PROGRESS',
      cancelledAt: null,
      cancelledById: null,
    });
    expect(publishedBatches).toHaveLength(0);

    // Complete & return started route so driver is freed, and verify COMPLETED also rejects CANCEL_ROUTE.
    const stops = await db.orm.public.RouteStop.where({ routeId: startedRoute.id }).all();
    await api(
      'patch',
      `/orders/${orderDraft.id}/status`,
      { status: 'IN_TRANSIT' },
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    await api(
      'patch',
      `/orders/${orderDraft.id}/status`,
      { status: 'DELIVERED' },
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    expect(stops).toHaveLength(1);
    await api('post', `/routes/${startedRoute.id}/complete`, {}, ids.driverUser, 'DRIVER').expect(
      200,
    );
    await intervene({ action: 'CANCEL_ROUTE', routeId: startedRoute.id }).expect(409);
    await api('post', `/routes/${startedRoute.id}/return`, {}, ids.driverUser, 'DRIVER').expect(
      200,
    );
  });

  it('serializes CANCEL_ROUTE against POST /routes/:id/start on real PostgreSQL locks so both cannot commit', async () => {
    // Race 1: POST /routes/:id/start holds lock first; CANCEL_ROUTE waits and rejects with 409.
    const order1 = await seedOrder();
    const route1 = await createAssignedRoute([order1.id], ids.driver);
    const execution = app.get(RouteExecutionService);

    const holdStart = barrier();
    const origTx = db.transaction.bind(db);
    let interceptedStart = false;
    const txSpy = jest.spyOn(db, 'transaction').mockImplementation(async (callback) => {
      if (!interceptedStart) {
        interceptedStart = true;
        return origTx(async (tx) => {
          const origRouteUpdate = tx.orm.public.Route.where.bind(tx.orm.public.Route);
          let routeLockSeen = false;
          jest.spyOn(tx.orm.public.Route, 'where').mockImplementation((filter: any) => {
            const chain = origRouteUpdate(filter);
            if (!routeLockSeen && filter?.id === route1.id && filter?.driverId === ids.driver) {
              routeLockSeen = true;
              const origUpdate = chain.update.bind(chain);
              chain.update = async (data: any) => {
                const updated = await origUpdate(data);
                if (!data?.status) {
                  holdStart.signal();
                  await holdStart.wait;
                }
                return updated;
              };
            }
            return chain;
          });
          return callback(tx);
        });
      }
      return origTx(callback);
    });

    // Supertest requests are lazy: start each request before waiting for its database lock.
    const startPromise = api('post', `/routes/${route1.id}/start`, {}, ids.driverUser, 'DRIVER')
      .then((response) => response);
    let cancelPromise!: Promise<request.Response>;
    try {
      await awaitHeld(holdStart.held);
      cancelPromise = intervene({ action: 'CANCEL_ROUTE', routeId: route1.id })
        .then((response) => response);
      await waitForDbLockWait(dbName);
    } finally {
      holdStart.release();
      txSpy.mockRestore();
    }
    const [startRes, cancelRes] = await Promise.all([startPromise, cancelPromise]);
    expect(startRes.status).toBe(200);
    expect(cancelRes.status).toBe(409);

    const afterRace1 = await db.orm.public.Route.where({ id: route1.id }).first();
    expect(afterRace1).toMatchObject({ status: 'IN_PROGRESS', cancelledAt: null });
    expect(afterRace1?.startedAt).not.toBeNull();

    // Finish route1 to release driver1.
    await api(
      'patch',
      `/orders/${order1.id}/status`,
      { status: 'IN_TRANSIT' },
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    await api(
      'patch',
      `/orders/${order1.id}/status`,
      { status: 'DELIVERED' },
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    await api('post', `/routes/${route1.id}/complete`, {}, ids.driverUser, 'DRIVER').expect(200);
    await api('post', `/routes/${route1.id}/return`, {}, ids.driverUser, 'DRIVER').expect(200);

    // Race 2: CANCEL_ROUTE holds lock first; POST /routes/:id/start waits and rejects with 409.
    const order2 = await seedOrder();
    const route2 = await createAssignedRoute([order2.id], ids.driver2);
    const holdCancel = barrier();
    let interceptedCancel = false;
    const txSpy2 = jest.spyOn(db, 'transaction').mockImplementation(async (callback) => {
      if (!interceptedCancel) {
        interceptedCancel = true;
        return origTx(async (tx) => {
          const origDriverWhere = tx.orm.public.Driver.where.bind(tx.orm.public.Driver);
          let driverLockSeen = false;
          jest.spyOn(tx.orm.public.Driver, 'where').mockImplementation((filter: any) => {
            const chain = origDriverWhere(filter);
            if (!driverLockSeen && filter?.id === ids.driver2) {
              driverLockSeen = true;
              const origUpdate = chain.update.bind(chain);
              chain.update = async (data: any) => {
                const updated = await origUpdate(data);
                holdCancel.signal();
                await holdCancel.wait;
                return updated;
              };
            }
            return chain;
          });
          return callback(tx);
        });
      }
      return origTx(callback);
    });

    const cancel2Promise = intervene({ action: 'CANCEL_ROUTE', routeId: route2.id })
      .then((response) => response);
    let start2Promise!: Promise<request.Response>;
    try {
      await awaitHeld(holdCancel.held);
      start2Promise = api('post', `/routes/${route2.id}/start`, {}, ids.driverUser2, 'DRIVER')
        .then((response) => response);
      await waitForDbLockWait(dbName);
    } finally {
      holdCancel.release();
      txSpy2.mockRestore();
    }
    const [cancel2Res, start2Res] = await Promise.all([cancel2Promise, start2Promise]);
    expect(cancel2Res.status).toBe(200);
    expect(start2Res.status).toBe(409);
    expect(execution).toBeDefined();

    const afterRace2 = await db.orm.public.Route.where({ id: route2.id }).first();
    expect(afterRace2).toMatchObject({ status: 'CANCELLED', startedAt: null, returnedAt: null });
    expect(afterRace2?.cancelledAt).not.toBeNull();
    const order2After = await db.orm.public.Order.where({ id: order2.id }).first();
    expect(order2After).toMatchObject({ status: 'PENDING', routeId: null, stopOrder: null });
  });

  it('enforces PostgreSQL SQL guards for CANCELLED immutability, no delete, no forged cancellation, and no unauthorized claim/reservation release', async () => {
    const order = await seedOrder();
    const route = await createAssignedRoute([order.id], ids.driver);

    // 1. Direct SQL transition ASSIGNED -> CANCELLED without audited CANCEL_ROUTE intervention is rejected (23514).
    await expectSqlState(
      db.runtime().query(
        db.raw.sql`UPDATE public.route SET status = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = ${ids.admin}, "cancelReason" = 'Bypass' WHERE id = ${route.id}`
          .affectedCount()
          .build(),
      ),
    );

    // Legitimately cancel via HTTP endpoint.
    await intervene({ action: 'CANCEL_ROUTE', routeId: route.id }).expect(200);

    // 2. Cannot DELETE a CANCELLED route.
    await expectSqlState(
      db.runtime().query(db.raw.sql`DELETE FROM public.route WHERE id = ${route.id}`.affectedCount().build()),
    );

    // 3. Cannot revert CANCELLED back to ASSIGNED or fabricate startedAt/returnedAt.
    await expectSqlState(
      db.runtime().query(
        db.raw.sql`UPDATE public.route SET status = 'ASSIGNED' WHERE id = ${route.id}`
          .affectedCount()
          .build(),
      ),
    );
    await expectSqlState(
      db.runtime().query(
        db.raw.sql`UPDATE public.route SET "startedAt" = now(), "startedById" = ${ids.driverUser} WHERE id = ${route.id}`
          .affectedCount()
          .build(),
      ),
    );
    await expectSqlState(
      db.runtime().query(
        db.raw.sql`UPDATE public.route SET "returnedAt" = now(), "returnedById" = ${ids.driverUser} WHERE id = ${route.id}`
          .affectedCount()
          .build(),
      ),
    );

    // 4. Cannot mutate or delete preserved RouteStop rows on a CANCELLED route.
    const stops = await db.orm.public.RouteStop.where({ routeId: route.id }).all();
    expect(stops).toHaveLength(1);
    await expectSqlState(
      db.runtime().query(
        db.raw.sql`DELETE FROM public."routeStop" WHERE id = ${stops[0]!.id}`
          .affectedCount()
          .build(),
      ),
    );

    // 5. Cannot delete released OrderClaim or DriverReservation rows.
    const claims = await db.orm.public.OrderClaim.where({ routeId: route.id }).all();
    await expectSqlState(
      db.runtime().query(
        db.raw.sql`DELETE FROM public."orderClaim" WHERE id = ${claims[0]!.id}`
          .affectedCount()
          .build(),
      ),
    );
    const reservations = await db.orm.public.DriverReservation.where({
      routeId: route.id,
    }).all();
    await expectSqlState(
      db.runtime().query(
        db.raw.sql`DELETE FROM public."driverReservation" WHERE id = ${reservations[0]!.id}`
          .affectedCount()
          .build(),
      ),
    );
  });

  it('enforces transition-boundary SQL guard for original-order restoration on ASSIGNED->CANCELLED without blocking future replan/reassign', async () => {
    const order = await seedOrder();
    const route = await createAssignedRoute([order.id], ids.driver);
    try {
      const attemptBrokenOrderRestoration = async (
        orderStatus: 'ASSIGNED' | 'CANCELLED' | 'PENDING',
        stopOrder: number | null,
        reason: string,
      ) => {
        await expectSqlState(
          db.transaction(async (tx) => {
            const cancelledAt = now();
            await tx.orm.public.DispatchIntervention.create({
              requestId: randomUUID(),
              actorId: ids.admin,
              routeId: route.id,
              action: 'CANCEL_ROUTE',
              reason,
              outcome: 'APPLIED',
              recordedAt: cancelledAt,
              payload: {},
              result: {},
            });
            await tx.execute(
              db.raw.sql`UPDATE public.route SET status = 'CANCELLED', "cancelledAt" = ${cancelledAt.toString()}::timestamptz, "cancelledById" = ${ids.admin}, "cancelReason" = ${reason} WHERE id = ${route.id}`
                .affectedCount()
                .build(),
            );
            await tx.execute(
              db.raw.sql`UPDATE public."orderClaim" SET "releasedAt" = ${cancelledAt.toString()}::timestamptz WHERE "routeId" = ${route.id} AND "releasedAt" IS NULL`
                .affectedCount()
                .build(),
            );
            if (stopOrder === null) {
              await tx.execute(
                db.raw.sql`UPDATE public."order" SET status = ${orderStatus}, "routeId" = NULL, "stopOrder" = NULL WHERE id = ${order.id}`
                  .affectedCount()
                  .build(),
              );
            } else {
              await tx.execute(
                db.raw.sql`UPDATE public."order" SET status = ${orderStatus}, "routeId" = NULL, "stopOrder" = ${stopOrder} WHERE id = ${order.id}`
                  .affectedCount()
                  .build(),
              );
            }
            await tx.execute(
              db.raw.sql`UPDATE public."driverReservation" SET "releasedAt" = ${cancelledAt.toString()}::timestamptz WHERE "routeId" = ${route.id} AND "releasedAt" IS NULL`
                .affectedCount()
                .build(),
            );
          }),
          '23514',
        );
      };

      // Blocker 1: at the ASSIGNED->CANCELLED commit boundary, every original stop's order must be PENDING with null routeId and null stopOrder.
      await attemptBrokenOrderRestoration('ASSIGNED', null, 'Leave order ASSIGNED on cancel');
      await attemptBrokenOrderRestoration('CANCELLED', null, 'Commercially cancel order on route cancel');
      await attemptBrokenOrderRestoration('PENDING', 1, 'Leave non-null stopOrder on cancel');

      // Legitimately cancel via HTTP, then prove future replan/reassign/start/deliver of the same order is NOT blocked.
      await intervene({ action: 'CANCEL_ROUTE', routeId: route.id }).expect(200);
      const reassigned = await createAssignedRoute([order.id], ids.driver);
      await api('post', `/routes/${reassigned.id}/start`, {}, ids.driverUser, 'DRIVER').expect(200);
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
      await api('post', `/routes/${reassigned.id}/complete`, {}, ids.driverUser, 'DRIVER').expect(200);
      await api('post', `/routes/${reassigned.id}/return`, {}, ids.driverUser, 'DRIVER').expect(200);

      const deliveredOrder = await db.orm.public.Order.where({ id: order.id }).first();
      expect(deliveredOrder).toMatchObject({
        id: order.id,
        status: 'DELIVERED',
        routeId: reassigned.id,
        stopOrder: 1,
      });
      const originalCancelled = await db.orm.public.Route.where({ id: route.id }).first();
      expect(originalCancelled?.status).toBe('CANCELLED');
    } finally {
      const currentRoute = await db.orm.public.Route.where({ id: route.id }).first();
      if (currentRoute?.status === 'ASSIGNED') {
        await intervene({ action: 'CANCEL_ROUTE', routeId: route.id });
      }
    }
  });

  it('freezes route.driverId, route.zoneId, and route.date on the ASSIGNED->CANCELLED transition update itself', async () => {
    const order = await seedOrder();
    const route = await createAssignedRoute([order.id], ids.driver);
    try {
      const beforeRoute = await db.orm.public.Route.where({ id: route.id }).first();
      expect(beforeRoute).not.toBeNull();

      const attemptTransitionStructuralMutation = async (
        kind: 'driverId' | 'zoneId' | 'date',
        reason: string,
      ) => {
        await expectSqlState(
          db.transaction(async (tx) => {
            const cancelledAt = now();
            await tx.orm.public.DispatchIntervention.create({
              requestId: randomUUID(),
              actorId: ids.admin,
              routeId: route.id,
              action: 'CANCEL_ROUTE',
              reason,
              outcome: 'APPLIED',
              recordedAt: cancelledAt,
              payload: {},
              result: {},
            });
            if (kind === 'driverId') {
              await tx.execute(
                db.raw.sql`UPDATE public.route SET status = 'CANCELLED', "driverId" = ${ids.driver2}, "cancelledAt" = ${cancelledAt.toString()}::timestamptz, "cancelledById" = ${ids.admin}, "cancelReason" = ${reason} WHERE id = ${route.id}`
                  .affectedCount()
                  .build(),
              );
            } else if (kind === 'zoneId') {
              await tx.execute(
                db.raw.sql`UPDATE public.route SET status = 'CANCELLED', "zoneId" = NULL, "cancelledAt" = ${cancelledAt.toString()}::timestamptz, "cancelledById" = ${ids.admin}, "cancelReason" = ${reason} WHERE id = ${route.id}`
                  .affectedCount()
                  .build(),
              );
            } else {
              await tx.execute(
                db.raw.sql`UPDATE public.route SET status = 'CANCELLED', date = date + interval '1 day', "cancelledAt" = ${cancelledAt.toString()}::timestamptz, "cancelledById" = ${ids.admin}, "cancelReason" = ${reason} WHERE id = ${route.id}`
                  .affectedCount()
                  .build(),
              );
            }
            // Sentinel ensures rejection happened on the UPDATE itself (BEFORE UPDATE), never masked by later deferred checks.
            throw new Error(`UPDATE unexpectedly allowed mutating ${kind} during ASSIGNED->CANCELLED`);
          }),
          '23514',
        );
      };

      await attemptTransitionStructuralMutation('driverId', 'Mutate driverId on ASSIGNED->CANCELLED');
      await attemptTransitionStructuralMutation('zoneId', 'Mutate zoneId on ASSIGNED->CANCELLED');
      await attemptTransitionStructuralMutation('date', 'Mutate date on ASSIGNED->CANCELLED');

      const untouchedRoute = await db.orm.public.Route.where({ id: route.id }).first();
      expect(untouchedRoute).toMatchObject({
        status: 'ASSIGNED',
        driverId: beforeRoute?.driverId,
        zoneId: beforeRoute?.zoneId,
        cancelledAt: null,
      });
      expect(untouchedRoute?.date.toString()).toBe(beforeRoute?.date.toString());
    } finally {
      const currentRoute = await db.orm.public.Route.where({ id: route.id }).first();
      if (currentRoute?.status === 'ASSIGNED') {
        await intervene({ action: 'CANCEL_ROUTE', routeId: route.id });
      }
    }
  });

  it('serializes CANCEL_ROUTE against a competing driver reservation (POST /routes/:id/assign) on real PostgreSQL locks without double-reservation or deadlock', async () => {
    // Race A: CANCEL_ROUTE holds Driver lock first; competing POST /routes/:id/assign for the same driver waits and acquires the newly freed driver.
    const orderA = await seedOrder();
    const routeA = await createAssignedRoute([orderA.id], ids.driver);
    const orderB = await seedOrder();
    const draftB = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: now().toString(),
        orderIds: [orderB.id],
      }).expect(201)
    ).body;

    const holdCancel = barrier();
    const origTx = db.transaction.bind(db);
    let interceptedCancel = false;
    const txSpyCancel = jest.spyOn(db, 'transaction').mockImplementation(async (callback) => {
      if (!interceptedCancel) {
        interceptedCancel = true;
        return origTx(async (tx) => {
          const origDriverWhere = tx.orm.public.Driver.where.bind(tx.orm.public.Driver);
          let driverLockSeen = false;
          jest.spyOn(tx.orm.public.Driver, 'where').mockImplementation((filter: any) => {
            const chain = origDriverWhere(filter);
            if (!driverLockSeen && filter?.id === ids.driver) {
              driverLockSeen = true;
              const origUpdate = chain.update.bind(chain);
              chain.update = async (data: any) => {
                const updated = await origUpdate(data);
                holdCancel.signal();
                await holdCancel.wait;
                return updated;
              };
            }
            return chain;
          });
          return callback(tx);
        });
      }
      return origTx(callback);
    });

    const cancelAPromise = intervene({ action: 'CANCEL_ROUTE', routeId: routeA.id })
      .then((response) => response);
    let assignBPromise!: Promise<request.Response>;
    try {
      await awaitHeld(holdCancel.held);
      assignBPromise = api('post', `/routes/${draftB.id}/assign`, { driverId: ids.driver })
        .then((response) => response);
      await waitForDbLockWait(dbName);
    } finally {
      holdCancel.release();
      txSpyCancel.mockRestore();
    }
    const [cancelARes, assignBRes] = await Promise.all([cancelAPromise, assignBPromise]);
    expect(cancelARes.status).toBe(200);
    expect(assignBRes.status).toBe(200);

    const routeAAfter = await db.orm.public.Route.where({ id: routeA.id }).first();
    expect(routeAAfter).toMatchObject({ status: 'CANCELLED', driverId: ids.driver });
    const orderAAfter = await db.orm.public.Order.where({ id: orderA.id }).first();
    expect(orderAAfter).toMatchObject({ status: 'PENDING', routeId: null, stopOrder: null });
    const routeBAfter = await db.orm.public.Route.where({ id: draftB.id }).first();
    expect(routeBAfter).toMatchObject({ status: 'ASSIGNED', driverId: ids.driver });
    const orderBAfter = await db.orm.public.Order.where({ id: orderB.id }).first();
    expect(orderBAfter).toMatchObject({ status: 'ASSIGNED', routeId: draftB.id, stopOrder: 1 });

    const activeDriver1Reservations = await db.orm.public.DriverReservation.where({
      driverId: ids.driver,
      releasedAt: null,
    }).all();
    expect(activeDriver1Reservations).toHaveLength(1);
    expect(activeDriver1Reservations[0]?.routeId).toBe(draftB.id);

    // Clean up draftB so driver1 is free for subsequent tests.
    await intervene({ action: 'CANCEL_ROUTE', routeId: draftB.id }).expect(200);

    // Race B: Competing POST /routes/:id/assign holds Driver lock first; CANCEL_ROUTE waits; assign rejects 409 on active hold and CANCEL_ROUTE commits 200.
    const orderC = await seedOrder();
    const routeC = await createAssignedRoute([orderC.id], ids.driver2);
    const orderD = await seedOrder();
    const draftD = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: now().toString(),
        orderIds: [orderD.id],
      }).expect(201)
    ).body;

    const holdAssign = barrier();
    let interceptedAssign = false;
    const txSpyAssign = jest.spyOn(db, 'transaction').mockImplementation(async (callback) => {
      if (!interceptedAssign) {
        interceptedAssign = true;
        return origTx(async (tx) => {
          const origDriverWhere = tx.orm.public.Driver.where.bind(tx.orm.public.Driver);
          let driverLockSeen = false;
          jest.spyOn(tx.orm.public.Driver, 'where').mockImplementation((filter: any) => {
            const chain = origDriverWhere(filter);
            if (!driverLockSeen && filter?.id === ids.driver2 && filter?.userId === ids.driverUser2) {
              driverLockSeen = true;
              const origUpdate = chain.update.bind(chain);
              chain.update = async (data: any) => {
                const updated = await origUpdate(data);
                holdAssign.signal();
                await holdAssign.wait;
                return updated;
              };
            }
            return chain;
          });
          return callback(tx);
        });
      }
      return origTx(callback);
    });

    const assignDPromise = api('post', `/routes/${draftD.id}/assign`, { driverId: ids.driver2 })
      .then((response) => response);
    let cancelCPromise!: Promise<request.Response>;
    try {
      await awaitHeld(holdAssign.held);
      cancelCPromise = intervene({ action: 'CANCEL_ROUTE', routeId: routeC.id })
        .then((response) => response);
      await waitForDbLockWait(dbName);
    } finally {
      holdAssign.release();
      txSpyAssign.mockRestore();
    }
    const [assignDRes, cancelCRes] = await Promise.all([assignDPromise, cancelCPromise]);
    expect(assignDRes.status).toBe(409);
    expect(cancelCRes.status).toBe(200);

    const draftDAfter = await db.orm.public.Route.where({ id: draftD.id }).first();
    expect(draftDAfter).toMatchObject({ status: 'DRAFT', driverId: null });
    expect(await db.orm.public.DriverReservation.where({ routeId: draftD.id }).all()).toHaveLength(0);
    const routeCAfter = await db.orm.public.Route.where({ id: routeC.id }).first();
    expect(routeCAfter).toMatchObject({ status: 'CANCELLED', driverId: ids.driver2 });
    const orderCAfter = await db.orm.public.Order.where({ id: orderC.id }).first();
    expect(orderCAfter).toMatchObject({ status: 'PENDING', routeId: null, stopOrder: null });
    expect(
      await db.orm.public.DriverReservation.where({ driverId: ids.driver2, releasedAt: null }).all(),
    ).toHaveLength(0);

    // Clean up unassigned draftD.
    await intervene({ action: 'RELEASE_DRAFT', routeId: draftD.id, reason: 'Cleanup draft' }).expect(200);
  });

  it('rolls back all business writes, audit rows, and emits zero realtime events when a late failure occurs inside the CANCEL_ROUTE transaction', async () => {
    const order = await seedOrder();
    const route = await createAssignedRoute([order.id], ids.driver);
    publishedBatches.length = 0;

    const requestId = randomUUID();
    const reason = 'Late injected failure rollback check';
    const availability = app.get(RouteAvailabilityService);
    const origEffective = availability.effective.bind(availability);
    let sawAllInTxWritesBeforeFailure = false;

    const effectiveSpy = jest
      .spyOn(availability, 'effective')
      .mockImplementation(async (driverId, txArg, day) => {
        if (day !== undefined && txArg) {
          const inTxRoute = await txArg.orm.public.Route.where({ id: route.id }).first();
          const inTxOrder = await txArg.orm.public.Order.where({ id: order.id }).first();
          const inTxReservation = await txArg.orm.public.DriverReservation.where({
            routeId: route.id,
          }).first();
          const inTxClaim = await txArg.orm.public.OrderClaim.where({
            routeId: route.id,
          }).first();
          const inTxAudit = await txArg.orm.public.DispatchIntervention.where({
            requestId,
          }).first();
          if (
            inTxRoute?.status === 'CANCELLED' &&
            inTxOrder?.status === 'PENDING' &&
            inTxOrder?.routeId === null &&
            inTxOrder?.stopOrder === null &&
            inTxReservation?.releasedAt !== null &&
            inTxClaim?.releasedAt !== null &&
            inTxAudit?.action === 'CANCEL_ROUTE'
          ) {
            sawAllInTxWritesBeforeFailure = true;
          }
          throw new Error('Injected late cancellation failure after business and audit writes');
        }
        return origEffective(driverId, txArg, day);
      });

    try {
      await api('post', '/dispatch/interventions', {
        action: 'CANCEL_ROUTE',
        requestId,
        routeId: route.id,
        reason,
      }).expect(500);
    } finally {
      effectiveSpy.mockRestore();
    }

    expect(sawAllInTxWritesBeforeFailure).toBe(true);

    // Zero business writes persisted after rollback.
    const persistedRoute = await db.orm.public.Route.where({ id: route.id }).first();
    expect(persistedRoute).toMatchObject({
      id: route.id,
      status: 'ASSIGNED',
      driverId: ids.driver,
      cancelledAt: null,
      cancelledById: null,
      cancelReason: null,
    });
    const persistedOrder = await db.orm.public.Order.where({ id: order.id }).first();
    expect(persistedOrder).toMatchObject({
      id: order.id,
      status: 'ASSIGNED',
      routeId: route.id,
      stopOrder: 1,
    });
    const persistedStops = await db.orm.public.RouteStop.where({ routeId: route.id }).all();
    expect(persistedStops).toHaveLength(1);
    expect(persistedStops[0]?.outcome).toBe('PENDING');
    const persistedClaims = await db.orm.public.OrderClaim.where({ routeId: route.id }).all();
    expect(persistedClaims).toHaveLength(1);
    expect(persistedClaims[0]?.releasedAt).toBeNull();
    const persistedReservations = await db.orm.public.DriverReservation.where({
      routeId: route.id,
    }).all();
    expect(persistedReservations).toHaveLength(1);
    expect(persistedReservations[0]?.releasedAt).toBeNull();
    const persistedDriver = await db.orm.public.Driver.where({ id: ids.driver }).first();
    expect(persistedDriver?.isAvailable).toBe(false);

    // Zero audit rows persisted after rollback.
    expect(await db.orm.public.DispatchIntervention.where({ requestId }).first()).toBeNull();
    expect(
      await db.orm.public.DispatchIntervention.where({
        routeId: route.id,
        action: 'CANCEL_ROUTE',
      }).all(),
    ).toHaveLength(0);

    // Zero realtime events published after rollback.
    expect(publishedBatches).toHaveLength(0);

    // Retrying with the exact same requestId succeeds cleanly once the transient fault is cleared.
    await api('post', '/dispatch/interventions', {
      action: 'CANCEL_ROUTE',
      requestId,
      routeId: route.id,
      reason,
    }).expect(200);
    expect(publishedBatches).toHaveLength(1);
    expect((await db.orm.public.Route.where({ id: route.id }).first())?.status).toBe('CANCELLED');
  });
});
