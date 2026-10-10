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
  START_FIXTURE,
  START_ROUTE,
  OTHER_ROUTE,
} from './route-start.fixtures.js';

jest.setTimeout(120_000);

describe('Explicit route start: owned PostgreSQL and real JWT', () => {
  let database = `start_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let receipt: ReturnType<typeof startOwnedContainer>;
  let service: any;
  let Service: any;
  const oldSecret = process.env.JWT_SECRET;
  const token = (sub = 'owner', role = 'DRIVER') =>
    jwt.sign({ sub, role, email: `${sub}@fixture.invalid` });
  const start = (id = START_ROUTE, sub = 'owner') =>
    request(app.getHttpServer())
      .post(`/api/v1/routes/${id}/start`)
      .auth(token(sub), { type: 'bearer' })
      .send({});

  beforeAll(() => {
    receipt = startOwnedContainer();
  });
  beforeEach(async () => {
    database = `start_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const url = createOwnedDatabase(database);
    runPrismaMigrate(
      url,
      '46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452',
    );
    const testName = expect.getState().currentTestName || '';
    let fixture = START_FIXTURE;
    if (testName.includes('lifecycle null')) {
      fixture = fixture.replace(
        `'${START_ROUTE}','driver','zone','2026-10-10T00:00:00Z','ASSIGNED'`,
        `'${START_ROUTE}','driver','zone','2026-10-10T00:00:00Z',NULL`,
      );
    } else if (testName.includes('lifecycle DRAFT')) {
      fixture = fixture
        .replace(
          `'${START_ROUTE}','driver','zone','2026-10-10T00:00:00Z','ASSIGNED'`,
          `'${START_ROUTE}','driver','zone','2026-10-10T00:00:00Z','DRAFT'`,
        )
        .replace(
          `'order','client','zone','${START_ROUTE}','ASSIGNED'`,
          `'order','client','zone',NULL,'PENDING'`,
        )
        .replace(
          `('reservation','${START_ROUTE}','driver',now());`,
          `('other-reservation','${OTHER_ROUTE}','driver',now());`,
        );
    } else if (testName.includes('lifecycle COMPLETED')) {
      fixture = fixture
        .replace(
          `'${START_ROUTE}','driver','zone','2026-10-10T00:00:00Z','ASSIGNED'`,
          `'${START_ROUTE}','driver','zone','2026-10-10T00:00:00Z','COMPLETED'`,
        )
        .replace(
          `('claim','${START_ROUTE}','order',now()), ('other-claim','${OTHER_ROUTE}','other-order',now())`,
          `('claim','${START_ROUTE}','order',now(),now()), ('other-claim','${OTHER_ROUTE}','other-order',now(),NULL)`,
        )
        .replace(
          `INSERT INTO public."orderClaim" (id,"routeId","orderId","claimedAt") VALUES`,
          `INSERT INTO public."orderClaim" (id,"routeId","orderId","claimedAt","releasedAt") VALUES`,
        );
    }
    execPsqlCommand(database, fixture);
    runPrismaMigrate(url);
    db = postgres<Contract>({ contractJson, url });
    process.env.JWT_SECRET = secret;
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { RoutesController } =
      await import('../src/modules/routes/routes.controller.js');
    const { RoutesService } =
      await import('../src/modules/routes/routes.service.js');
    const { RouteExecutionService } =
      await import('../src/modules/routes/route-execution.service.js');
    const { JwtStrategy } = await import('../src/modules/auth/jwt.strategy.js');
    const { JwtAuthGuard } =
      await import('../src/modules/auth/guards/jwt-auth.guard.js');
    const { RolesGuard } =
      await import('../src/modules/auth/guards/roles.guard.js');
    const { RouteProgressService } =
      await import('../src/modules/routes/route-progress.service.js');
    Service = RouteExecutionService;
    const { RouteReturnService } =
      await import('../src/modules/routes/route-return.service.js');
    const { RouteAvailabilityService } =
      await import('../src/modules/routes/route-availability.service.js');
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [RoutesController],
      providers: [
        RouteHistoryService,
        LegacyRouteReconciliationService,
        RouteReturnService,
        RouteAvailabilityService,
        RouteExecutionService,
        RouteProgressService,
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        {
          provide: PrismaService,
          useValue: { client: db, user: db.orm.public.User },
        },
        { provide: RoutesService, useValue: {} },
      ],
    }).compile();
    service = module.get(RouteExecutionService);
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

  it('serializes concurrent starts and preserves original actor/time on replay', async () => {
    const results = await Promise.all([start(), start()]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results[0].body).toEqual(results[1].body);
    const stored = await db.orm.public.Route.where({ id: START_ROUTE }).first();
    expect(stored?.startedById).toBe('owner');
    expect(results[0].body).toEqual({
      id: START_ROUTE,
      status: 'IN_PROGRESS',
      startedAt: stored?.startedAt?.toString(),
    });
    expect((await start()).body).toEqual(results[0].body);
    expect(
      (await db.orm.public.Driver.where({ id: 'driver' }).first())?.isAvailable,
    ).toBe(false);
  });
  it('allows only the matching reservation across simultaneous driver routes', async () => {
    const results = await Promise.all([start(), start(OTHER_ROUTE)]);
    expect(results.map((result) => result.status)).toEqual([200, 409]);
    expect(
      (await db.orm.public.Route.where({ id: OTHER_ROUTE }).first())?.startedAt,
    ).toBeNull();
  });
  it('enforces actual JWT, database role, ownership, UUID and no body identity', async () => {
    const path = `/api/v1/routes/${START_ROUTE}/start`;
    await request(app.getHttpServer()).post(path).send({}).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .auth(token('admin'), { type: 'bearer' })
      .send({})
      .expect(403);
    await start(START_ROUTE, 'other').expect(403);
    await start('not-a-uuid').expect(400);
    await start(randomUUID()).expect(404);
    for (const body of [
      { driverId: 'other-driver' },
      { actor: 'admin' },
      [],
      'spoof',
    ]) {
      await request(app.getHttpServer())
        .post(path)
        .auth(token(), { type: 'bearer' })
        .send(body)
        .expect(400);
    }
    expect(
      (await db.orm.public.Route.where({ id: START_ROUTE }).first())?.startedAt,
    ).toBeNull();
  });
  it.each([null, 'DRAFT', 'COMPLETED'])(
    'rejects lifecycle %s without partial start',
    async (status) => {
      await start().expect(409);
      expect(
        (await db.orm.public.Route.where({ id: START_ROUTE }).first())
          ?.startedAt,
      ).toBeNull();
    },
  );
  it('rejects unverified stops and rolls back injected post-write failures', async () => {
    await expect(
      db.orm.public.RouteStop.where({ id: 'stop' }).update({ isLegacy: true }),
    ).rejects.toThrow('nonlegacy');
    const failing = new Service({
      client: {
        transaction: (fn: any) =>
          db.transaction(async (tx) => {
            await fn(tx);
            throw new Error('injected rollback');
          }),
      },
    });
    await expect(failing.start(START_ROUTE, 'owner')).rejects.toThrow(
      'injected rollback',
    );
    expect(
      (await db.orm.public.Route.where({ id: START_ROUTE }).first())?.startedAt,
    ).toBeNull();
    expect((await service.start(START_ROUTE, 'owner')).status).toBe(
      'IN_PROGRESS',
    );
  });
  it('exposes the real start path and typed response in Swagger', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(
      document.paths['/api/v1/routes/{id}/start'].post?.responses['200'],
    ).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/RouteStartResponseDto' },
        },
      },
    });
    expect(document.components?.schemas?.RouteStartResponseDto).toMatchObject({
      required: ['id', 'status', 'startedAt'],
      properties: { startedAt: { type: 'string', format: 'date-time' } },
    });
  });
});
