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
  LEGACY_A,
  LEGACY_B,
  DRIVERLESS,
  OTHER_LEGACY,
  VERIFIED,
  LEGACY_PAYLOAD,
  LEGACY_RECONCILIATION_FIXTURE,
} from './route-legacy-reconciliation.fixtures.js';
jest.setTimeout(120_000);

describe('Legacy reconciliation: owned PostgreSQL16 and real JWT', () => {
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
    execPsqlCommand(database, LEGACY_RECONCILIATION_FIXTURE);
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
            route: db.orm.public.Route,
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

  const reconcile = (
    id = LEGACY_A,
    body: unknown = LEGACY_PAYLOAD,
    actor = 'admin',
  ) => post(`/${id}/reconcile`, body, actor);
  const stable = (rows: { id: string }[]) =>
    JSON.parse(
      JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id))),
    ) as unknown;
  const state = async () => ({
    routes: stable(await db.orm.public.Route.all()),
    stops: stable(await db.orm.public.RouteStop.all()),
    orders: stable(await db.orm.public.Order.all()),
    claims: stable(await db.orm.public.OrderClaim.all()),
  });

  it('preserves every ambiguous association, position, status and historical timestamp', async () => {
    const before = await state();
    const original = await db.orm.public.DriverReservation.where({
      id: 'legacy-reservation',
    }).first();
    const result = await reconcile().expect(200);
    expect(result.body.audit).toMatchObject({
      routeId: LEGACY_A,
      administratorId: 'admin',
      reason: LEGACY_PAYLOAD.reason,
      evidence: { evidence: LEGACY_PAYLOAD.evidence },
      releaseDriverHold: true,
    });
    expect(await state()).toEqual(before);
    const released = await db.orm.public.DriverReservation.where({
      id: 'legacy-reservation',
    }).first();
    expect(released).toMatchObject({
      ...original,
      releasedAt: Temporal.Instant.from(result.body.audit.recordedAt),
    });
    expect(result.body.availability).toMatchObject({
      isAvailable: false,
      blockingRouteIds: [LEGACY_B],
    });
    expect(await db.orm.public.DeliveryAttempt.all()).toHaveLength(0);
    // Existing read endpoints keep the unverified record consultable.
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/routes/${LEGACY_A}`)
          .auth(token(), { type: 'bearer' })
          .expect(200)
      ).body.status,
    ).toBe('UNVERIFIED');
  });

  it('releases only the last legacy hold and does not override a later manual compatibility veto on replay', async () => {
    const first = await reconcile().expect(200);
    expect(first.body.availability.isAvailable).toBe(false);
    const last = await reconcile(LEGACY_B).expect(200);
    expect(last.body.availability.isAvailable).toBe(true);
    await db.orm.public.Driver.where({ id: 'driver' }).update({
      isAvailable: false,
    });
    const replay = await reconcile(LEGACY_B).expect(200);
    expect(replay.body.audit).toEqual(last.body.audit);
    expect(replay.body.availability).toMatchObject({
      isAvailable: false,
      hasPersistedHolds: false,
      compatibilityFlagBlocks: true,
    });
    expect(
      (await db.orm.public.Driver.where({ id: 'driver' }).first())?.isAvailable,
    ).toBe(false);
  });

  it('serializes concurrent equal requests into one immutable audit and release', async () => {
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
    const first = reconcile().then((response) => response);
    await held;
    let settled = false;
    const second = reconcile().then((response) => {
      settled = true;
      return response;
    });
    try {
      let waiting = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !waiting) {
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
    const responses = await Promise.all([first, second]);
    expect(responses.map((row) => row.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(await db.orm.public.LegacyRouteReconciliation.all()).toHaveLength(1);
    const replay = await reconcile().expect(200);
    expect(replay.body.audit).toEqual(responses[0].body.audit);
    expect(
      (
        await db.orm.public.DriverReservation.where({
          id: 'legacy-reservation',
        }).first()
      )?.releasedAt?.toString(),
    ).toBe(replay.body.audit.recordedAt);
  });

  it('rejects conflicting actor or payload without changing the original audit', async () => {
    const first = await reconcile().expect(200);
    await reconcile(LEGACY_A, {
      ...LEGACY_PAYLOAD,
      evidence: 'Different evidence',
    }).expect(409);
    await reconcile(LEGACY_A, LEGACY_PAYLOAD, 'admin2').expect(409);
    expect((await reconcile().expect(200)).body.audit).toEqual(
      first.body.audit,
    );
    expect(await db.orm.public.LegacyRouteReconciliation.all()).toHaveLength(1);
  });

  it('retains audit authority after the administrator changes role but rejects new writes and replay by that actor', async () => {
    await reconcile().expect(200);
    await reconcile(LEGACY_B).expect(200);
    await db.orm.public.User.where({ id: 'admin' }).update({ role: 'CLIENT' });
    const available = await app.get(Availability).effective('driver');
    expect(available).toMatchObject({
      isAvailable: true,
      blockingRouteIds: [],
    });
    await reconcile().expect(403);
    await reconcile(DRIVERLESS).expect(403);
    // Bypass HTTP to exercise the service's independent fresh stored-role check.
    await expect(
      app
        .get(LegacyRouteReconciliationService)
        .reconcile(DRIVERLESS, 'admin', LEGACY_PAYLOAD),
    ).rejects.toThrow('ADMIN');
    expect(await db.orm.public.LegacyRouteReconciliation.all()).toHaveLength(2);
  });

  it('authorizes ADMIN across drivers and never releases another verified reservation', async () => {
    const before = await db.orm.public.DriverReservation.where({
      id: 'verified-reservation',
    }).first();
    const result = await reconcile(OTHER_LEGACY).expect(200);
    expect(result.body.availability).toMatchObject({
      isAvailable: false,
      blockingRouteIds: [VERIFIED],
    });
    expect(
      await db.orm.public.DriverReservation.where({
        id: 'verified-reservation',
      }).first(),
    ).toEqual(before);
  });

  it('audits a driverless historical route without inventing a driver or projection', async () => {
    const before = await state();
    const drivers = stable(await db.orm.public.Driver.all());
    const result = await reconcile(DRIVERLESS).expect(200);
    expect(result.body.availability).toBeNull();
    expect((await reconcile(DRIVERLESS).expect(200)).body).toEqual(result.body);
    expect(await state()).toEqual(before);
    expect(stable(await db.orm.public.Driver.all())).toEqual(drivers);
  });

  it('uses actual JWT ADMIN role, rejects identity spoofing, UUID and invalid reason/evidence bodies', async () => {
    for (const actor of ['owner', 'other', 'client'])
      await reconcile(LEGACY_A, LEGACY_PAYLOAD, actor).expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/routes/${LEGACY_A}/reconcile`)
      .send(LEGACY_PAYLOAD)
      .expect(401);
    await reconcile('not-uuid').expect(400);
    for (const body of [
      { ...LEGACY_PAYLOAD, administratorId: 'admin2' },
      {},
      [],
      { ...LEGACY_PAYLOAD, reason: ' ' },
      { ...LEGACY_PAYLOAD, evidence: 'x'.repeat(2001) },
      { ...LEGACY_PAYLOAD, evidence: {} },
    ])
      await reconcile(LEGACY_A, body).expect(400);
    expect(await db.orm.public.LegacyRouteReconciliation.all()).toHaveLength(0);
  });

  it('rejects verified routes and missing routes without an audit', async () => {
    await reconcile(VERIFIED).expect(409);
    await reconcile(randomUUID()).expect(404);
    expect(await db.orm.public.LegacyRouteReconciliation.all()).toHaveLength(0);
  });

  it('rolls back audit, matching reservation release and projection after an injected post-write exception', async () => {
    const before = await state();
    const reservations = stable(await db.orm.public.DriverReservation.all());
    const drivers = stable(await db.orm.public.Driver.all());
    const spy = jest
      .spyOn(app.get(Availability), 'effective')
      .mockRejectedValueOnce(
        new Error('injected after audit/release/projection'),
      );
    try {
      await reconcile().expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await db.orm.public.LegacyRouteReconciliation.all()).toHaveLength(0);
    expect(stable(await db.orm.public.DriverReservation.all())).toEqual(
      reservations,
    );
    expect(stable(await db.orm.public.Driver.all())).toEqual(drivers);
    expect(await state()).toEqual(before);
    await reconcile().expect(200);
  });

  it('keeps append-only audit protection enabled and documents typed HTTP semantics', async () => {
    const result = await reconcile().expect(200);
    expect(() =>
      execPsqlCommand(
        database,
        `UPDATE public."legacyRouteReconciliation" SET reason='changed' WHERE id='${result.body.audit.id}'`,
      ),
    ).toThrow();
    expect(() =>
      execPsqlCommand(
        database,
        `DELETE FROM public."legacyRouteReconciliation" WHERE id='${result.body.audit.id}'`,
      ),
    ).toThrow();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
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
    expect(
      document.components?.schemas?.RegularizeLegacyRouteDto,
    ).toMatchObject({ required: ['reason', 'evidence'] });
  });
});
