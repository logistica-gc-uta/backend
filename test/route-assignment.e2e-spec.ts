import { RouteHistoryService } from '../src/modules/routes/route-history.service.js';
import { LegacyRouteReconciliationService } from '../src/modules/routes/legacy-route-reconciliation.service.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from '../src/prisma/contract.d';
import contractJson from '../src/prisma/contract.json' with { type: 'json' };
import {
  startOwnedContainer,
  createOwnedDatabase,
  runPrismaMigrate,
  execPsqlCommand,
  cleanupOwnedResources,
} from './geolocation-migration.fixtures.js';
import {
  ASSIGNMENT_FIXTURE,
  PROPOSAL_DATE,
} from './route-assignment.fixtures.js';

jest.setTimeout(120_000);

describe('Confirmed draft and assignment: owned PostgreSQL16 and real JWT', () => {
  let database: string;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const oldSecret = process.env.JWT_SECRET;
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let receipt: ReturnType<typeof startOwnedContainer>;
  let Service: any;
  let Availability: any;
  const token = (sub = 'admin') =>
    jwt.sign({ sub, role: 'ADMIN', email: `${sub}@fixture.invalid` });
  const post = (path: string, body: unknown, sub = 'admin') =>
    request(app.getHttpServer())
      .post(`/api/v1/routes${path}`)
      .auth(token(sub), { type: 'bearer' })
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  const draft = (orderIds = ['one']) =>
    post('', { zoneId: 'zone', orderIds, routeDate: PROPOSAL_DATE });
  const assign = (id: string) => post(`/${id}/assign`, { driverId: 'driver' });

  beforeAll(() => {
    receipt = startOwnedContainer();
  });
  beforeEach(async () => {
    database = `assignment_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const url = createOwnedDatabase(database);
    runPrismaMigrate(url);
    db = postgres<Contract>({ contractJson, url });
    process.env.JWT_SECRET = secret;
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { RoutesController } =
      await import('../src/modules/routes/routes.controller.js');
    const { RoutesService } =
      await import('../src/modules/routes/routes.service.js');
    const { RouteAssignmentService } =
      await import('../src/modules/routes/route-assignment.service.js');
    const { RouteExecutionService } =
      await import('../src/modules/routes/route-execution.service.js');
    const { JwtStrategy } = await import('../src/modules/auth/jwt.strategy.js');
    const { JwtAuthGuard } =
      await import('../src/modules/auth/guards/jwt-auth.guard.js');
    const { RolesGuard } =
      await import('../src/modules/auth/guards/roles.guard.js');
    const { RouteProgressService } =
      await import('../src/modules/routes/route-progress.service.js');
    Service = RouteAssignmentService;
    const { RouteReturnService } =
      await import('../src/modules/routes/route-return.service.js');
    const { RouteAvailabilityService } =
      await import('../src/modules/routes/route-availability.service.js');
    Availability = RouteAvailabilityService;
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [RoutesController],
      providers: [
        RouteHistoryService,
        LegacyRouteReconciliationService,
        RouteProgressService,
        RouteReturnService,
        RouteAvailabilityService,
        RoutesService,
        RouteAssignmentService,
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        {
          provide: PrismaService,
          useValue: { client: db, user: db.orm.public.User },
        },
        { provide: RouteExecutionService, useValue: {} },
      ],
    }).compile();
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
    execPsqlCommand(database, ASSIGNMENT_FIXTURE);
  });
  afterEach(async () => {
    await app?.close();
    await db?.close();
  });
  afterAll(async () => {
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

  it('persists ordered DRAFT claims without reservation or commercial assignment, then assigns', async () => {
    const result = await draft(['two', 'one']).expect(201);
    expect(result.body).toMatchObject({
      status: 'DRAFT',
      driverId: null,
      zoneId: 'zone',
    });
    expect(await db.orm.public.DriverReservation.all()).toHaveLength(0);
    const stops = await db.orm.public.RouteStop.where({
      routeId: result.body.id,
    })
      .orderBy((stop) => stop.sequence.asc())
      .all();
    expect(
      stops.map((stop) => [stop.orderId, stop.sequence, stop.outcome]),
    ).toEqual([
      ['two', 1, 'PENDING'],
      ['one', 2, 'PENDING'],
    ]);
    expect(
      (await db.orm.public.Order.where({ id: 'one' }).first())?.status,
    ).toBe('PENDING');
    const assigned = await assign(result.body.id).expect(200);
    expect(assigned.body).toMatchObject({
      id: result.body.id,
      status: 'ASSIGNED',
      driverId: 'driver',
      date: result.body.date,
      createdAt: result.body.createdAt,
    });
    const claims = await db.orm.public.OrderClaim.where({
      routeId: result.body.id,
    }).all();
    expect(claims).toHaveLength(2);
    expect(
      claims.every(
        (claim) => claim.claimedAt !== null && claim.releasedAt === null,
      ),
    ).toBe(true);
    expect(
      await db.orm.public.Order.where({ id: 'one' }).first(),
    ).toMatchObject({
      routeId: result.body.id,
      status: 'ASSIGNED',
      stopOrder: 2,
    });
    expect(
      (await db.orm.public.Driver.where({ id: 'driver' }).first())?.isAvailable,
    ).toBe(false);
  });
  it('allows only one concurrent DRAFT proposal for the same order', async () => {
    const results = await Promise.all([draft(), draft()]);
    expect(
      results.map((result) => result.status).sort((a, b) => a - b),
    ).toEqual([201, 409]);
    expect(await db.orm.public.Route.all()).toHaveLength(1);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(1);
  });
  it('allows only one concurrent assignment for a shared driver', async () => {
    const a = await draft(['one']).expect(201);
    const b = await draft(['two']).expect(201);
    const results = await Promise.all([assign(a.body.id), assign(b.body.id)]);
    expect(
      results.map((result) => result.status).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    expect(
      await db.orm.public.DriverReservation.where({ releasedAt: null }).all(),
    ).toHaveLength(1);
  });
  it.each([null, 'IN_PROGRESS', 'COMPLETED'])(
    'rejects driver hold %s despite true availability',
    async (status) => {
      if (status !== null && status !== 'IN_PROGRESS' && status !== 'COMPLETED') {
        throw new Error(`Unexpected driver hold status: ${status}`);
      }
      const result = await draft().expect(201);
      const busyRouteId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.orm.public.Route.create({
          id: busyRouteId,
          driverId: 'driver',
          zoneId: 'zone',
          status,
          ...(status === 'IN_PROGRESS'
            ? { startedAt: Temporal.Now.instant(), startedById: 'driver-user' }
            : {}),
          ...(status === 'COMPLETED'
            ? {
                startedAt: Temporal.Now.instant(),
                startedById: 'driver-user',
                completedAt: Temporal.Now.instant(),
                completedById: 'driver-user',
              }
            : {}),
        });
        if (status) {
          await tx.orm.public.DriverReservation.create({
            id: randomUUID(),
            routeId: busyRouteId,
            driverId: 'driver',
            reservedAt: Temporal.Now.instant(),
          });
        }
      });
      await assign(result.body.id).expect(409);
      expect(
        await db.orm.public.DriverReservation.where({ routeId: result.body.id }).all(),
      ).toHaveLength(0);
      expect(
        (await db.orm.public.Route.where({ id: result.body.id }).first())
          ?.status,
      ).toBe('DRAFT');
    },
  );
  it('serializes assignment against busy-return mutation using the driver lock', async () => {
    const result = await draft().expect(201);
    const busyRouteId = randomUUID();
    let busy: any;
    await db.transaction(async (tx) => {
      busy = await tx.orm.public.Route.create({
        id: busyRouteId,
        driverId: 'driver',
        zoneId: 'zone',
        status: 'COMPLETED',
        startedAt: Temporal.Now.instant(),
        startedById: 'driver-user',
        completedAt: Temporal.Now.instant(),
        completedById: 'driver-user',
      });
      await tx.orm.public.DriverReservation.create({
        id: randomUUID(),
        routeId: busyRouteId,
        driverId: 'driver',
        reservedAt: Temporal.Now.instant(),
      });
    });
    let locked!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await tx.orm.public.Driver.where({ id: 'driver' }).update({
        isAvailable: true,
      });
      locked();
      await barrier;
      const returnTime = Temporal.Now.instant();
      await tx.orm.public.Route.where({ id: busy.id }).update({
        returnedAt: returnTime,
        returnedById: 'driver-user',
      });
      await tx.orm.public.DriverReservation.where({ routeId: busy.id, releasedAt: null }).update({
        releasedAt: returnTime,
      });
    });
    await held;
    let settled = false;
    const assignment = assign(result.body.id).then((response) => {
      settled = true;
      return response;
    });
    let waiting = 0;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && waiting === 0) {
        waiting = Number(
          execPsqlCommand(
            database,
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%driver%';",
          ),
        );
        if (waiting === 0)
          await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBeGreaterThan(0);
      expect(settled).toBe(false);
    } finally {
      release();
    }
    await writer;
    expect((await assignment).status).toBe(200);
  });
  it.each(['zone', 'review', 'status', 'null-date', 'different-date'])(
    'rejects ineligible proposal %s without partial DRAFT',
    async (kind) => {
      const change: any = {};
      if (kind === 'zone') change.zoneId = 'other-zone';
      if (kind === 'review') change.requiresAdministrativeReview = true;
      if (kind === 'status') change.status = 'CANCELLED';
      if (kind === 'null-date') change.scheduledDeliveryDate = null;
      if (kind === 'different-date')
        change.scheduledDeliveryDate = Temporal.Instant.from(
          '2026-10-11T00:00:00Z',
        );
      await db.orm.public.Order.where({ id: 'one' }).update(change);
      await draft().expect(409);
      expect(await db.orm.public.Route.all()).toHaveLength(0);
      expect(await db.orm.public.OrderClaim.all()).toHaveLength(0);
    },
  );
  it('confirms and assigns orders scheduled at different hours of the same America/Guayaquil day', async () => {
    // PROPOSAL_DATE is 19:00 local on 2026-10-09; 03:00Z is 22:00 local the same day.
    await db.orm.public.Order.where({ id: 'two' }).update({
      scheduledDeliveryDate: Temporal.Instant.from('2026-10-10T03:00:00Z'),
    });
    const confirmed = await draft(['one', 'two']).expect(201);
    expect(confirmed.body.status).toBe('DRAFT');
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(2);
    await assign(confirmed.body.id).expect(200);
    const two = await db.orm.public.Order.where({ id: 'two' }).first();
    expect(two?.status).toBe('ASSIGNED');
    expect(two?.scheduledDeliveryDate?.toString()).toBe('2026-10-10T03:00:00Z');
  });
  it('rejects an order scheduled one second into the next local day without partial DRAFT', async () => {
    // 05:00:00Z is 00:00:00 local on 2026-10-10, a different business day than PROPOSAL_DATE.
    await db.orm.public.Order.where({ id: 'one' }).update({
      scheduledDeliveryDate: Temporal.Instant.from('2026-10-10T05:00:00Z'),
    });
    await draft().expect(409);
    expect(await db.orm.public.Route.all()).toHaveLength(0);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(0);
  });
  it('enforces maximum four, uniqueness, timestamp, JWT ADMIN and body whitelist', async () => {
    await draft(['one', 'two', 'three', 'four']).expect(201);
    await draft(['one', 'two', 'three', 'four', 'five']).expect(400);
    await draft(['five', 'five']).expect(400);
    const body = {
      zoneId: 'zone',
      orderIds: ['five'],
      routeDate: PROPOSAL_DATE,
    };
    await request(app.getHttpServer())
      .post('/api/v1/routes')
      .send(body)
      .expect(401);
    await post('', body, 'driver-user').expect(403);
    await post('', { ...body, actor: 'admin' }).expect(400);
    await post('', { ...body, routeDate: '2026-10-10' }).expect(400);
    await post('/not-a-uuid/assign', { driverId: 'driver' }).expect(400);
  });
  it('rolls back reservation, lifecycle, order assignment and availability on post-write failure', async () => {
    const result = await draft().expect(201);
    const failing = new Service(
      {
        client: {
          transaction: (fn: any) =>
            db.transaction(async (tx) => {
              await fn(tx);
              throw new Error('injected rollback');
            }),
        },
      },
      app.get(Availability),
    );
    await expect(
      failing.assignDraft(result.body.id, { driverId: 'driver' }, 'admin'),
    ).rejects.toThrow('injected rollback');
    expect(await db.orm.public.DriverReservation.all()).toHaveLength(0);
    expect(
      (await db.orm.public.Route.where({ id: result.body.id }).first())?.status,
    ).toBe('DRAFT');
    expect(
      (await db.orm.public.Order.where({ id: 'one' }).first())?.status,
    ).toBe('PENDING');
    expect(
      (await db.orm.public.Driver.where({ id: 'driver' }).first())?.isAvailable,
    ).toBe(true);
  });
  it('maps actual reservation unique violations to a conflict without changing state', async () => {
    const result = await draft().expect(201);
    await assign(result.body.id).expect(200);
    const colliding = new Service({
      client: {
        transaction: (fn: any) =>
          db.transaction(async (tx) => {
            await tx.orm.public.DriverReservation.create({
              driverId: 'driver',
              routeId: result.body.id,
              reservedAt: Temporal.Now.instant(),
            });
            return fn(tx);
          }),
      },
    });
    await expect(
      colliding.assignDraft(result.body.id, { driverId: 'driver' }, 'admin'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.orm.public.DriverReservation.all()).toHaveLength(1);
  });
  it('preserves missing-zone404 before checking order-zone mismatch', async () => {
    await post('/assign', {
      driverId: 'driver',
      zoneId: 'missing-zone',
      orderIds: ['one'],
    }).expect(404);
    expect(await db.orm.public.Route.all()).toHaveLength(0);
  });
  it('rejects legacy wrong-zone input with400 and no persisted proposal', async () => {
    await db.orm.public.Order.where({ id: 'one' }).update({
      zoneId: 'other-zone',
    });
    await post('/assign', {
      driverId: 'driver',
      zoneId: 'zone',
      orderIds: ['one'],
    }).expect(400);
    expect(await db.orm.public.Route.all()).toHaveLength(0);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(0);
  });
  it('restores legacy wrapper as one atomic confirmed assignment', async () => {
    const result = await post('/assign', {
      driverId: 'driver',
      zoneId: 'zone',
      orderIds: ['one', 'two'],
    }).expect(201);
    expect(result.body).toMatchObject({
      status: 'ASSIGNED',
      driverId: 'driver',
      zoneId: 'zone',
      date: PROPOSAL_DATE,
    });
    expect(await db.orm.public.Route.all()).toHaveLength(1);
    expect(await db.orm.public.DriverReservation.all()).toHaveLength(1);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(2);
  });
  const legacy = (orderIds = ['one'], driverId = 'driver') =>
    post('/assign', { driverId, zoneId: 'zone', orderIds });
  const contend = async (
    model: 'Driver' | 'Order',
    id: string,
    calls: Array<() => ReturnType<typeof legacy>>,
  ) => {
    let signal!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      if (model === 'Driver') {
        await tx.orm.public.Driver.where({ id }).update({ id });
      } else {
        await tx.orm.public.Order.where({ id }).update({ id });
      }
      signal();
      await barrier;
    });
    await held;
    let settled = 0;
    const requests = calls.map((call) =>
      call().then((response) => {
        settled++;
        return response;
      }),
    );
    try {
      let waiting = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && waiting < 2) {
        waiting = Number(
          execPsqlCommand(
            database,
            `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%${model.toLowerCase()}%';`,
          ),
        );
        if (waiting < 2)
          await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBeGreaterThanOrEqual(2);
      expect(settled).toBe(0);
    } finally {
      release();
    }
    await holder;
    return Promise.all(requests);
  };
  it.each(['null', 'mismatch'])(
    'rejects legacy %s date without orphan route or claims',
    async (kind) => {
      await db.orm.public.Order.where({ id: 'two' }).update({
        scheduledDeliveryDate:
          kind === 'null'
            ? null
            : Temporal.Instant.from('2026-10-11T00:00:00Z'),
      });
      await legacy(['one', 'two']).expect(409);
      expect(await db.orm.public.Route.all()).toHaveLength(0);
      expect(await db.orm.public.OrderClaim.all()).toHaveLength(0);
    },
  );
  it('requires real ADMIN JWT and rejects spoofed actors', async () => {
    const body = { driverId: 'driver', zoneId: 'zone', orderIds: ['one'] };
    await request(app.getHttpServer())
      .post('/api/v1/routes/assign')
      .send(body)
      .expect(401);
    await post('/assign', body, 'driver-user').expect(403);
    await post('/assign', { ...body, actorId: 'admin' }).expect(400);
  });
  it('serializes competing compatibility assignments for one driver', async () => {
    const results = await contend('Driver', 'driver', [
      () => legacy(['one']),
      () => legacy(['two']),
    ]);
    expect(
      results.map((result) => result.status).sort((a, b) => a - b),
    ).toEqual([201, 409]);
    expect(await db.orm.public.Route.all()).toHaveLength(1);
    expect(await db.orm.public.DriverReservation.all()).toHaveLength(1);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(1);
  });
  it('serializes competing compatibility claims for the same order', async () => {
    await db.orm.public.User.create({
      id: 'second-user',
      name: 'Second',
      email: 'second@fixture.invalid',
      password: 'fixture',
      role: 'DRIVER',
    });
    await db.orm.public.Driver.create({
      id: 'second-driver',
      userId: 'second-user',
      vehicle: 'Fixture',
      isAvailable: true,
    });
    const results = await contend('Order', 'one', [
      () => legacy(),
      () => legacy(['one'], 'second-driver'),
    ]);
    expect(
      results.map((result) => result.status).sort((a, b) => a - b),
    ).toEqual([201, 409]);
    expect(await db.orm.public.Route.all()).toHaveLength(1);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(1);
  });
  it('keeps an unreturned completed driver unavailable to compatibility requests', async () => {
    const busyRouteId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.orm.public.Route.create({
        id: busyRouteId,
        driverId: 'driver',
        zoneId: 'zone',
        status: 'COMPLETED',
        startedAt: Temporal.Now.instant(),
        startedById: 'driver-user',
        completedAt: Temporal.Now.instant(),
        completedById: 'driver-user',
      });
      await tx.orm.public.DriverReservation.create({
        id: randomUUID(),
        routeId: busyRouteId,
        driverId: 'driver',
        reservedAt: Temporal.Now.instant(),
      });
    });
    await legacy().expect(409);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(0);
  });
  it('rolls back confirmation and assignment together on post-assignment exception', async () => {
    const failing = new Service(
      {
        client: {
          transaction: (fn: any) =>
            db.transaction(async (tx) => {
              await fn(tx);
              throw new Error('injected wrapper rollback');
            }),
        },
      },
      app.get(Availability),
    );
    await expect(
      failing.assignLegacy(
        { driverId: 'driver', zoneId: 'zone', orderIds: ['one'] },
        'admin',
      ),
    ).rejects.toThrow('injected wrapper rollback');
    expect(await db.orm.public.Route.all()).toHaveLength(0);
    expect(await db.orm.public.OrderClaim.all()).toHaveLength(0);
    expect(await db.orm.public.DriverReservation.all()).toHaveLength(0);
    expect(
      (await db.orm.public.Order.where({ id: 'one' }).first())?.status,
    ).toBe('PENDING');
    expect(
      (await db.orm.public.Driver.where({ id: 'driver' }).first())?.isAvailable,
    ).toBe(true);
  });
  it('publishes real confirmation/assignment paths and constrained response schemas', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(
      document.paths['/api/v1/routes'].post?.responses['201'],
    ).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/RouteAssignmentResponseDto' },
        },
      },
    });
    expect(
      document.paths['/api/v1/routes/{id}/assign'].post?.responses['200'],
    ).toBeDefined();
    expect(document.components?.schemas?.ConfirmDraftRouteDto).toMatchObject({
      required: ['zoneId', 'routeDate', 'orderIds'],
      properties: { orderIds: { maxItems: 4, minItems: 1, uniqueItems: true } },
    });
  });
});
