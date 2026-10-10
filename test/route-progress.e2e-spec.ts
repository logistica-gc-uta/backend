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
import { START_ROUTE, OTHER_ROUTE } from './route-start.fixtures.js';
import {
  FAILED_STOP,
  SUCCESS_STOP,
  PROGRESS_FIXTURE,
} from './route-progress.fixtures.js';

jest.setTimeout(120_000);

describe('Route progress: owned PostgreSQL, JWT and actual HTTP', () => {
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const oldSecret = process.env.JWT_SECRET;
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let receipt: ReturnType<typeof startOwnedContainer>;
  let database: string;
  let Progress: any;
  const token = (sub = 'owner') =>
    jwt.sign({ sub, role: 'DRIVER', email: `${sub}@fixture.invalid` });
  const fail = (
    body = payload(),
    sub = 'owner',
    route = START_ROUTE,
    stop = FAILED_STOP,
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/routes/${route}/stops/${stop}/failure`)
      .auth(token(sub), { type: 'bearer' })
      .send(body);
  const complete = () =>
    request(app.getHttpServer())
      .post(`/api/v1/routes/${START_ROUTE}/complete`)
      .auth(token(), { type: 'bearer' })
      .send({});
  const status = (value: string, sub = 'owner', id = 'success-order') =>
    request(app.getHttpServer())
      .patch(`/api/v1/orders/${id}/status`)
      .auth(token(sub), { type: 'bearer' })
      .send({ status: value });
  const payload = (reason = 'RECIPIENT_ABSENT') => ({
    requestId: randomUUID(),
    reason,
    context: 'Recipient unavailable',
  });
  const resolve = async () => {
    await fail().expect(200);
    await status('IN_TRANSIT').expect(200);
    await status('DELIVERED').expect(200);
  };

  beforeAll(() => {
    receipt = startOwnedContainer();
    process.env.JWT_SECRET = secret;
  });
  beforeEach(async () => {
    database = `progress_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const url = createOwnedDatabase(database);
    runPrismaMigrate(url);
    execPsqlCommand(database, PROGRESS_FIXTURE);
    db = postgres<Contract>({ contractJson, url });
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { RoutesController } =
      await import('../src/modules/routes/routes.controller.js');
    const { RoutesService } =
      await import('../src/modules/routes/routes.service.js');
    const { RouteExecutionService } =
      await import('../src/modules/routes/route-execution.service.js');
    const { RouteProgressService } =
      await import('../src/modules/routes/route-progress.service.js');
    const { OrdersController } =
      await import('../src/modules/orders/orders.controller.js');
    const { OrdersService } =
      await import('../src/modules/orders/orders.service.js');
    const { JwtStrategy } = await import('../src/modules/auth/jwt.strategy.js');
    const { JwtAuthGuard } =
      await import('../src/modules/auth/guards/jwt-auth.guard.js');
    const { RolesGuard } =
      await import('../src/modules/auth/guards/roles.guard.js');
    Progress = RouteProgressService;
    const { RouteReturnService } =
      await import('../src/modules/routes/route-return.service.js');
    const { RouteAvailabilityService } =
      await import('../src/modules/routes/route-availability.service.js');
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [RoutesController, OrdersController],
      providers: [
        RouteHistoryService,
        LegacyRouteReconciliationService,
        RouteReturnService,
        RouteAvailabilityService,
        RouteExecutionService,
        RouteProgressService,
        OrdersService,
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        {
          provide: PrismaService,
          useValue: {
            client: db,
            user: db.orm.public.User,
            order: db.orm.public.Order,
          },
        },
        { provide: RoutesService, useValue: {} },
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
    await request(app.getHttpServer())
      .post(`/api/v1/routes/${START_ROUTE}/start`)
      .auth(token(), { type: 'bearer' })
      .send({})
      .expect(200);
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

  it.each(['RECIPIENT_ABSENT', 'RECIPIENT_REFUSED'])(
    'records %s without commercial status rewrite',
    async (reason) => {
      const result = await fail(payload(reason)).expect(200);
      expect(result.body).toMatchObject({
        driverId: 'driver',
        stopId: FAILED_STOP,
        outcome: 'FAILED',
        failureReason: reason,
      });
      const order = await db.orm.public.Order.where({ id: 'order' }).first();
      expect(order).toMatchObject({
        status: 'ASSIGNED',
        requiresAdministrativeReview: true,
      });
      expect(
        (await db.orm.public.RouteStop.where({ id: FAILED_STOP }).first())
          ?.outcome,
      ).toBe('FAILED');
      expect(
        (
          await db.orm.public.DeliveryAttempt.where({
            id: result.body.id,
          }).first()
        )?.recordedAt.toString(),
      ).toBe(result.body.recordedAt);
    },
  );
  it('serializes two equal requests and rejects changed payload or actor', async () => {
    const body = payload();
    const results = await Promise.all([fail(body), fail(body)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].body).toEqual(results[1].body);
    expect(
      await db.orm.public.DeliveryAttempt.where({ stopId: FAILED_STOP }).all(),
    ).toHaveLength(1);
    await fail({ ...body, context: 'Changed' }).expect(409);
    await fail(body, 'other').expect(403);
    // JSONB round-trips may reorder keys; comparison is structural, not stringified.
    await db.orm.public.Driver.where({ id: 'other-driver' }).delete();
    await db.orm.public.Driver.where({ id: 'driver' }).update({
      userId: 'other',
    });
    await fail(body, 'other').expect(409);
  });
  it('authorizes JWT identity and rejects spoofing, missing profiles and unrelated stops', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/routes/${START_ROUTE}/stops/${FAILED_STOP}/failure`)
      .send(payload())
      .expect(401);
    await fail({ ...payload(), driverId: 'other-driver' } as any).expect(400);
    await fail(payload(), 'admin').expect(403);
    await fail(payload(), 'other').expect(403);
    await fail(payload(), 'owner', OTHER_ROUTE).expect(404);
    await fail(payload(), 'owner', START_ROUTE, randomUUID()).expect(404);
    await db.orm.public.Driver.where({ id: 'driver' }).update({
      userId: 'client',
    });
    await fail().expect(403);
    expect(await db.orm.public.DeliveryAttempt.all()).toHaveLength(0);
  });
  it('uses the existing commercial graph and prevents administrator cancellation', async () => {
    await status('DELIVERED').expect(400);
    await status('CANCELLED', 'admin').expect(409);
    await status('IN_TRANSIT').expect(200);
    await status('IN_TRANSIT').expect(200);
    await status('DELIVERED').expect(200);
    await status('DELIVERED').expect(200);
    expect(
      await db.orm.public.DeliveryAttempt.where({ stopId: SUCCESS_STOP }).all(),
    ).toHaveLength(1);
    expect(
      (await db.orm.public.RouteStop.where({ id: SUCCESS_STOP }).first())
        ?.outcome,
    ).toBe('SUCCESSFUL');
  });
  it('rejects unresolved completion and releases only order claims after resolved visits', async () => {
    await complete().expect(409);
    await resolve();
    const first = await complete().expect(200);
    const replay = await complete().expect(200);
    expect(replay.body).toEqual(first.body);
    expect(
      (await db.orm.public.Route.where({ id: START_ROUTE }).first())
        ?.completedById,
    ).toBe('owner');
    expect(
      await db.orm.public.OrderClaim.where({
        routeId: START_ROUTE,
        releasedAt: null,
      }).all(),
    ).toHaveLength(0);
    expect(
      (
        await db.orm.public.DriverReservation.where({
          routeId: START_ROUTE,
        }).first()
      )?.releasedAt,
    ).toBeNull();
    expect(
      (await db.orm.public.Driver.where({ id: 'driver' }).first())?.isAvailable,
    ).toBe(false);
    expect(
      await db.orm.public.Order.where({ id: 'order' }).first(),
    ).toMatchObject({ status: 'ASSIGNED', requiresAdministrativeReview: true });
  });
  it('replays original attempts after completion and retains history beside a future stop', async () => {
    const body = payload();
    const first = await fail(body).expect(200);
    await status('IN_TRANSIT').expect(200);
    await status('DELIVERED').expect(200);
    await complete().expect(200);
    expect((await fail(body).expect(200)).body).toEqual(first.body);
    await status('DELIVERED').expect(200);
    execPsqlCommand(
      database,
      `INSERT INTO public."routeStop" (id,"routeId","orderId",sequence,outcome,"isLegacy") VALUES ('future-stop','${OTHER_ROUTE}','order',2,'PENDING',false); INSERT INTO public."orderClaim" (id,"routeId","orderId","claimedAt") VALUES ('future-claim','${OTHER_ROUTE}','order',now());`,
    );
    expect(
      await db.orm.public.RouteStop.where({ orderId: 'order' }).all(),
    ).toHaveLength(2);
    expect(
      (await db.orm.public.Order.where({ id: 'order' }).first())?.routeId,
    ).toBe(START_ROUTE);
    expect((await fail(body).expect(200)).body).toEqual(first.body);
  });
  it('rolls back attempt, outcome and review flag after an injected transaction failure', async () => {
    const failing = new Progress({
      client: {
        transaction: (fn: any) =>
          db.transaction(async (tx) => {
            await fn(tx);
            throw new Error('injected rollback');
          }),
      },
    });
    await expect(
      failing.fail(START_ROUTE, FAILED_STOP, 'owner', payload()),
    ).rejects.toThrow('injected rollback');
    expect(await db.orm.public.DeliveryAttempt.all()).toHaveLength(0);
    expect(
      (await db.orm.public.RouteStop.where({ id: FAILED_STOP }).first())
        ?.outcome,
    ).toBe('PENDING');
    expect(
      (await db.orm.public.Order.where({ id: 'order' }).first())
        ?.requiresAdministrativeReview,
    ).toBe(false);
    await status('IN_TRANSIT').expect(200);
    await expect(
      failing.updateOrder('success-order', 'owner', 'DELIVERED'),
    ).rejects.toThrow('injected rollback');
    expect(
      (await db.orm.public.Order.where({ id: 'success-order' }).first())
        ?.status,
    ).toBe('IN_TRANSIT');
    expect(
      (await db.orm.public.RouteStop.where({ id: SUCCESS_STOP }).first())
        ?.outcome,
    ).toBe('PENDING');
    expect(await db.orm.public.DeliveryAttempt.all()).toHaveLength(0);
    await status('DELIVERED').expect(200);
    await fail().expect(200);
    await expect(failing.complete(START_ROUTE, 'owner')).rejects.toThrow(
      'injected rollback',
    );
    expect(
      (await db.orm.public.Route.where({ id: START_ROUTE }).first())?.status,
    ).toBe('IN_PROGRESS');
    expect(
      await db.orm.public.OrderClaim.where({
        routeId: START_ROUTE,
        releasedAt: null,
      }).all(),
    ).toHaveLength(2);
  });
  it('publishes typed success Swagger for failure and completion HTTP paths', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    for (const [path, name] of [
      ['/api/v1/routes/{id}/stops/{stopId}/failure', 'VisitAttemptResponseDto'],
      ['/api/v1/routes/{id}/complete', 'RouteCompletionResponseDto'],
    ]) {
      expect(doc.paths[path].post?.responses['200']).toMatchObject({
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${name}` },
          },
        },
      });
    }
  });
});
