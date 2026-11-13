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
});
