import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
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
      const time = today()
        .add({ minutes: 15 })
        .round({ smallestUnit: 'microsecond' });
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
  const auditRows = async () =>
    (await api('get', '/dispatch/audit').expect(200)).body as any[];
  const state = async (id: string) =>
    (await api('get', `/orders/${id}`).expect(200)).body;
  it('CP-RUT-006: simultaneous insertions into the last slot yield exactly one winner and contiguous unique stops', async () => {
    const { route } = await makeRoute(3);
    const a = await seedOrder(),
      b = await seedOrder();
    const pa = await proposal(a.id),
      pb = await proposal(b.id);
    const audits = await auditRows();
    const result = await Promise.all([
      intervene({
        action: 'CONFIRM',
        orderId: a.id,
        fingerprint: pa.fingerprint,
      }),
      intervene({
        action: 'CONFIRM',
        orderId: b.id,
        fingerprint: pb.fingerprint,
      }),
    ]);
    expect(result.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const after = await history(route.id);
    expect(after.stops).toHaveLength(4);
    expect(after.stops.map((s: any) => s.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(after.stops.map((s: any) => s.orderId)).size).toBe(4);
    for (const [index, o] of [a, b].entries()) {
      const current = await state(o.id);
      expect(current.status).toBe(
        result[index]!.status === 200 ? 'ASSIGNED' : 'PENDING',
      );
    }
    expect((await auditRows()).length).toBe(audits.length + 1);
  });
  it('concurrent confirmation of the same proposal and key returns one audit and one route', async () => {
    const order = await seedOrder();
    const p = await proposal(order.id);
    const body = {
      action: 'CONFIRM',
      orderId: order.id,
      fingerprint: p.fingerprint,
      driverId: ids.driver,
      requestId: randomUUID(),
    };
    const result = await Promise.all([intervene(body), intervene(body)]);
    expect(result.map((r) => r.status)).toEqual([200, 200]);
    expect(result[0]!.body).toEqual(result[1]!.body);
    const h = await history(result[0]!.body.routeId);
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0].orderId).toBe(order.id);
    expect(
      (await auditRows()).filter((a) => a.requestId === body.requestId),
    ).toHaveLength(1);
  });
  it.each(['order', 'driver'])(
    'concurrent %s allocation never creates duplicate claims or reservations',
    async (resource) => {
      const a = await seedOrder(),
        b = resource === 'order' ? a : await seedOrder();
      const pa = await proposal(a.id),
        pb = await proposal(b.id);
      let secondDriver: string = ids.driver;
      if (resource === 'order') {
        const u = await db.orm.public.User.create({
          role: 'DRIVER',
          name: 'Alternate',
          email: randomUUID() + '@fixture.invalid',
          password: 'fixture',
        });
        secondDriver = (
          await db.orm.public.Driver.create({
            userId: u.id,
            vehicle: 'fixture',
          })
        ).id;
      }
      const result = await Promise.all([
        intervene({
          action: 'CONFIRM',
          orderId: a.id,
          fingerprint: pa.fingerprint,
          driverId: ids.driver,
        }),
        intervene({
          action: 'CONFIRM',
          orderId: b.id,
          fingerprint: pb.fingerprint,
          driverId: secondDriver,
        }),
      ]);
      expect(result.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      const winner = result.find((r) => r.status === 200)!;
      expect((await history(winner.body.routeId)).stops).toHaveLength(1);
      const all = (await api('get', '/routes').expect(200)).body;
      expect(all.filter((r: any) => r.zoneId === ids.zone)).toHaveLength(1);
      if (resource === 'driver')
        expect(
          [(await state(a.id)).status, (await state(b.id)).status].sort(
            (a, b) => String(a).localeCompare(String(b)),
          ),
        ).toEqual(['ASSIGNED', 'PENDING']);
    },
  );
  it('conflicting concurrent idempotency payloads persist only one decision', async () => {
    const a = await seedOrder(),
      b = await seedOrder();
    const requestId = randomUUID();
    const result = await Promise.all([
      intervene({ action: 'PRIORITIZE', orderId: a.id, requestId }),
      intervene({ action: 'PRIORITIZE', orderId: b.id, requestId }),
    ]);
    expect(result.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    expect(
      (await auditRows()).filter((a) => a.requestId === requestId),
    ).toHaveLength(1);
    expect((await state(a.id)).status).toBe('PENDING');
    expect((await state(b.id)).status).toBe('PENDING');
  });
  it('CP-RUT-008: ADMIN cannot change started stops, order assignment or driver; stale proposal changes nothing', async () => {
    const { route, orders } = await makeRoute();
    const urgent = await seedOrder();
    const p = await proposal(urgent.id);
    await api(
      'post',
      `/routes/${route.id}/start`,
      {},
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    const before = await history(route.id);
    const audits = await auditRows();
    const u = await db.orm.public.User.create({
      role: 'DRIVER',
      name: 'Replacement',
      email: randomUUID() + '@fixture.invalid',
      password: 'fixture',
    });
    const d = await db.orm.public.Driver.create({
      userId: u.id,
      vehicle: 'fixture',
    });
    const extra = await seedOrder();
    const draft = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: today().toString(),
        orderIds: [extra.id],
      }).expect(201)
    ).body;
    for (const body of [
      {
        action: 'REORDER',
        routeId: route.id,
        orderIds: orders.map((o) => o.id).reverse(),
      },
      { action: 'REASSIGN_DRIVER', routeId: route.id, driverId: d.id },
      {
        action: 'MOVE',
        routeId: route.id,
        targetRouteId: draft.id,
        orderId: orders[0]!.id,
      },
      { action: 'CONFIRM', orderId: urgent.id, fingerprint: p.fingerprint },
    ])
      await intervene(body).expect(409);
    expect(await history(route.id)).toEqual(before);
    expect((await state(urgent.id)).status).toBe('PENDING');
    expect(await auditRows()).toEqual(audits);
    const alternative = await proposal(urgent.id);
    expect(alternative.kind).toBe('INSERT');
    expect(alternative.routeId).toBe(draft.id);
  });
  it('start versus reorder serializes; no sequence can change after the start boundary', async () => {
    const { route, orders } = await makeRoute();
    const reordered = orders.map((o) => o.id).reverse();
    const results = await Promise.all([
      intervene({ action: 'REORDER', routeId: route.id, orderIds: reordered }),
      api('post', `/routes/${route.id}/start`, {}, ids.driverUser, 'DRIVER'),
    ]);
    expect(results[1]!.status).toBe(200);
    expect([200, 409]).toContain(results[0]!.status);
    const h = await history(route.id);
    expect(h.status).toBe('IN_PROGRESS');
    expect(h.stops.map((s: any) => s.orderId)).toEqual(
      results[0]!.status === 200 ? reordered : orders.map((o) => o.id),
    );
    await intervene({
      action: 'REORDER',
      routeId: route.id,
      orderIds: orders.map((o) => o.id),
    }).expect(409);
    expect((await history(route.id)).stops).toEqual(h.stops);
  });
  it('fault after structural writes rolls back stops, claims, order pointers and audit completely', async () => {
    const { route } = await makeRoute();
    const urgent = await seedOrder();
    const p = await proposal(urgent.id);
    const before = await history(route.id),
      beforeOrder = await state(urgent.id),
      audits = await auditRows();
    const { RouteAssignmentService } =
      await import('../src/modules/routes/route-assignment.service.js');
    const service = app.get(RouteAssignmentService);
    const original = service.replaceStops.bind(service);
    const spy = jest
      .spyOn(service, 'replaceStops')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new ConflictException('Injected structural rollback');
      });
    try {
      const response = await intervene({
        action: 'CONFIRM',
        orderId: urgent.id,
        fingerprint: p.fingerprint,
      }).expect(409);
      expect(response.body.message).toBe('Injected structural rollback');
    } finally {
      spy.mockRestore();
    }
    expect(await history(route.id)).toEqual(before);
    expect(await state(urgent.id)).toEqual(beforeOrder);
    expect(await auditRows()).toEqual(audits);
    expect((await proposal(urgent.id)).fingerprint).toBe(p.fingerprint);
  });
  it('fault after new route assignment rolls back route, driver hold and order claim', async () => {
    const order = await seedOrder();
    const p = await proposal(order.id);
    const before = await state(order.id),
      allBefore = (await api('get', '/routes').expect(200)).body,
      audits = await auditRows();
    const { RouteAssignmentService } =
      await import('../src/modules/routes/route-assignment.service.js');
    const service = app.get(RouteAssignmentService);
    const original = service.assignInTransaction.bind(service);
    const spy = jest
      .spyOn(service, 'assignInTransaction')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new ConflictException('Injected assignment rollback');
      });
    try {
      const response = await intervene({
        action: 'CONFIRM',
        orderId: order.id,
        fingerprint: p.fingerprint,
        driverId: ids.driver,
      }).expect(409);
      expect(response.body.message).toBe('Injected assignment rollback');
    } finally {
      spy.mockRestore();
    }
    expect(await state(order.id)).toEqual(before);
    expect((await api('get', '/routes').expect(200)).body).toEqual(allBefore);
    expect(await auditRows()).toEqual(audits);
    const next = await proposal(order.id);
    expect(next.availableDriverIds).toContain(ids.driver);
    expect(next.fingerprint).toBe(p.fingerprint);
  });
  it('rollback of incompatible zone/date MOVE preserves source and destination and does not consume a claim', async () => {
    const { route, orders } = await makeRoute();
    const otherZone = await db.orm.public.Zone.create({
      code: randomUUID(),
      name: randomUUID(),
      depotLat: -1.24,
      depotLng: -78.61,
    });
    const other = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: otherZone.id,
      deliveryAddress: 'Fixture',
      scheduledDeliveryDate: today(),
      deliveryLat: -1.25,
      deliveryLng: -78.62,
    });
    const target = (
      await api('post', '/routes', {
        zoneId: otherZone.id,
        routeDate: today().toString(),
        orderIds: [other.id],
      }).expect(201)
    ).body;
    const sourceBefore = await history(route.id),
      targetBefore = await history(target.id),
      orderBefore = await state(orders[0]!.id),
      audits = await auditRows();
    await intervene({
      action: 'MOVE',
      routeId: route.id,
      targetRouteId: target.id,
      orderId: orders[0]!.id,
    }).expect(409);
    expect(await history(route.id)).toEqual(sourceBefore);
    expect(await history(target.id)).toEqual(targetBefore);
    expect(await state(orders[0]!.id)).toEqual(orderBefore);
    expect(await auditRows()).toEqual(audits);
    const nextDay = today().add({ hours: 24 });
    const future = await seedOrder();
    await db.orm.public.Order.where({ id: future.id }).update({
      scheduledDeliveryDate: nextDay,
    });
    const futureRoute = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: nextDay.toString(),
        orderIds: [future.id],
      }).expect(201)
    ).body;
    await intervene({
      action: 'MOVE',
      routeId: route.id,
      targetRouteId: futureRoute.id,
      orderId: orders[0]!.id,
    }).expect(409);
    expect(await history(route.id)).toEqual(sourceBefore);
    expect(await auditRows()).toEqual(audits);
  });
  it('Swagger exposes ADMIN contracts but never permits actor identities in mutation bodies; stale-role JWT is denied', async () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth(undefined, 'JWT-auth').build(),
    );
    for (const path of [
      '/api/v1/dispatch/inbox',
      '/api/v1/dispatch/audit',
      '/api/v1/dispatch/orders/{id}/proposal',
      '/api/v1/dispatch/interventions',
    ])
      expect(doc.paths[path]).toBeDefined();
    const schema = doc.components!.schemas!.DispatchInterventionDto as any;
    expect(schema.properties.actorId).toBeUndefined();
    expect(schema.properties.action.enum).toEqual(
      expect.arrayContaining(['CONTACT', 'RESCHEDULE', 'CONFIRM']),
    );
    expect(doc.paths['/api/v1/dispatch/interventions']!.post!.security).toEqual(
      [{ 'JWT-auth': [] }],
    );
    await api('get', '/dispatch/inbox', undefined, ids.client, 'ADMIN').expect(
      403,
    );
  });
  it('CP-RUT-009: no effectively available driver keeps PENDING and exposes a blocking cause without persistence', async () => {
    for (const driver of await db.orm.public.Driver.all())
      await db.orm.public.Driver.where({ id: driver.id }).update({
        isAvailable: false,
      });
    const order = await seedOrder();
    const before = await state(order.id),
      audits = await auditRows(),
      routes = (await api('get', '/routes').expect(200)).body;
    const p = await proposal(order.id);
    expect(p.kind).toBe('BLOCKED');
    expect(p.reasons).toEqual(['NO_AVAILABLE_DRIVER']);
    expect(p.availableDriverIds).toEqual([]);
    const inbox = (await api('get', '/dispatch/inbox').expect(200)).body;
    expect(
      inbox.urgencies.find((i: any) => i.orderId === order.id).reasons,
    ).toEqual(['NO_AVAILABLE_DRIVER']);
    expect(await state(order.id)).toEqual(before);
    expect(await auditRows()).toEqual(audits);
    expect((await api('get', '/routes').expect(200)).body).toEqual(routes);
  });
  const failedOrder = async () => {
    const { route, orders } = await makeRoute(1);
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
        reason: 'RECIPIENT_ABSENT',
        context: 'private attempt context',
      },
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    const h = await history(route.id);
    await api(
      'post',
      `/routes/${route.id}/complete`,
      {},
      ids.driverUser,
      'DRIVER',
    ).expect(200);
    return {
      route,
      orderId: orders[0]!.id,
      attemptId: h.stops[0].attempts[0].id,
      stops: h.stops,
    };
  };
  it('simultaneous rescheduling with different agreed slots resolves one failure only once', async () => {
    const { route, orderId, attemptId, stops } = await failedOrder();
    const times = [
      today().add({ minutes: 20 }),
      today().add({ minutes: 30 }),
    ].map((t) => t.round({ smallestUnit: 'microsecond' }));
    const agreements = [];
    for (const time of times)
      agreements.push(
        (
          await intervene({
            action: 'CONTACT',
            orderId,
            attemptId,
            agreementConfirmed: true,
            scheduledDeliveryDate: time.toString(),
            deliveryWindowStart: time.subtract({ minutes: 5 }).toString(),
            deliveryWindowEnd: time.add({ minutes: 5 }).toString(),
          }).expect(200)
        ).body,
      );
    const before = await auditRows();
    const responses = await Promise.all(
      agreements.map((a) =>
        intervene({ action: 'RESCHEDULE', orderId, agreementId: a.id }),
      ),
    );
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    expect((await auditRows()).length).toBe(before.length + 1);
    const index = responses.findIndex((r) => r.status === 200);
    expect((await state(orderId)).scheduledDeliveryDate).toBe(
      times[index]!.toString(),
    );
    expect((await state(orderId)).status).toBe('PENDING');
    expect((await history(route.id)).stops).toEqual(stops);
  });
  it('PostgreSQL guards reject fabricated actor, audit tampering, frozen-stop rewrites and unaudited failure reset', async () => {
    const { route, orderId, stops } = await failedOrder();
    const audits = await auditRows();
    await expect(
      db.orm.public.Order.where({ id: orderId }).update({
        requiresAdministrativeReview: false,
        status: 'PENDING',
        routeId: null,
        stopOrder: null,
      }),
    ).rejects.toThrow('Failed order requires an explicit persisted agreement');
    await expect(
      db.orm.public.RouteStop.where({ id: stops[0].id }).update({
        sequence: 2,
      }),
    ).rejects.toThrow('Route stop structure is frozen');
    await expect(
      db.orm.public.DispatchIntervention.create({
        requestId: randomUUID(),
        actorId: ids.client,
        orderId,
        routeId: route.id,
        action: 'CONTACT',
        reason: 'Fabricated audit',
        outcome: 'APPLIED',
        payload: {},
        result: {},
      }),
    ).rejects.toThrow('Current ADMIN');
    const a = (
      await intervene({
        action: 'CONTACT',
        orderId,
        attemptId: stops[0].attempts[0].id,
        agreementConfirmed: false,
      }).expect(200)
    ).body;
    await expect(
      db.orm.public.DispatchIntervention.where({ id: a.id }).update({
        reason: 'Tampered',
      }),
    ).rejects.toThrow('Route evidence is append-only');
    expect((await history(route.id)).stops).toEqual(stops);
    expect((await state(orderId)).status).toBe('ASSIGNED');
    expect((await auditRows()).length).toBe(audits.length + 1);
    const inbox = (await api('get', '/dispatch/inbox').expect(200)).body;
    expect(inbox.incidents.some((i: any) => i.orderId === orderId)).toBe(true);
    expect(JSON.stringify(inbox)).not.toContain('private attempt context');
    expect(JSON.stringify(await auditRows())).not.toContain(
      'private attempt context',
    );
  });
});
