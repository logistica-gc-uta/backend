import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { historyHost } from './route-history.fixtures.js';
import {
  startOwnedContainer,
  cleanupOwnedResources,
  execPsqlCommand,
} from './geolocation-migration.fixtures.js';
import { PROPOSAL_DATE } from './route-assignment.fixtures.js';
import { RouteProgressService } from '../src/modules/routes/route-progress.service.js';

const LEGACY = 'fd541a2e-d9cb-4b09-8d9d-5c21e527cb7d';
const LEGACY_FIXTURE = `
INSERT INTO public.route (id,"driverId","zoneId",date,status) VALUES ('${LEGACY}','driver','zone','${PROPOSAL_DATE}',NULL);
INSERT INTO public."routeStop" (id,"routeId","orderId",sequence,outcome,"isLegacy") VALUES
('legacy-z','${LEGACY}','three',NULL,NULL,true),
('legacy-b','${LEGACY}','four',2,NULL,true),
('legacy-a','${LEGACY}','five',2,NULL,true);
INSERT INTO public."user" (id,name,email,password,role) VALUES ('other','Other','other@fixture.invalid','fixture','DRIVER'),
('absent','No profile','absent@fixture.invalid','fixture','DRIVER');
INSERT INTO public.driver (id,"userId",vehicle) VALUES ('other-driver','other','Fixture');
`;
jest.setTimeout(120_000);
describe('Historical route reads: owned PostgreSQL16, production modules and JWT', () => {
  let host: Awaited<ReturnType<typeof historyHost>>;
  let receipt: ReturnType<typeof startOwnedContainer>;
  const oldSecret = process.env.JWT_SECRET;
  beforeAll(() => {
    receipt = startOwnedContainer();
  });
  beforeEach(async () => {
    host = await historyHost(LEGACY_FIXTURE);
  });
  afterEach(async () => {
    await host.app.close();
    await host.db.close();
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
  const get = (path: string, sub = 'admin', role = 'ADMIN') =>
    request(host.app.getHttpServer())
      .get(`/api/v1${path}`)
      .auth(host.token(sub, role), { type: 'bearer' });
  const post = (
    path: string,
    body: unknown = {},
    sub = 'admin',
    role = 'ADMIN',
  ) =>
    request(host.app.getHttpServer())
      .post(`/api/v1/routes${path}`)
      .auth(host.token(sub, role), { type: 'bearer' })
      .send(body);
  async function startedRoute() {
    // Legacy holds deliberately stay intact; this unrelated operational route uses another driver.
    const drafted = await post('', {
      zoneId: 'zone',
      orderIds: ['one'],
      routeDate: PROPOSAL_DATE,
    }).expect(201);
    await post(`/${drafted.body.id}/assign`, {
      driverId: 'other-driver',
    }).expect(200);
    await post(`/${drafted.body.id}/start`, {}, 'other', 'DRIVER').expect(200);
    const stop = await host.db.orm.public.RouteStop.where({
      routeId: drafted.body.id,
    }).first();
    return { routeId: drafted.body.id, stopId: stop!.id };
  }
  it('keeps NULL legacy outcomes, raw tied/null positions and stable associations consultable', async () => {
    const before = await host.db.orm.public.RouteStop.where({
      routeId: LEGACY,
    }).all();
    const route = (await get(`/routes/${LEGACY}`).expect(200)).body;
    expect(route.status).toBe('UNVERIFIED');
    expect(route.events).toEqual([]);
    expect(
      route.stops.map((stop: any) => [stop.id, stop.sequence, stop.outcome]),
    ).toEqual([
      ['legacy-a', 2, null],
      ['legacy-b', 2, null],
      ['legacy-z', null, null],
    ]);
    expect(
      route.orders.map((order: any) => [order.id, order.stopOrder]),
    ).toEqual([
      ['five', 2],
      ['four', 2],
      ['three', null],
    ]);
    const owned = (
      await get('/drivers/me/routes', 'driver-user', 'DRIVER').expect(200)
    ).body;
    expect(owned[0].stops).toEqual(route.stops);
    expect(Object.keys(owned[0].orders[0]).sort()).toEqual([
      'deliveryAddress',
      'id',
      'scheduledDeliveryDate',
      'status',
      'stopOrder',
    ]);
    expect(
      await host.db.orm.public.RouteStop.where({ routeId: LEGACY }).all(),
    ).toEqual(before);
  });
  it('preserves first failed visit after a later stable association and current commercial pointer move', async () => {
    const { routeId, stopId } = await startedRoute();
    const failure = await post(
      `/${routeId}/stops/${stopId}/failure`,
      {
        reason: 'RECIPIENT_ABSENT',
        context: 'No recipient on first visit',
        requestId: randomUUID(),
      },
      'other',
      'DRIVER',
    ).expect(200);
    const future = randomUUID();
    // Fixture-only future association: no administrative rescheduling API is implemented.
    execPsqlCommand(
      host.database,
      `
      UPDATE public.route SET status='COMPLETED',"completedAt"='2026-10-10T12:00:00Z',"completedById"='other' WHERE id='${routeId}';
      UPDATE public."orderClaim" SET "releasedAt"='2026-10-10T12:00:00Z' WHERE "routeId"='${routeId}';
      INSERT INTO public.route (id,"driverId","zoneId",date,status) VALUES ('${future}','driver','zone','2026-10-20T00:00:00Z','ASSIGNED');
      INSERT INTO public."driverReservation" (id,"routeId","driverId","reservedAt") VALUES ('future-res','${future}','driver',now());
      INSERT INTO public."routeStop" (id,"routeId","orderId",sequence,outcome,"createdAt") VALUES ('future-stop','${future}','one',1,'PENDING','2026-10-20T00:00:00Z');
      INSERT INTO public."orderClaim" (id,"routeId","orderId","claimedAt") VALUES ('future-claim','${future}','one',now());
      UPDATE public."order" SET "routeId"='${future}',"stopOrder"=1,"deliveryAddress"='Current address',"scheduledDeliveryDate"='2026-10-20T00:00:00Z' WHERE id='one';
    `,
    );
    const historic = (await get(`/routes/${routeId}`).expect(200)).body;
    expect(historic.date).toBe('2026-10-10T00:00:00Z');
    expect(historic.stops[0]).toMatchObject({
      id: stopId,
      routeId,
      orderId: 'one',
      sequence: 1,
      outcome: 'FAILED',
    });
    expect(historic.stops[0].attempts[0]).toMatchObject({
      id: failure.body.id,
      driverId: 'other-driver',
      outcome: 'FAILED',
      failureReason: 'RECIPIENT_ABSENT',
      context: 'No recipient on first visit',
    });
    expect(historic.events).toEqual([
      { kind: 'STARTED', actorId: 'other', recordedAt: expect.any(String) },
      { kind: 'COMPLETED', actorId: 'other', recordedAt: '2026-10-10T12:00:00Z' },
    ]);
    expect(historic.orders[0]).toMatchObject({
      id: 'one',
      stopOrder: 1,
      deliveryAddress: 'Current address',
      scheduledDeliveryDate: '2026-10-20T00:00:00Z',
    });
    const owned = (
      await get('/drivers/me/routes', 'other', 'DRIVER').expect(200)
    ).body;
    expect(owned.find((route: any) => route.id === routeId).stops).toEqual(
      historic.stops,
    );
    expect(owned.some((route: any) => route.id === future)).toBe(false);
    expect(
      (
        await get('/drivers/me/routes', 'driver-user', 'DRIVER').expect(200)
      ).body.some((route: any) => route.id === routeId),
    ).toBe(false);
    // Existing direct-order DRIVER authorization intentionally follows the live operational pointer.
    await get('/orders/one', 'other', 'DRIVER').expect(403);
    expect(
      (await get(`/routes/${future}`).expect(200)).body.stops[0].outcome,
    ).toBe('PENDING');
    expect(
      (await host.db.orm.public.Order.where({ id: 'one' }).first())?.routeId,
    ).toBe(future);
  });
  it('preserves date query validation, role boundaries, empty results and missing-route 404', async () => {
    await get('/routes', 'driver-user', 'DRIVER').expect(403);
    await get(`/routes/${LEGACY}`, 'other', 'DRIVER').expect(403);
    await get('/drivers/me/routes', 'admin').expect(403);
    await request(host.app.getHttpServer())
      .get('/api/v1/drivers/me/routes')
      .expect(401);
    expect(
      (await get('/drivers/me/routes', 'absent', 'DRIVER').expect(200)).body,
    ).toEqual([]);
    expect(
      (
        await get(
          '/drivers/me/routes?date=2026-10-11',
          'driver-user',
          'DRIVER',
        ).expect(200)
      ).body,
    ).toEqual([]);
    expect(
      (
        await get(
          '/drivers/me/routes?date=2026-10-09',
          'driver-user',
          'DRIVER',
        ).expect(200)
      ).body,
    ).toHaveLength(1);
    for (const query of [
      'date=2026-02-30',
      'driverId=driver',
      'date=2026-10-09&date=2026-10-10',
    ])
      await get(`/drivers/me/routes?${query}`, 'driver-user', 'DRIVER').expect(
        400,
      );
    await get(`/routes/${randomUUID()}`).expect(404);
    expect((await get('/routes').expect(200)).body).toHaveLength(1);
  });
  it('derives DRIVER order and visit actors only from persisted JWT identity', async () => {
    const { routeId, stopId } = await startedRoute();
    const payload = {
      reason: 'RECIPIENT_ABSENT',
      context: 'No recipient',
      requestId: randomUUID(),
    };
    await post(
      `/${routeId}/stops/${stopId}/failure`,
      payload,
      'driver-user',
      'DRIVER',
    ).expect(403);
    await post(
      `/${routeId}/stops/${stopId}/failure`,
      { ...payload, driverId: 'driver' },
      'other',
      'DRIVER',
    ).expect(400);
    const patch = (sub: string, body: unknown) =>
      request(host.app.getHttpServer())
        .patch('/api/v1/orders/one/status')
        .auth(host.token(sub, 'DRIVER'), { type: 'bearer' })
        .send(body);
    await patch('driver-user', { status: 'IN_TRANSIT' }).expect(403);
    await patch('other', {
      status: 'IN_TRANSIT',
      userId: 'driver-user',
    }).expect(400);
    await patch('other', { status: 'IN_TRANSIT' }).expect(200);
    expect(
      (await host.db.orm.public.Order.where({ id: 'one' }).first())?.status,
    ).toBe('IN_TRANSIT');
    expect(
      await host.db.orm.public.DeliveryAttempt.where({ stopId }).all(),
    ).toEqual([]);
  });
  it('rolls back an injected failed-visit write and leaves history/current commercial state unchanged', async () => {
    const { routeId, stopId } = await startedRoute();
    const before = (await get(`/routes/${routeId}`).expect(200)).body;
    const service: any = host.app.get(RouteProgressService);
    const spy = jest.spyOn(service, 'response').mockImplementationOnce(() => {
      throw new Error('injected after attempt');
    });
    try {
      await post(
        `/${routeId}/stops/${stopId}/failure`,
        {
          reason: 'RECIPIENT_ABSENT',
          context: 'No recipient',
          requestId: randomUUID(),
        },
        'other',
        'DRIVER',
      ).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect((await get(`/routes/${routeId}`).expect(200)).body).toEqual(before);
    expect(
      await host.db.orm.public.DeliveryAttempt.where({ stopId }).all(),
    ).toEqual([]);
    expect(
      (await host.db.orm.public.Order.where({ id: 'one' }).first())?.status,
    ).toBe('ASSIGNED');
  });
  it('uses role-specific typed Swagger that matches retained ADMIN and restricted DRIVER payloads', async () => {
    const doc = SwaggerModule.createDocument(
      host.app,
      new DocumentBuilder().build(),
    );
    const response = (path: string) =>
      (doc.paths[path].get!.responses['200'] as any).content['application/json']
        .schema;
    expect(response('/api/v1/routes')).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/AdminRouteHistoryResponseDto' },
    });
    expect(response('/api/v1/routes/{id}')).toEqual({
      $ref: '#/components/schemas/AdminRouteHistoryResponseDto',
    });
    expect(response('/api/v1/drivers/me/routes')).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/RouteHistoryResponseDto' },
    });
    expect(
      doc.components!.schemas!.RouteHistoryResponseDto.properties!.stops,
    ).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/RouteHistoryStopDto' },
    });
    const schemas: any = doc.components!.schemas;
    const admin = (await get(`/routes/${LEGACY}`).expect(200)).body;
    const owned = (
      await get('/drivers/me/routes', 'driver-user', 'DRIVER').expect(200)
    ).body[0];
    expect(Object.keys(admin).sort()).toEqual(
      Object.keys(schemas.AdminRouteHistoryResponseDto.properties).sort(),
    );
    expect(Object.keys(admin.orders[0]).sort()).toEqual(
      Object.keys(schemas.AdminRouteHistoryOrderDto.properties).sort(),
    );
    expect(Object.keys(admin.driver).sort()).toEqual(
      Object.keys(schemas.AdminRouteHistoryDriverDto.properties).sort(),
    );
    expect(Object.keys(admin.driver.user).sort()).toEqual(
      Object.keys(schemas.AdminRouteHistoryUserDto.properties).sort(),
    );
    expect(Object.keys(admin.zone).sort()).toEqual(
      Object.keys(schemas.AdminRouteHistoryZoneDto.properties).sort(),
    );
    expect(Object.keys(owned).sort()).toEqual(
      Object.keys(schemas.RouteHistoryResponseDto.properties).sort(),
    );
    expect(Object.keys(owned.zone).sort()).toEqual(
      Object.keys(schemas.RouteHistoryZoneDto.properties).sort(),
    );
    expect(schemas.RouteHistoryResponseDto.properties.driver).toBeUndefined();
    expect(Object.keys(owned.orders[0]).sort()).toEqual(
      Object.keys(schemas.RouteHistoryOrderDto.properties).sort(),
    );
    expect(schemas.RouteHistoryResponseDto.properties.status.enum).toEqual([
      'UNVERIFIED',
      'DRAFT',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
    ]);
  });
});
