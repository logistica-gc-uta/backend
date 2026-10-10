import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { toInstant } from '../src/common/temporal.util.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/modules/auth/dto/register.dto.js';
import { OrderStatus } from '../src/modules/orders/dto/update-order-status.dto.js';
import {
  SecurityFixtureManager,
  UserFixture,
} from './orders-security.fixtures.js';

describe('Driver-owned routes (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let fixtures: SecurityFixtureManager;
  let owner: UserFixture;
  let other: UserFixture;
  let empty: UserFixture;
  let orphan: UserFixture;
  let admin: UserFixture;
  let client: UserFixture;
  let routeId: string;
  let orderIds: string[];
  const endpoint = '/api/v1/drivers/me/routes';
  const get = (token: string, query = '') =>
    request(app.getHttpServer())
      .get(endpoint + query)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    // Caller must provision a uniquely owned disposable database, never a shared .env.
    expect(process.env.DATABASE_URL).toMatch(
      /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/issue6_/,
    );
    expect(process.env.JWT_SECRET).toBeTruthy();
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    fixtures = new SecurityFixtureManager(prisma, jwt);
    owner = await fixtures.createUser(Role.DRIVER, 'route-owner');
    other = await fixtures.createUser(Role.DRIVER, 'route-other');
    empty = await fixtures.createUser(Role.DRIVER, 'route-empty');
    orphan = await fixtures.createUser(Role.DRIVER, 'route-orphan');
    admin = await fixtures.createUser(Role.ADMIN, 'route-admin');
    client = await fixtures.createUser(Role.CLIENT, 'route-client');
    const driver = await fixtures.createDriver(owner.id);
    const foreignDriver = await fixtures.createDriver(other.id);
    await fixtures.createDriver(empty.id);
    const zone = await fixtures.createZone();
    const route = await fixtures.createRoute(driver.id, zone.id);
    routeId = route.id;
    await prisma.route
      .where({ id: routeId })
      .update({ date: toInstant('2024-02-29T05:00:00Z') });
    // Both just-before-start and next-midnight must be excluded from the leap-day filter.
    for (const date of ['2024-02-29T04:59:59.999Z', '2024-03-01T05:00:00Z']) {
      const boundary = await fixtures.createRoute(driver.id, zone.id);
      await prisma.route
        .where({ id: boundary.id })
        .update({ date: toInstant(date) });
    }
    const foreignRoute = await fixtures.createRoute(foreignDriver.id, zone.id);
    await fixtures.createOrder(client.id, zone.id, foreignRoute.id);
    orderIds = [];
    for (const [stop, status] of [
      [2, OrderStatus.DELIVERED],
      [null, OrderStatus.CANCELLED],
      [1, OrderStatus.ASSIGNED],
      [2, OrderStatus.IN_TRANSIT],
      [null, OrderStatus.PENDING],
    ] as const) {
      const order = await fixtures.createOrder(
        client.id,
        zone.id,
        routeId,
        status,
      );
      await prisma.order
        .where({ id: order.id })
        .update({
          stopOrder: stop,
          scheduledDeliveryDate: toInstant('2030-01-01T00:00:00Z'),
        });
      orderIds.push(order.id);
    }
  });

  afterAll(async () => {
    if (fixtures) await fixtures.cleanup();
    if (app) await app.close();
  });

  it('returns only owned routes and minimal projection, including all assigned statuses', async () => {
    const response = await get(owner.token, '?date=2024-02-29').expect(200);
    expect(response.body).toHaveLength(1);
    const route = response.body[0];
    expect(route.id).toBe(routeId);
    expect(Object.keys(route).sort()).toEqual(['date', 'id', 'orders', 'zone']);
    expect(Object.keys(route.zone).sort()).toEqual(['code', 'id', 'name']);
    expect(route.orders.map((o: { id: string }) => o.id)).toEqual([
      orderIds[2],
      ...[orderIds[0], orderIds[3]].sort(),
      ...[orderIds[1], orderIds[4]].sort(),
    ]);
    expect(route.orders).toHaveLength(5);
    for (const order of route.orders) {
      expect(Object.keys(order).sort()).toEqual([
        'deliveryAddress',
        'id',
        'scheduledDeliveryDate',
        'status',
        'stopOrder',
      ]);
    }
  });
  it('keeps every local-day boundary correct and scopes date to Route, not order schedule', async () => {
    expect((await get(owner.token).expect(200)).body).toHaveLength(3);
    expect(
      (await get(owner.token, '?date=2024-02-28').expect(200)).body,
    ).toHaveLength(1);
    expect(
      (await get(owner.token, '?date=2024-03-01').expect(200)).body,
    ).toHaveLength(1);
    expect(
      (await get(owner.token, '?date=2030-01-01').expect(200)).body,
    ).toEqual([]);
  });
  it('isolates another driver even with a valid JWT', async () => {
    const response = await get(other.token).expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].id).not.toBe(routeId);
    expect(
      response.body[0].orders.some((o: { id: string }) =>
        orderIds.includes(o.id),
      ),
    ).toBe(false);
  });
  it.each(['driverId', 'userId', 'routeId'])(
    'rejects caller-supplied %s',
    async (field) => {
      await get(owner.token, `?${field}=${other.id}`).expect(400);
    },
  );
  it.each([
    '2023-02-29',
    '2024-02-30',
    '2026-04-31',
    '2026-1-01',
    'null',
    '123',
    '',
    '2024-02-29&date=2024-03-01',
    '2024-02-29T00:00:00Z',
  ])('rejects malformed date %s', async (date) => {
    await get(owner.token, `?date=${date}`).expect(400);
  });
  it.each(['empty', 'orphan'])('returns [] for %s driver', async (kind) => {
    expect(
      (await get(kind === 'empty' ? empty.token : orphan.token).expect(200))
        .body,
    ).toEqual([]);
  });
  it('rejects missing, invalid and nonexistent-user JWTs', async () => {
    await request(app.getHttpServer()).get(endpoint).expect(401);
    await get('invalid').expect(401);
    await get(
      fixtures.createForgedToken(
        '00000000-0000-0000-0000-000000000000',
        Role.DRIVER,
      ),
    ).expect(401);
  });
  it.each(['admin', 'client'])(
    'rejects %s and ignores forged role claims',
    async (kind) => {
      const actor = kind === 'admin' ? admin : client;
      await get(actor.token).expect(403);
      await get(
        jwt.sign({ sub: actor.id, role: Role.DRIVER, userId: owner.id }),
      ).expect(403);
    },
  );
  it('uses validated JWT subject, ignoring injected identity claims', async () => {
    const token = jwt.sign({
      sub: empty.id,
      role: Role.ADMIN,
      userId: owner.id,
      driverId: owner.id,
    });
    expect((await get(token).expect(200)).body).toEqual([]);
  });
  it('preserves existing ADMIN reads and DRIVER fail-closed status writes', async () => {
    for (const path of [
      '/drivers',
      '/routes',
      `/routes/${routeId}`,
      '/orders',
    ]) {
      await request(app.getHttpServer())
        .get(`/api/v1${path}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
    }
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderIds[2]}/status`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ status: 'IN_TRANSIT' })
      .expect(403);
    expect(
      (await prisma.order.where({ id: orderIds[2] }).first())?.status,
    ).toBe(OrderStatus.ASSIGNED);
  });
  it('documents bearer auth, query and actual array projection', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth({}, 'JWT-auth').build(),
    );
    const operation = doc.paths[endpoint].get!;
    expect(operation.security).toEqual([{ 'JWT-auth': [] }]);
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'date', in: 'query' }),
      ]),
    );
    expect(operation.responses['200']).toHaveProperty(
      'content.application/json.schema.type',
      'array',
    );
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403']),
    );
  });
});
