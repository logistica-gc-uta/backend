import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from '../src/prisma/contract.d';
import contractJson from '../src/prisma/contract.json' with { type: 'json' };
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  execPsqlCommand,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(180_000);

// Immediately preceding committed migration (20261119T1543_route_cancellation) contract hash.
const PRE_READINESS_CONTRACT_HASH =
  '1b4e7632062d3ea2fdbb235d224cf37ae0a5daaddd961bcce901eb985e47d9a6';

describe('Failed-delivery readiness upgrade & pre-migration MOVE out/back legacy compatibility (T4 / S3, owned PostgreSQL)', () => {
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const oldSecret = process.env.JWT_SECRET;
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let receipt: ReturnType<typeof startOwnedContainer>;
  let database: string;
  let databaseUrl: string;

  const ids = {
    admin: randomUUID(),
    client: randomUUID(),
    driverUser1: randomUUID(),
    driverUser2: randomUUID(),
    driver1: randomUUID(),
    driver2: randomUUID(),
    zone: randomUUID(),
  };

  const token = (sub: string, role = 'ADMIN') =>
    jwt.sign({ sub, role, email: `${sub}@fixture.invalid` });

  const api = (
    method: 'get' | 'post' | 'patch',
    path: string,
    body?: object,
    sub = ids.admin,
    role = 'ADMIN',
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .auth(token(sub, role), { type: 'bearer' });
    return body === undefined ? req : req.send(body);
  };

  const intervene = (
    body: Record<string, unknown>,
    sub = ids.admin,
    role = 'ADMIN',
  ) =>
    api(
      'post',
      '/dispatch/interventions',
      {
        requestId: randomUUID(),
        reason: 'Pre-migration upgrade verification',
        ...body,
      },
      sub,
      role,
    );

  const todayInstant = () =>
    Temporal.Now.instant().round({ smallestUnit: 'microsecond' });

  const futureSlotSameOrNextDay = (minutesAhead = 25) => {
    const zone = 'America/Guayaquil';
    const soon = Temporal.Now.instant()
      .add({ minutes: minutesAhead })
      .round({ smallestUnit: 'microsecond' });
    const start = soon.subtract({ minutes: 5 });
    const end = soon.add({ minutes: 5 });
    const day = (i: Temporal.Instant) =>
      i.toZonedDateTimeISO(zone).toPlainDate().toString();
    if (day(start) === day(end)) {
      return {
        scheduledDeliveryDate: soon,
        deliveryWindowStart: start,
        deliveryWindowEnd: end,
      };
    }
    const noonTomorrow = Temporal.Now.zonedDateTimeISO(zone)
      .toPlainDate()
      .add({ days: 1 })
      .toZonedDateTime({ timeZone: zone, plainTime: '12:00' })
      .toInstant()
      .round({ smallestUnit: 'microsecond' });
    return {
      scheduledDeliveryDate: noonTomorrow,
      deliveryWindowStart: noonTomorrow.subtract({ minutes: 10 }),
      deliveryWindowEnd: noonTomorrow.add({ minutes: 10 }),
    };
  };

  const seedOrder = async () =>
    db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      deliveryAddress: 'Av. Upgrade 456',
      scheduledDeliveryDate: todayInstant(),
      deliveryLat: -1.25,
      deliveryLng: -78.62,
    });

  beforeAll(async () => {
    receipt = startOwnedContainer();
    process.env.JWT_SECRET = secret;
    database = `failed_upg_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    databaseUrl = createOwnedDatabase(database);
    // Stop strictly at the pre-readiness schema (20261119T1543_route_cancellation).
    runPrismaMigrate(databaseUrl, PRE_READINESS_CONTRACT_HASH);
    // #82: la aplicación lee el estado administrativo del repartidor (`driver.isActive`) en cada asignación, también en esta fase
    // "antes de la migración". Se agregan solo esas columnas (con los mismos valores por defecto) y la migración real de #82 se
    // aplica después de forma idempotente; lo que se prueba aquí es la mejora de la entrega fallida, no ese estado.
    execPsqlCommand(
      database,
      `ALTER TABLE public.driver
         ADD COLUMN IF NOT EXISTS "isActive" boolean NOT NULL DEFAULT true,
         ADD COLUMN IF NOT EXISTS "statusChangedAt" timestamptz,
         ADD COLUMN IF NOT EXISTS "statusChangedById" text,
         ADD COLUMN IF NOT EXISTS "statusReason" text;`,
    );

    db = postgres<Contract>({ contractJson, url: databaseUrl });
    for (const [id, role] of [
      [ids.admin, 'ADMIN'],
      [ids.client, 'CLIENT'],
      [ids.driverUser1, 'DRIVER'],
      [ids.driverUser2, 'DRIVER'],
    ] as const) {
      await db.orm.public.User.create({
        id,
        role,
        name: role,
        email: `${id}@fixture.invalid`,
        password: 'fixture',
      });
    }
    // La base está en un esquema anterior: los repartidores se insertan solo con las columnas que ya existían (#82 agrega `isActive`).
    execPsqlCommand(
      database,
      `INSERT INTO public.driver (id, "userId", vehicle) VALUES
        ('${ids.driver1}', '${ids.driverUser1}', 'Upgrade Van 1'),
        ('${ids.driver2}', '${ids.driverUser2}', 'Upgrade Van 2');`,
    );
    await db.orm.public.Zone.create({
      id: ids.zone,
      code: 'UPG',
      name: 'Upgrade Zone',
      depotLat: -1.24,
      depotLng: -78.61,
    });

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        client: db,
        orm: db.orm,
        sql: db.sql,
        user: db.orm.public.User,
        product: db.orm.public.Product,
        order: db.orm.public.Order,
        orderItem: db.orm.public.OrderItem,
        driver: db.orm.public.Driver,
        route: db.orm.public.Route,
        routeStop: db.orm.public.RouteStop,
        zone: db.orm.public.Zone,
        onModuleDestroy: async () => undefined,
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
    if (app) await app.close();
    if (db) await db.close();
    if (receipt) cleanupOwnedResources();
  });

  it('upgrades a live DB containing an audited pre-start MOVE out/back and a legacy active-claim FAILED stop, preserves history, completes cleanly, and unlocks readiness', async () => {
    const orderMoved = await seedOrder();
    const orderPending = await seedOrder();
    const orderOther = await seedOrder();

    // 1. Pre-migration: create two ASSIGNED pre-start routes.
    const route1 = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: todayInstant().toString(),
        orderIds: [orderMoved.id, orderPending.id],
      }).expect(201)
    ).body;
    await api('post', `/routes/${route1.id}/assign`, {
      driverId: ids.driver1,
    }).expect(200);

    const route2 = (
      await api('post', '/routes', {
        zoneId: ids.zone,
        routeDate: todayInstant().toString(),
        orderIds: [orderOther.id],
      }).expect(201)
    ).body;
    await api('post', `/routes/${route2.id}/assign`, {
      driverId: ids.driver2,
    }).expect(200);

    // 2. Pre-migration: audited MOVE out of route1 to route2, then MOVE back to route1.
    //    This leaves a real historical released OrderClaim on (route1, orderMoved) plus a new active OrderClaim.
    await intervene({
      action: 'MOVE',
      orderId: orderMoved.id,
      routeId: route1.id,
      targetRouteId: route2.id,
      reason: 'Pre-start rebalance out',
    }).expect(200);
    await intervene({
      action: 'MOVE',
      orderId: orderMoved.id,
      routeId: route2.id,
      targetRouteId: route1.id,
      reason: 'Pre-start rebalance back',
    }).expect(200);

    const preStartClaims = await db.orm.public.OrderClaim.where({
      routeId: route1.id,
      orderId: orderMoved.id,
    }).all();
    expect(preStartClaims).toHaveLength(2);
    const moveOutClaim = preStartClaims.find((c) => c.releasedAt !== null);
    const activeClaim = preStartClaims.find((c) => c.releasedAt === null);
    expect(moveOutClaim).toBeDefined();
    expect(activeClaim).toBeDefined();
    const originalMoveOutRelease = moveOutClaim!.releasedAt!.toString();

    // 3. Pre-migration: start route1 and record a true legacy FAILED visit (claim remains active/unreleased).
    await api(
      'post',
      `/routes/${route1.id}/start`,
      {},
      ids.driverUser1,
      'DRIVER',
    ).expect(200);
    const detail1 = (await api('get', `/routes/${route1.id}`).expect(200)).body;
    const stopMoved = detail1.stops.find(
      (s: any) => s.orderId === orderMoved.id,
    );
    const legacyAttemptId = randomUUID();
    const legacyContext = 'Pre-migration failed delivery after MOVE out/back';
    const legacyPayload = JSON.stringify({
      actorId: ids.driverUser1,
      reason: 'RECIPIENT_ABSENT',
      context: legacyContext,
    });
    execPsqlCommand(
      database,
      `BEGIN;
       INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", "recordedAt", outcome, "failureReason", context, "idempotencyKey", "requestPayload")
       VALUES ('${legacyAttemptId}', '${stopMoved.id}', '${ids.driver1}', clock_timestamp(), 'FAILED', 'RECIPIENT_ABSENT', '{"description":"${legacyContext}"}'::json, '${randomUUID()}', '${legacyPayload}'::json);
       UPDATE public."routeStop" SET outcome = 'FAILED' WHERE id = '${stopMoved.id}';
       UPDATE public."order" SET "requiresAdministrativeReview" = true WHERE id = '${orderMoved.id}';
       COMMIT;`,
    );

    // 4. Apply forward migration 20261119T1717_failed_delivery_readiness on top of this live state.
    runPrismaMigrate(databaseUrl);
    execFileSync('pnpm', ['prisma', 'db', 'verify', '--db', databaseUrl], {
      env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' },
      stdio: 'pipe',
    });

    // 5. Post-migration: inbox reflects legacy unreleased claim (CONTACT allowed, readiness blocked until claim release).
    const inboxBeforeComplete = (
      await api('get', '/dispatch/inbox').expect(200)
    ).body;
    const incBefore = inboxBeforeComplete.incidents.find(
      (i: any) => i.orderId === orderMoved.id,
    );
    expect(incBefore).toMatchObject({
      orderId: orderMoved.id,
      ownership: 'FAILED_DELIVERY',
      status: 'WAITING_STORE_READINESS',
      latestFailedAttemptId: legacyAttemptId,
      readiness: null,
    });
    expect(incBefore.allowedActions.CONTACT.allowed).toBe(true);
    expect(incBefore.allowedActions.CONFIRM_INCIDENT_READY.reasonCode).toBe(
      'CLAIM_NOT_RELEASED',
    );
    expect(
      (
        await intervene({
          action: 'CONFIRM_INCIDENT_READY',
          orderId: orderMoved.id,
          attemptId: legacyAttemptId,
        }).expect(409)
      ).body.code,
    ).toBe('CLAIM_NOT_RELEASED');

    // 6. Post-migration: deliver the remaining stop on route1 (exercises SQL route coherence on route1
    //    while orderMoved still has active legacy claim + earlier MOVE-out released claim).
    await api(
      'patch',
      `/orders/${orderPending.id}/status`,
      { status: 'IN_TRANSIT' },
      ids.driverUser1,
      'DRIVER',
    ).expect(200);
    await api(
      'patch',
      `/orders/${orderPending.id}/status`,
      { status: 'DELIVERED' },
      ids.driverUser1,
      'DRIVER',
    ).expect(200);

    // 7. Complete route1: classifies orderMoved as ACTIVE_LEGACY, releases only activeClaim at completedAt,
    //    and leaves moveOutClaim.releasedAt completely unchanged.
    const completed = (
      await api(
        'post',
        `/routes/${route1.id}/complete`,
        {},
        ids.driverUser1,
        'DRIVER',
      ).expect(200)
    ).body;
    expect(completed.status).toBe('COMPLETED');

    const claimsAfterComplete = await db.orm.public.OrderClaim.where({
      routeId: route1.id,
      orderId: orderMoved.id,
    }).all();
    expect(claimsAfterComplete).toHaveLength(2);
    expect(
      claimsAfterComplete.find((c) => c.id === moveOutClaim!.id)?.releasedAt?.toString(),
    ).toBe(originalMoveOutRelease);
    expect(
      claimsAfterComplete.find((c) => c.id === activeClaim!.id)?.releasedAt?.toString(),
    ).toBe(completed.completedAt);

    // 8. Readiness + CONTACT + RESCHEDULE now succeed for the upgraded legacy failed order.
    const ready = (
      await intervene({
        action: 'CONFIRM_INCIDENT_READY',
        orderId: orderMoved.id,
        attemptId: legacyAttemptId,
        reason: 'Returned parcel verified at store after upgrade',
      }).expect(200)
    ).body;
    expect(ready.outcome).toBe('APPLIED');

    const slot = futureSlotSameOrNextDay(25);
    const contact = (
      await intervene({
        action: 'CONTACT',
        orderId: orderMoved.id,
        attemptId: legacyAttemptId,
        agreementConfirmed: true,
        scheduledDeliveryDate: slot.scheduledDeliveryDate.toString(),
        deliveryWindowStart: slot.deliveryWindowStart.toString(),
        deliveryWindowEnd: slot.deliveryWindowEnd.toString(),
      }).expect(200)
    ).body;
    const rescheduled = (
      await intervene({
        action: 'RESCHEDULE',
        orderId: orderMoved.id,
        agreementId: contact.id,
      }).expect(200)
    ).body;
    expect(rescheduled.outcome).toBe('APPLIED');
    expect(
      await db.orm.public.Order.where({ id: orderMoved.id }).first(),
    ).toMatchObject({
      status: 'PENDING',
      routeId: null,
      requiresAdministrativeReview: false,
    });
  });
});
