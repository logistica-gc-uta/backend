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
describe('Independent Issue 12 assigned pre-start agreement probe', () => {
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  const oldSecret = process.env.JWT_SECRET;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const ids = {
    admin: randomUUID(),
    client: randomUUID(),
    driverUser: randomUUID(),
    driver: randomUUID(),
    zone: randomUUID(),
  };
  const token = () =>
    jwt.sign({ sub: ids.admin, role: 'ADMIN', email: 'fixture@invalid.test' });
  const api = (method: 'get' | 'post' | 'patch', path: string, body?: object) =>
    request(app.getHttpServer())
      [method]('/api/v1' + path)
      .auth(token(), { type: 'bearer' })
      .send(body);
  const instant = () => Temporal.Now.instant();
  const seedOrder = () =>
    db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      deliveryAddress: 'Stable commercial order',
      scheduledDeliveryDate: instant(),
      deliveryLat: -1.25,
      deliveryLng: -78.62,
    });
  const history = async (routeId: string) =>
    (await api('get', `/routes/${routeId}`).expect(200)).body;
  const audit = async () =>
    (await api('get', '/dispatch/audit').expect(200)).body as any[];
  const intervene = (body: Record<string, unknown>) =>
    api('post', '/dispatch/interventions', {
      requestId: randomUUID(),
      reason: 'Independent persisted-agreement probe',
      ...body,
    });
  const summary = (row: any) => ({
    id: row.id,
    routeId: row.routeId,
    orderId: row.orderId,
    sequence: row.sequence ?? null,
    claimedAt: row.claimedAt?.toString() ?? null,
    releasedAt: row.releasedAt?.toString() ?? null,
  });

  beforeAll(async () => {
    startOwnedContainer();
    const url = createOwnedDatabase(
      'dispatch_probe_' + randomUUID().replaceAll('-', '').slice(0, 8),
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
        password: 'fixture-only',
      });
    await db.orm.public.Driver.create({
      id: ids.driver,
      userId: ids.driverUser,
      vehicle: 'fixture',
    });
    await db.orm.public.Zone.create({
      id: ids.zone,
      code: 'PROBE',
      name: 'Probe',
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
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  });

  it('detaches only the agreed order, preserves source evidence/reservation, rejects missing/consumed agreements, and keeps ordinary cancellation available', async () => {
    const orders = [await seedOrder(), await seedOrder()];
    const route = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: instant().toString(),
        orderIds: orders.map((o) => o.id),
      }).expect(201)
    ).body;
    await api('post', `/routes/${route.id}/assign`, {
      driverId: ids.driver,
    }).expect(200);
    const target = orders[1]!; // Remove the second stop so the retained first stop keeps sequence 1.
    const retainedOrder = orders[0]!;
    const beforeHistory = await history(route.id);
    const retainedBefore = beforeHistory.stops.find(
      (s: any) => s.orderId === retainedOrder.id,
    );
    const targetBefore = beforeHistory.stops.find(
      (s: any) => s.orderId === target.id,
    );
    expect(targetBefore.sequence).toBe(2);
    const beforeCommercial = (
      await api('get', `/orders/${target.id}`).expect(200)
    ).body;
    const targetClaimsBefore = (
      await db.orm.public.OrderClaim.where({ orderId: target.id }).all()
    ).map(summary);
    const retainedClaimsBefore = (
      await db.orm.public.OrderClaim.where({
        orderId: retainedOrder.id,
        releasedAt: null,
      }).all()
    ).map(summary);
    const reservationBefore = (
      await db.orm.public.DriverReservation.where({
        routeId: route.id,
        driverId: ids.driver,
        releasedAt: null,
      }).all()
    ).map(summary);
    const beforeAuditCount = (await audit()).length;

    const missing = await intervene({
      action: 'RESCHEDULE',
      orderId: target.id,
      agreementId: randomUUID(),
    });
    expect(missing.status).toBe(409);
    expect(await history(route.id)).toEqual(beforeHistory);
    expect((await api('get', `/orders/${target.id}`).expect(200)).body).toEqual(
      beforeCommercial,
    );
    expect((await audit()).length).toBe(beforeAuditCount);

    const scheduled = Temporal.Now.zonedDateTimeISO('America/Guayaquil')
      .add({ days: 1 })
      .with({
        hour: 12,
        minute: 0,
        second: 0,
        millisecond: 0,
        microsecond: 0,
        nanosecond: 0,
      })
      .toInstant()
      .round({ smallestUnit: 'microsecond' });
    const contact = (
      await intervene({
        action: 'CONTACT',
        orderId: target.id,
        agreementConfirmed: true,
        scheduledDeliveryDate: scheduled.toString(),
        deliveryWindowStart: scheduled.subtract({ minutes: 10 }).toString(),
        deliveryWindowEnd: scheduled.add({ minutes: 10 }).toString(),
      }).expect(200)
    ).body;
    expect(contact.action).toBe('CONTACT');
    expect(await history(route.id)).toEqual(beforeHistory);
    expect((await api('get', `/orders/${target.id}`).expect(200)).body).toEqual(
      beforeCommercial,
    );
    const decision = (
      await intervene({
        action: 'RESCHEDULE',
        orderId: target.id,
        agreementId: contact.id,
      }).expect(200)
    ).body;
    expect(decision.action).toBe('RESCHEDULE');
    expect(decision.actorId).toBe(ids.admin);

    const afterHistory = await history(route.id);
    expect(afterHistory.stops).toHaveLength(1);
    expect(afterHistory.stops[0]).toMatchObject({
      id: retainedBefore.id,
      orderId: retainedOrder.id,
      sequence: 1,
      outcome: retainedBefore.outcome,
    });
    expect(afterHistory.driverId).toBe(ids.driver);
    const afterOrder = (await api('get', `/orders/${target.id}`).expect(200))
      .body;
    expect(afterOrder).toMatchObject({
      id: target.id,
      deliveryAddress: beforeCommercial.deliveryAddress,
      status: 'PENDING',
      routeId: null,
    });
    expect(
      Temporal.Instant.compare(
        Temporal.Instant.from(afterOrder.scheduledDeliveryDate),
        scheduled,
      ),
    ).toBe(0);
    const targetClaimsAfter = (
      await db.orm.public.OrderClaim.where({ orderId: target.id }).all()
    ).map(summary);
    expect(targetClaimsAfter).toHaveLength(targetClaimsBefore.length);
    expect(targetClaimsAfter[0]).toMatchObject({
      id: targetClaimsBefore[0]!.id,
      releasedAt: expect.any(String),
    });
    expect(
      (
        await db.orm.public.OrderClaim.where({
          orderId: retainedOrder.id,
          releasedAt: null,
        }).all()
      ).map(summary),
    ).toEqual(retainedClaimsBefore);
    expect(
      (
        await db.orm.public.DriverReservation.where({
          routeId: route.id,
          driverId: ids.driver,
          releasedAt: null,
        }).all()
      ).map(summary),
    ).toEqual(reservationBefore);
    expect(
      (await db.orm.public.Driver.where({ id: ids.driver }).first())!
        .isAvailable,
    ).toBe(false);

    const beforeConsumedRejectHistory = await history(route.id);
    const beforeConsumedRejectOrder = (
      await api('get', `/orders/${target.id}`).expect(200)
    ).body;
    const beforeConsumedRejectAudit = await audit();
    const consumed = await intervene({
      action: 'RESCHEDULE',
      orderId: target.id,
      agreementId: contact.id,
    });
    expect(consumed.status).toBe(409);
    expect(await history(route.id)).toEqual(beforeConsumedRejectHistory);
    expect((await api('get', `/orders/${target.id}`).expect(200)).body).toEqual(
      beforeConsumedRejectOrder,
    );
    expect((await audit()).length).toBe(beforeConsumedRejectAudit.length);
    const targetAudits = (await audit()).filter((a) => a.orderId === target.id);
    expect(targetAudits.map((a) => a.action).sort((a, b) => a.localeCompare(b))).toEqual([
      'CONTACT',
      'RESCHEDULE',
    ]);

    // Regression canary: the new failed-order hold must not disable the old, ordinary ADMIN cancellation path.
    const cancellable = await seedOrder();
    expect(
      (
        await api('patch', `/orders/${cancellable.id}/status`, {
          status: 'CANCELLED',
        }).expect(200)
      ).body.status,
    ).toBe('CANCELLED');
  });
});
