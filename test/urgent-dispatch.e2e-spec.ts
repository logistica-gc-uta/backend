import { randomUUID } from 'node:crypto';
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

jest.setTimeout(120000);
describe('Issue12 dispatch: PostgreSQL + actual JWT HTTP', () => {
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const ids = {
    admin: randomUUID(),
    client: randomUUID(),
    driverUser: randomUUID(),
    driver: randomUUID(),
    zone: randomUUID(),
  };
  const token = (sub = ids.admin, role = 'ADMIN') =>
    jwt.sign({ sub, role, email: 'fixture@invalid.test' });
  const api = (
    method: 'get' | 'post',
    path: string,
    body?: object,
    sub = ids.admin,
    role = 'ADMIN',
  ) =>
    request(app.getHttpServer())
      [method]('/api/v1' + path)
      .auth(token(sub, role), { type: 'bearer' })
      .send(body);
  const today = () => Temporal.Now.instant();
  const seedOrder = async () =>
    db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      deliveryAddress: 'Fixture street',
      scheduledDeliveryDate: today(),
      deliveryLat: -1.25,
      deliveryLng: -78.62,
    });
  const proposal = async (id: string) =>
    (await api('get', `/dispatch/orders/${id}/proposal`).expect(200)).body;
  const intervene = (body: Record<string, unknown>) =>
    api('post', '/dispatch/interventions', {
      requestId: randomUUID(),
      reason: 'Fixture administrative decision',
      ...body,
    });
  const history = async (id: string) =>
    (await api('get', `/routes/${id}`).expect(200)).body;
  const makeRoute = async (count = 3) => {
    const orders = [];
    for (let i = 0; i < count; i++) orders.push(await seedOrder());
    const route = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: today().toString(),
        orderIds: orders.map((o) => o.id),
      }).expect(201)
    ).body;
    await api('post', `/routes/${route.id}/assign`, {
      driverId: ids.driver,
    }).expect(200);
    return { route, orders };
  };
  beforeAll(async () => {
    startOwnedContainer();
    const url = createOwnedDatabase(
      'dispatch_' + randomUUID().replaceAll('-', '').slice(0, 8),
    );
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    db = postgres<Contract>({ contractJson, url });
    for (const [id, role] of [
      [ids.admin, 'ADMIN'],
      [ids.client, 'CLIENT'],
      [ids.driverUser, 'DRIVER'],
    ] as const)
      await db.orm.public.User.create({
        id,
        role,
        name: role,
        email: id + '@fixture.invalid',
        password: 'not-a-real-password',
      });
    await db.orm.public.Driver.create({
      id: ids.driver,
      userId: ids.driverUser,
      vehicle: 'fixture',
    });
    await db.orm.public.Zone.create({
      id: ids.zone,
      code: 'DISPATCH',
      name: 'Dispatch zone',
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
    ids.zone = randomUUID();
    ids.driver = randomUUID();
    ids.driverUser = randomUUID();
    await db.orm.public.User.create({
      id: ids.driverUser,
      role: 'DRIVER',
      name: 'Driver',
      email: ids.driverUser + '@fixture.invalid',
      password: 'fixture',
    });
    await db.orm.public.Driver.create({
      id: ids.driver,
      userId: ids.driverUser,
      vehicle: 'fixture',
    });
    await db.orm.public.Zone.create({
      id: ids.zone,
      code: ids.zone,
      name: ids.zone,
      depotLat: -1.24,
      depotLng: -78.61,
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
    cleanupOwnedResources();
  });

  it('CP-RUT-003/010: fourth ASSIGNED stop, audited JWT actor, exact duplicate replay', async () => {
    const { route, orders } = await makeRoute();
    const urgent = await seedOrder();
    const p = await proposal(urgent.id);
    expect(p.kind).toBe('INSERT');
    expect(p.orderIds).toHaveLength(4);
    const before = await history(route.id);
    expect(before.stops).toHaveLength(3);
    const body = {
      action: 'CONFIRM',
      orderId: urgent.id,
      fingerprint: p.fingerprint,
      requestId: randomUUID(),
    };
    const result = (await intervene(body).expect(200)).body;
    expect(result.actorId).toBe(ids.admin);
    expect(result.action).toBe('CONFIRM');
    expect(result.recordedAt).toBeTruthy();
    expect(result.reason).toBe('Fixture administrative decision');
    expect(result.outcome).toBe('APPLIED');
    const after = await history(route.id);
    expect(after.status).toBe('ASSIGNED');
    expect(after.stops.map((s: any) => s.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(after.stops.map((s: any) => s.orderId))).toEqual(
      new Set([...orders.map((o) => o.id), urgent.id]),
    );
    const replay = (await intervene(body).expect(200)).body;
    expect(replay).toEqual(result);
    await intervene({ ...body, reason: 'Different payload' }).expect(409);
    expect((await history(route.id)).stops).toEqual(after.stops);
    const audit = (await api('get', '/dispatch/audit').expect(200)).body;
    expect(
      audit.filter((a: any) => a.requestId === body.requestId),
    ).toHaveLength(1);
  });
  it('CP-RUT-004/009: full or started routes propose a new departure; unavailable selection rolls back', async () => {
    const { route } = await makeRoute(4);
    const urgent = await seedOrder();
    const p = await proposal(urgent.id);
    expect(p.kind).toBe('NEW_ROUTE');
    const before = await history(route.id);
    await intervene({
      action: 'CONFIRM',
      orderId: urgent.id,
      fingerprint: p.fingerprint,
      driverId: ids.driver,
    }).expect(409);
    expect((await history(route.id)).stops).toEqual(before.stops);
    expect(
      (await api('get', `/orders/${urgent.id}`).expect(200)).body.status,
    ).toBe('PENDING');
    const user = await db.orm.public.User.create({
      role: 'DRIVER',
      name: 'Free driver',
      email: randomUUID() + '@fixture.invalid',
      password: 'fixture',
    });
    const driver = await db.orm.public.Driver.create({
      userId: user.id,
      vehicle: 'fixture',
    });
    const result = (
      await intervene({
        action: 'CONFIRM',
        orderId: urgent.id,
        fingerprint: p.fingerprint,
        driverId: driver.id,
      }).expect(200)
    ).body;
    expect(result.routeId).not.toBe(route.id);
    expect(
      (await history(result.routeId)).stops.map((s: any) => s.orderId),
    ).toEqual([urgent.id]);
    expect((await history(route.id)).stops).toEqual(before.stops);
  });
  it('CP-RUT-005: audited reorder, order move and driver reassignment preserve pre-start invariants', async () => {
    const { route, orders } = await makeRoute();
    await intervene({
      action: 'REORDER',
      routeId: route.id,
      orderIds: orders.map((o) => o.id).reverse(),
    }).expect(200);
    expect((await history(route.id)).stops.map((s: any) => s.orderId)).toEqual(
      orders.map((o) => o.id).reverse(),
    );
    const other = await seedOrder();
    const draft = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: today().toString(),
        orderIds: [other.id],
      }).expect(201)
    ).body;
    await intervene({
      action: 'MOVE',
      routeId: route.id,
      targetRouteId: draft.id,
      orderId: orders[0]!.id,
    }).expect(200);
    expect((await history(route.id)).stops).toHaveLength(2);
    expect((await history(draft.id)).stops.map((s: any) => s.orderId)).toEqual([
      other.id,
      orders[0]!.id,
    ]);
    expect(
      (await api('get', `/orders/${orders[0]!.id}`).expect(200)).body.status,
    ).toBe('PENDING');
    const user = await db.orm.public.User.create({
      role: 'DRIVER',
      name: 'Replacement',
      email: randomUUID() + '@fixture.invalid',
      password: 'fixture',
    });
    const driver = await db.orm.public.Driver.create({
      userId: user.id,
      vehicle: 'replacement',
    });
    await intervene({
      action: 'REASSIGN_DRIVER',
      routeId: route.id,
      driverId: driver.id,
    }).expect(200);
    expect((await history(route.id)).driverId).toBe(driver.id);
    await api('post', `/routes/${draft.id}/assign`, {
      driverId: ids.driver,
    }).expect(200);
    expect((await history(draft.id)).driverId).toBe(ids.driver);
  });
  it('rejects a proposal without assigning and persists priority decisions', async () => {
    const urgent = await seedOrder();
    const p = await proposal(urgent.id);
    const a = (
      await intervene({
        action: 'REJECT',
        orderId: urgent.id,
        fingerprint: p.fingerprint,
      }).expect(200)
    ).body;
    expect(a.outcome).toBe('REJECTED');
    expect(
      (await api('get', `/orders/${urgent.id}`).expect(200)).body.status,
    ).toBe('PENDING');
    await intervene({ action: 'PRIORITIZE', orderId: urgent.id }).expect(200);
    const inbox = (await api('get', '/dispatch/inbox').expect(200)).body;
    expect(inbox.urgencies[0].orderId).toBe(urgent.id);
  });
  it('JWT/RBAC and DTO boundaries reject spoofed actor and non-ADMIN reads/writes without state changes', async () => {
    const urgent = await seedOrder();
    const p = await proposal(urgent.id);
    const snapshot = (await api('get', `/orders/${urgent.id}`).expect(200))
      .body;
    await request(app.getHttpServer())
      .get('/api/v1/dispatch/inbox')
      .expect(401);
    for (const [sub, role] of [
      [ids.client, 'CLIENT'],
      [ids.driverUser, 'DRIVER'],
    ] as const) {
      for (const path of [
        '/dispatch/inbox',
        '/dispatch/audit',
        `/dispatch/orders/${urgent.id}/proposal`,
      ])
        await api('get', path, undefined, sub, role).expect(403);
      await api(
        'post',
        '/dispatch/interventions',
        {
          action: 'CONFIRM',
          orderId: urgent.id,
          fingerprint: p.fingerprint,
          requestId: randomUUID(),
          reason: 'unauthorized',
        },
        sub,
        role,
      ).expect(403);
    }
    await intervene({
      action: 'CONFIRM',
      orderId: urgent.id,
      fingerprint: p.fingerprint,
      actorId: ids.admin,
    }).expect(400);
    await intervene({
      action: 'PRIORITIZE',
      orderId: urgent.id,
      reason: ' ',
    }).expect(400);
    expect((await api('get', `/orders/${urgent.id}`).expect(200)).body).toEqual(
      snapshot,
    );
  });
  it.each(['RECIPIENT_ABSENT', 'RECIPIENT_REFUSED'])(
    'CP-SEG-004/008: %s, explicit agreement, same commercial order in R2 and immutable R1 history',
    async (reason) => {
      const { route, orders } = await makeRoute(1);
      const orderId = orders[0]!.id;
      await api(
        'post',
        `/routes/${route.id}/start`,
        {},
        ids.driverUser,
        'DRIVER',
      ).expect(200);
      const stop = (await history(route.id)).stops[0];
      await api(
        'post',
        `/routes/${route.id}/stops/${stop.id}/failure`,
        {
          requestId: randomUUID(),
          reason,
          context: 'Only necessary operational context',
        },
        ids.driverUser,
        'DRIVER',
      ).expect(200);
      const failed = await history(route.id);
      expect(failed.stops[0].outcome).toBe('FAILED');
      expect(failed.stops[0].attempts[0].failureReason).toBe(reason);
      const commercial = (await api('get', `/orders/${orderId}`).expect(200))
        .body;
      expect(commercial.status).toBe('ASSIGNED');
      expect(
        (await api('get', '/dispatch/inbox').expect(200)).body.incidents.some(
          (i: any) => i.orderId === orderId,
        ),
      ).toBe(true);
      expect((await proposal(orderId)).reasons).toContain(
        'ADMINISTRATIVE_REVIEW_REQUIRED',
      );
      const attemptId = failed.stops[0].attempts[0].id;
      const unresolved = (
        await intervene({
          action: 'CONTACT',
          orderId,
          attemptId,
          agreementConfirmed: false,
        }).expect(200)
      ).body;
      await intervene({
        action: 'RESCHEDULE',
        orderId,
        agreementId: unresolved.id,
      }).expect(409);
      await intervene({
        action: 'CONTACT',
        orderId,
        attemptId,
        agreementConfirmed: true,
      }).expect(400);
      expect((await history(route.id)).stops).toEqual(failed.stops);
      const time = today().add({ minutes: 15 }).round({ smallestUnit: 'microsecond' });
      const contact = (
        await intervene({
          action: 'CONTACT',
          orderId,
          attemptId,
          agreementConfirmed: true,
          scheduledDeliveryDate: time.toString(),
          deliveryWindowStart: time.subtract({ minutes: 5 }).toString(),
          deliveryWindowEnd: time.add({ minutes: 10 }).toString(),
        }).expect(200)
      ).body;
      await intervene({
        action: 'RESCHEDULE',
        orderId,
        agreementId: contact.id,
      }).expect(409);
      await api(
        'post',
        `/routes/${route.id}/complete`,
        {},
        ids.driverUser,
        'DRIVER',
      ).expect(200);
      const body = {
        action: 'RESCHEDULE',
        orderId,
        agreementId: contact.id,
        requestId: randomUUID(),
      };
      const scheduled = (await intervene(body).expect(200)).body;
      expect(scheduled.orderId).toBe(orderId);
      expect((await intervene(body).expect(200)).body).toEqual(scheduled);
      await intervene({ ...body, requestId: randomUUID() }).expect(409);
      const after = (await api('get', `/orders/${orderId}`).expect(200)).body;
      expect(after.status).toBe('PENDING');
      expect(after.scheduledDeliveryDate).toBe(time.toString());
      const draft = (
        await api('post', '/routes', {
          zoneId: ids.zone,
          routeDate: time.toString(),
          orderIds: [orderId],
        }).expect(201)
      ).body;
      await api('post', `/routes/${draft.id}/assign`, {
        driverId: ids.driver,
      }).expect(409);
      await api(
        'post',
        `/routes/${route.id}/return`,
        {},
        ids.driverUser,
        'DRIVER',
      ).expect(200);
      await api('post', `/routes/${draft.id}/assign`, {
        driverId: ids.driver,
      }).expect(200);
      expect((await history(route.id)).stops).toEqual(failed.stops);
      const r2 = await history(draft.id);
      expect(r2.stops[0].orderId).toBe(orderId);
      expect(r2.stops[0].id).not.toBe(stop.id);
      expect(r2.stops[0].attempts).toEqual([]);
      const inbox = (await api('get', '/dispatch/inbox').expect(200)).body;
      expect(inbox.incidents.some((i: any) => i.orderId === orderId)).toBe(
        false,
      );
    },
  );
});
