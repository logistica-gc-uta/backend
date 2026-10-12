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
  RETURN_FIXTURE,
  RETURN_ROUTE,
  RETURN_DATE,
  LEGACY_ROUTE,
  LEGACY_RETURN_FIXTURE,
} from './route-return.fixtures.js';

jest.setTimeout(120_000);

describe('Depot return and availability: owned PostgreSQL16 and real JWT', () => {
  let database: string;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const oldSecret = process.env.JWT_SECRET;
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let receipt: ReturnType<typeof startOwnedContainer>;
  let Availability: any;
  const token = (sub = 'admin') =>
    jwt.sign({ sub, role: 'ADMIN', email: `${sub}@fixture.invalid` });
  const post = (path: string, body: unknown, sub = 'admin') =>
    request(app.getHttpServer())
      .post(`/api/v1/routes${path}`)
      .auth(token(sub), { type: 'bearer' })
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  const draft = (orderIds = ['pending']) =>
    post('', { zoneId: 'zone', orderIds, routeDate: RETURN_DATE });
  const assign = (id: string) => post(`/${id}/assign`, { driverId: 'driver' });

  beforeAll(() => {
    receipt = startOwnedContainer();
  });
  beforeEach(async () => {
    database = `assignment_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const url = createOwnedDatabase(database);
    runPrismaMigrate(
      url,
      '46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452',
    );
    execPsqlCommand(
      database,
      RETURN_FIXTURE +
        (expect.getState().currentTestName?.includes('unresolved legacy holds')
          ? LEGACY_RETURN_FIXTURE
          : ''),
    );
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
    const { RouteReturnService } =
      await import('../src/modules/routes/route-return.service.js');
    const { RouteAvailabilityService } =
      await import('../src/modules/routes/route-availability.service.js');
    Availability = RouteAvailabilityService;
    const { DriversController } =
      await import('../src/modules/drivers/drivers.controller.js');
    const { DriversService } =
      await import('../src/modules/drivers/drivers.service.js');
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [RoutesController, DriversController],
      providers: [
        RouteHistoryService,
        LegacyRouteReconciliationService,
        DriversService,
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
          useValue: {
            client: db,
            user: db.orm.public.User,
            driver: db.orm.public.Driver,
          },
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

  const returnRoute = (sub = 'owner', body: unknown = {}) =>
    post(`/${RETURN_ROUTE}/return`, body, sub);
  const availability = (sub = 'owner') =>
    request(app.getHttpServer())
      .get('/api/v1/drivers/me/availability')
      .auth(token(sub), { type: 'bearer' });

  it('keeps completed driver busy until physical return, with atomic matching release and replay', async () => {
    expect((await availability().expect(200)).body.isAvailable).toBe(false);
    const first = await returnRoute().expect(200);
    const route = await db.orm.public.Route.where({ id: RETURN_ROUTE }).first();
    const reservation = await db.orm.public.DriverReservation.where({
      id: 'reservation',
    }).first();
    expect(route?.returnedById).toBe('owner');
    expect(reservation?.releasedAt?.toString()).toBe(first.body.returnedAt);
    expect((await returnRoute().expect(200)).body).toEqual(first.body);
    expect((await availability().expect(200)).body).toEqual({
      isAvailable: true,
      hasPersistedHolds: false,
      compatibilityFlagBlocks: false,
      blockingRouteIds: [],
    });
    expect(await db.orm.public.RouteStop.all()).toHaveLength(0);
  });

  it('serializes two simultaneous returns with one unchanged stored audit', async () => {
    const results = await Promise.all([returnRoute(), returnRoute()]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results[0].body).toEqual(results[1].body);
    expect(await db.orm.public.DriverReservation.all()).toHaveLength(1);
    expect(
      (
        await db.orm.public.Route.where({ id: RETURN_ROUTE }).first()
      )?.returnedAt?.toString(),
    ).toBe(results[0].body.returnedAt);
  });

  it('uses actual JWT role and ownership, rejects identity spoof and malformed body', async () => {
    await returnRoute('other').expect(403);
    await returnRoute('admin').expect(403);
    await returnRoute('owner', { driverId: 'driver' }).expect(400);
    await returnRoute('owner', []).expect(400);
    await post('/not-uuid/return', {}, 'owner').expect(400);
    await request(app.getHttpServer())
      .post(`/api/v1/routes/${RETURN_ROUTE}/return`)
      .send({})
      .expect(401);
    await availability('admin').expect(403);
    await availability('other').expect(200);
    // Forged token role cannot elevate the stored DRIVER account.
    await request(app.getHttpServer())
      .get('/api/v1/drivers')
      .auth(token('owner'), { type: 'bearer' })
      .expect(403);
  });

  it('preserves unresolved legacy holds and ambiguous links after physical return', async () => {
    const legacy = { id: LEGACY_ROUTE };
    await returnRoute().expect(200);
    expect((await availability().expect(200)).body).toEqual({
      isAvailable: false,
      hasPersistedHolds: true,
      compatibilityFlagBlocks: true,
      blockingRouteIds: [legacy.id],
    });
    expect(
      (await db.orm.public.Driver.where({ id: 'driver' }).first())?.isAvailable,
    ).toBe(false);
    expect(
      (await db.orm.public.RouteStop.where({ routeId: legacy.id }).first())
        ?.sequence,
    ).toBeNull();
    expect(await db.orm.public.LegacyRouteReconciliation.all()).toHaveLength(0);
    expect(await db.orm.public.DeliveryAttempt.all()).toHaveLength(0);
  });

  it('reports an honest false-flag veto without inventing a blocking route', async () => {
    await db.orm.public.Driver.where({ id: 'other-driver' }).update({
      isAvailable: false,
    });
    expect((await availability('other').expect(200)).body).toEqual({
      isAvailable: false,
      hasPersistedHolds: false,
      compatibilityFlagBlocks: true,
      blockingRouteIds: [],
    });
    const proposal = await draft().expect(201);
    await post(`/${proposal.body.id}/assign`, {
      driverId: 'other-driver',
    }).expect(409);
  });

  it('active reservations override a true compatibility flag in owner and ADMIN reads', async () => {
    await db.orm.public.Driver.where({ id: 'driver' }).update({
      isAvailable: true,
    });
    expect((await availability().expect(200)).body.isAvailable).toBe(false);
    const drivers = await request(app.getHttpServer())
      .get('/api/v1/drivers')
      .auth(token(), { type: 'bearer' })
      .expect(200);
    expect(
      drivers.body.find((driver: any) => driver.id === 'driver'),
    ).toMatchObject({
      vehicle: 'Fixture',
      isAvailable: true,
      effectiveAvailability: { isAvailable: false },
    });
  });

  it('rolls back returned audit, reservation release and projection on post-write failure', async () => {
    const shared = app.get(Availability);
    const spy = jest
      .spyOn(shared, 'effective')
      .mockRejectedValueOnce(new Error('injected after release'));
    try {
      await returnRoute().expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(
      (await db.orm.public.Route.where({ id: RETURN_ROUTE }).first())
        ?.returnedAt,
    ).toBeNull();
    expect(
      (
        await db.orm.public.DriverReservation.where({
          id: 'reservation',
        }).first()
      )?.releasedAt,
    ).toBeNull();
    expect(
      (await db.orm.public.Driver.where({ id: 'driver' }).first())?.isAvailable,
    ).toBe(false);
    await returnRoute().expect(200);
  });

  it('makes assignment wait on actual depot-return driver lock, then sees released availability', async () => {
    const proposal = await draft().expect(201);
    await assign(proposal.body.id).expect(409);
    const shared = app.get(Availability);
    const original = shared.effective.bind(shared);
    let signal!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest
      .spyOn(shared, 'effective')
      .mockImplementationOnce(async (...args: any[]) => {
        signal();
        await barrier;
        return original(...args);
      });
    const returning = returnRoute().then((response) => response);
    await held;
    let settled = false;
    const assigning = assign(proposal.body.id).then((response) => {
      settled = true;
      return response;
    });
    try {
      let waiting = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && waiting === 0) {
        waiting = Number(
          execPsqlCommand(
            database,
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%driver%';",
          ),
        );
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBeGreaterThan(0);
      expect(settled).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
    expect((await returning).status).toBe(200);
    expect((await assigning).status).toBe(200);
    expect((await availability().expect(200)).body.isAvailable).toBe(false);
  });

  it('publishes real typed return and availability Swagger without reconciliation fiction', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(
      document.paths['/api/v1/routes/{id}/return'].post?.responses['200'],
    ).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/RouteReturnResponseDto' },
        },
      },
    });
    expect(document.paths['/api/v1/drivers/me/availability'].get).toBeDefined();
    expect(
      document.paths['/api/v1/routes/{id}/reconcile'].post?.responses['200'],
    ).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/RouteReconciliationResponseDto',
          },
        },
      },
    });
  });
});
