import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  execPsqlCommand,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(300_000);

/**
 * Issue #44: ausencias de repartidores y disponibilidad por fecha, sobre PostgreSQL real (contenedor propio).
 * Las rutas se crean y asignan por la API pública para comprobar que la asignación respeta la ausencia.
 */
describe('Ausencias de repartidores y disponibilidad por fecha (#44) en PostgreSQL real', () => {
  let app: INestApplication;
  let db: any;
  let jwtSign: (payload: Record<string, unknown>) => string;
  let adminToken: string;
  let clientToken: string;
  const dbName = `absences_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const zone = Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate();
  const day = (offset: number) => zone.add({ days: offset }).toString();
  const at = (offset: number) => `${day(offset)}T15:00:00Z`; // 10:00 hora de Guayaquil
  let sequence = 0;
  const next = () => `${++sequence}-${randomUUID().slice(0, 6)}`;

  /** Un repartidor nuevo (identidad + perfil) y su token. */
  const newDriver = async () => {
    const key = next();
    const userId = `du-${key}`;
    const driverId = randomUUID();
    execPsqlCommand(dbName, `
      INSERT INTO public."user" (id,name,email,password,role) VALUES ('${userId}','Repartidor ${key}','${userId}@fixture.invalid','fixture','DRIVER');
      INSERT INTO public.driver (id,"userId",vehicle,"isAvailable") VALUES ('${driverId}','${userId}','Fixture',true);
    `);
    return { driverId, userId, token: jwtSign({ sub: userId, email: `${userId}@fixture.invalid`, role: 'DRIVER' }) };
  };
  /** Pedido PENDING programado para el día `offset` (relativo a hoy). */
  const newOrder = (offset: number) => {
    const id = `ord-${next()}`;
    execPsqlCommand(dbName, `INSERT INTO public."order" (id,"userId","zoneId",status,"deliveryAddress","scheduledDeliveryDate") VALUES ('${id}','client','zone','PENDING','Fixture','${at(offset)}')`);
    return id;
  };
  const draft = (orderId: string, offset: number) => http().post('/api/v1/routes').set(auth(adminToken)).send({ zoneId: 'zone', orderIds: [orderId], routeDate: at(offset) });
  const assign = (routeId: string, driverId: string) => http().post(`/api/v1/routes/${routeId}/assign`).set(auth(adminToken)).send({ driverId });
  const absence = (driverId: string, startOffset: number, endOffset = startOffset, extra: Record<string, unknown> = {}, token = adminToken) =>
    http().post(`/api/v1/drivers/${driverId}/absences`).set(auth(token)).send({ startDate: day(startOffset), endDate: day(endOffset), ...extra });
  const availability = (driverId: string, offset = 0, token = adminToken) =>
    http().get(`/api/v1/drivers/${driverId}/availability?date=${day(offset)}`).set(auth(token));
  const count = async (model: 'DriverAbsence' | 'Route' | 'DriverReservation' | 'OrderClaim') => (await db.client.orm.public[model].all()).length;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    startOwnedContainer();
    const dbUrl = createOwnedDatabase(dbName);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = app.get(PrismaService);
    const jwt = app.get(JwtService);
    jwtSign = (payload) => jwt.sign(payload);

    execPsqlCommand(dbName, `
      INSERT INTO public."user" (id,name,email,password,role) VALUES
        ('admin','Admin','admin@fixture.invalid','fixture','ADMIN'),
        ('client','Client','client@fixture.invalid','fixture','CLIENT');
      INSERT INTO public.zone (id,name,code) VALUES ('zone','Fixture','FIXTURE');
    `);
    adminToken = jwtSign({ sub: 'admin', email: 'admin@fixture.invalid', role: 'ADMIN' });
    clientToken = jwtSign({ sub: 'client', email: 'client@fixture.invalid', role: 'CLIENT' });
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
  });

  describe('registro, consulta y anulación', () => {
    it('ADMIN registra una ausencia de hoy y mañana y la consulta; queda auditada', async () => {
      const { driverId } = await newDriver();
      const res = await absence(driverId, 0, 1, { reason: '  Cita médica  ' }).expect(201);
      expect(res.body).toMatchObject({
        driverId, startDate: day(0), endDate: day(1), reason: 'Cita médica', status: 'ACTIVE',
        createdById: 'admin', cancelledAt: null, cancelledById: null, conflicts: [],
      });
      const list = await http().get(`/api/v1/drivers/${driverId}/absences`).set(auth(adminToken)).expect(200);
      expect(list.body.map((a: any) => a.id)).toEqual([res.body.id]);
      const row = await db.client.orm.public.DriverAbsence.where({ id: res.body.id }).first();
      expect(row).toMatchObject({ driverId, startDate: day(0), endDate: day(1), createdById: 'admin' });
    });

    it('un CLIENT, un DRIVER o un anónimo no pueden registrar, consultar, anular ni ver la disponibilidad por fecha', async () => {
      const { driverId, token } = await newDriver();
      const created = await absence(driverId, 2).expect(201);
      const before = await count('DriverAbsence');
      for (const bad of [clientToken, token]) {
        await absence(driverId, 3, 3, {}, bad).expect(403);
        await http().get(`/api/v1/drivers/${driverId}/absences`).set(auth(bad)).expect(403);
        await http().post(`/api/v1/drivers/${driverId}/absences/${created.body.id}/cancel`).set(auth(bad)).send({}).expect(403);
        await availability(driverId, 0, bad).expect(403);
      }
      await http().post(`/api/v1/drivers/${driverId}/absences`).send({ startDate: day(3), endDate: day(3) }).expect(401);
      expect(await count('DriverAbsence')).toBe(before);
      expect((await db.client.orm.public.DriverAbsence.where({ id: created.body.id }).first()).cancelledAt).toBeNull();
    });

    it('valida las fechas: pasada, inexistente, rango invertido, campos no permitidos, ids inválidos y repartidor inexistente', async () => {
      const { driverId } = await newDriver();
      const before = await count('DriverAbsence');
      expect((await absence(driverId, -1, 1).expect(400)).body.code).toBe('ABSENCE_DATE_IN_PAST');
      expect((await absence(driverId, 3, 2).expect(400)).body.code).toBe('ABSENCE_RANGE_INVALID');
      expect((await http().post(`/api/v1/drivers/${driverId}/absences`).set(auth(adminToken)).send({ startDate: '2030-02-30', endDate: '2030-03-01' }).expect(400)).body.code).toBe('INVALID_DATE');
      await http().post(`/api/v1/drivers/${driverId}/absences`).set(auth(adminToken)).send({ startDate: day(1) }).expect(400);
      await http().post(`/api/v1/drivers/${driverId}/absences`).set(auth(adminToken)).send({ startDate: day(1), endDate: day(1), cancelledAt: 'x' }).expect(400);
      await absence(driverId, 1, 1, { reason: 'x'.repeat(301) }).expect(400);
      await absence('no-es-uuid', 1).expect(400);
      await absence(randomUUID(), 1).expect(404);
      expect(await count('DriverAbsence')).toBe(before);
    });

    it('rechaza rangos que se cruzan con una ausencia activa; no bloquea los contiguos ni los de una ausencia anulada', async () => {
      const { driverId } = await newDriver();
      const first = await absence(driverId, 2, 4).expect(201);
      const before = await count('DriverAbsence');
      const overlap = await absence(driverId, 4, 6).expect(409);
      expect(overlap.body).toMatchObject({ code: 'ABSENCE_OVERLAP', absenceId: first.body.id });
      expect(await count('DriverAbsence')).toBe(before);

      await absence(driverId, 5, 6).expect(201); // contiguo, sin cruce
      await http().post(`/api/v1/drivers/${driverId}/absences/${first.body.id}/cancel`).set(auth(adminToken)).send({}).expect(200);
      await absence(driverId, 2, 4).expect(201); // la anulada ya no bloquea
    });

    it('anular marca quién y cuándo, no borra el registro y no se puede repetir ni aplicar a una ausencia que ya terminó', async () => {
      const { driverId } = await newDriver();
      const created = await absence(driverId, 1, 2).expect(201);
      const cancelled = await http().post(`/api/v1/drivers/${driverId}/absences/${created.body.id}/cancel`).set(auth(adminToken)).send({ reason: 'Se reincorpora' }).expect(200);
      expect(cancelled.body).toMatchObject({ id: created.body.id, status: 'CANCELLED', cancelledById: 'admin', cancelReason: 'Se reincorpora' });
      expect(cancelled.body.cancelledAt).toEqual(expect.any(String));
      expect(await db.client.orm.public.DriverAbsence.where({ id: created.body.id }).first()).not.toBeNull();
      expect((await http().post(`/api/v1/drivers/${driverId}/absences/${created.body.id}/cancel`).set(auth(adminToken)).send({}).expect(409)).body.code).toBe('ABSENCE_ALREADY_CANCELLED');

      const active = await http().get(`/api/v1/drivers/${driverId}/absences`).set(auth(adminToken)).expect(200);
      expect(active.body).toEqual([]);
      const all = await http().get(`/api/v1/drivers/${driverId}/absences?includeCancelled=true`).set(auth(adminToken)).expect(200);
      expect(all.body.map((a: any) => a.status)).toEqual(['CANCELLED']);

      const elapsedId = randomUUID();
      execPsqlCommand(dbName, `INSERT INTO public."driverAbsence" (id,"driverId","startDate","endDate","createdById") VALUES ('${elapsedId}','${driverId}','2026-01-10','2026-01-12','admin')`);
      expect((await http().post(`/api/v1/drivers/${driverId}/absences/${elapsedId}/cancel`).set(auth(adminToken)).send({}).expect(409)).body.code).toBe('ABSENCE_ALREADY_ELAPSED');
      await http().post(`/api/v1/drivers/${driverId}/absences/${randomUUID()}/cancel`).set(auth(adminToken)).send({}).expect(404);
    });

    it('la base de datos rechaza rangos invertidos o fechas mal formadas aunque no pasen por la API', () => {
      const bad = (start: string, end: string) =>
        execPsqlCommand(dbName, `INSERT INTO public."driverAbsence" (id,"driverId","startDate","endDate","createdById") SELECT '${randomUUID()}', id, '${start}', '${end}', 'admin' FROM public.driver LIMIT 1`);
      expect(() => bad('2030-05-02', '2030-05-01')).toThrow();
      expect(() => bad('02/05/2030', '2030-05-03')).toThrow();
    });
  });

  describe('disponibilidad por fecha y asignación (ejemplos del issue)', () => {
    it('conductor sin reservas pero ausente hoy: no es elegible hoy y la asignación se rechaza con DRIVER_ABSENT sin dejar cambios', async () => {
      const { driverId } = await newDriver();
      await absence(driverId, 0).expect(201);
      const orderId = newOrder(0);
      const route = await draft(orderId, 0).expect(201);

      const today = await availability(driverId, 0).expect(200);
      expect(today.body).toMatchObject({ date: day(0), isAvailable: false, hasPersistedHolds: false, blockingRouteIds: [] });
      expect(today.body.absence).toMatchObject({ startDate: day(0), endDate: day(0) });

      const reservations = await count('DriverReservation');
      const rejected = await assign(route.body.id, driverId).expect(409);
      expect(rejected.body).toMatchObject({ code: 'DRIVER_ABSENT', absence: { startDate: day(0) } });
      expect(await count('DriverReservation')).toBe(reservations);
      expect((await db.client.orm.public.Route.where({ id: route.body.id }).first())).toMatchObject({ status: 'DRAFT', driverId: null });
      expect((await db.client.orm.public.Driver.where({ id: driverId }).first()).isAvailable).toBe(true);
    });

    it('ausencia solo mañana: no bloquea hoy (se asigna) y no inventa ninguna ruta de mañana', async () => {
      const { driverId } = await newDriver();
      await absence(driverId, 1).expect(201);
      const orderId = newOrder(0);
      const route = await draft(orderId, 0).expect(201);
      const routesBefore = await count('Route');

      const today = await availability(driverId, 0).expect(200);
      expect(today.body).toMatchObject({ date: day(0), isAvailable: true, absence: null });
      const tomorrow = await availability(driverId, 1).expect(200);
      expect(tomorrow.body).toMatchObject({ date: day(1), isAvailable: false });

      await assign(route.body.id, driverId).expect(200);
      expect(await count('Route')).toBe(routesBefore); // ninguna ruta nueva por la ausencia de mañana
    });

    it('una ruta de mañana no se confirma ni asigna antes de su día operativo; la disponibilidad refleja la ausencia solo en mañana', async () => {
      const { driverId } = await newDriver();
      await absence(driverId, 1).expect(201);
      expect((await draft(newOrder(1), 1).expect(409)).body.code).toBe('ROUTE_DATE_NOT_TODAY');
      expect((await availability(driverId, 1).expect(200)).body.isAvailable).toBe(false);
      expect((await availability(driverId, 2).expect(200)).body.isAvailable).toBe(true);
    });

    it('registrar la ausencia de quien ya tiene ruta asignada conserva ruta, pedidos y reserva y expone el conflicto', async () => {
      const { driverId } = await newDriver();
      const orderId = newOrder(0);
      const route = await draft(orderId, 0).expect(201);
      await assign(route.body.id, driverId).expect(200);

      const res = await absence(driverId, 0, 0, { reason: 'Enfermedad' }).expect(201);
      expect(res.body.conflicts).toEqual([
        { routeId: route.body.id, status: 'ASSIGNED', date: expect.any(String), orderIds: [orderId] },
      ]);
      // Nada se cancela, libera ni reasigna.
      expect(await db.client.orm.public.Route.where({ id: route.body.id }).first()).toMatchObject({ status: 'ASSIGNED', driverId });
      expect(await db.client.orm.public.Order.where({ id: orderId }).first()).toMatchObject({ routeId: route.body.id, status: 'ASSIGNED' });
      expect((await db.client.orm.public.DriverReservation.where({ driverId, releasedAt: null }).all())).toHaveLength(1);

      const view = await availability(driverId, 0).expect(200);
      expect(view.body).toMatchObject({ isAvailable: false, hasPersistedHolds: true, blockingRouteIds: [route.body.id] });
      expect(view.body.absence).not.toBeNull();
      const listed = await http().get(`/api/v1/drivers/${driverId}/absences`).set(auth(adminToken)).expect(200);
      expect(listed.body[0].conflicts).toHaveLength(1);
    });

    it('el retorno de la ruta libera su reserva pero no elimina la ausencia vigente', async () => {
      const { driverId } = await newDriver();
      const route = await draft(newOrder(0), 0).expect(201);
      await assign(route.body.id, driverId).expect(200);
      await absence(driverId, 0).expect(201);

      // Retorno físico completo: la ruta termina, se libera su reserva y se recalcula la proyección (como en route-return).
      const { RouteAvailabilityService } = await import('../src/modules/routes/route-availability.service.js');
      const availabilityService = app.get(RouteAvailabilityService);
      await db.client.transaction(async (tx: any) => {
        const now = Temporal.Now.instant();
        await tx.orm.public.Route.where({ id: route.body.id }).update({
          status: 'COMPLETED', startedAt: now, startedById: 'admin', completedAt: now, completedById: 'admin', returnedAt: now, returnedById: 'admin',
        });
        await tx.orm.public.OrderClaim.where({ routeId: route.body.id, releasedAt: null }).update({ releasedAt: now });
        await tx.orm.public.DriverReservation.where({ driverId, routeId: route.body.id, releasedAt: null }).update({ releasedAt: now });
        await availabilityService.recomputeProjection(driverId, (await tx.orm.public.Driver.where({ id: driverId }).first()).userId, tx);
      });

      const view = await availability(driverId, 0).expect(200);
      expect(view.body).toMatchObject({ hasPersistedHolds: false, compatibilityFlagBlocks: false, isAvailable: false });
      expect(view.body.absence).not.toBeNull(); // sin holds, solo la ausencia lo mantiene no elegible
    });

    it('levantar la ausencia no libera las reservas operativas pendientes', async () => {
      const { driverId } = await newDriver();
      const route = await draft(newOrder(0), 0).expect(201);
      await assign(route.body.id, driverId).expect(200);
      const created = await absence(driverId, 0).expect(201);

      await http().post(`/api/v1/drivers/${driverId}/absences/${created.body.id}/cancel`).set(auth(adminToken)).send({}).expect(200);

      const view = await availability(driverId, 0).expect(200);
      expect(view.body).toMatchObject({ absence: null, isAvailable: false, hasPersistedHolds: true, blockingRouteIds: [route.body.id] });
      expect((await db.client.orm.public.DriverReservation.where({ driverId, releasedAt: null }).all())).toHaveLength(1);
      expect((await db.client.orm.public.Route.where({ id: route.body.id }).first()).status).toBe('ASSIGNED');
    });

    it('sin reservas, anular la ausencia vuelve a hacer elegible al repartidor', async () => {
      const { driverId } = await newDriver();
      const created = await absence(driverId, 0).expect(201);
      expect((await availability(driverId, 0).expect(200)).body.isAvailable).toBe(false);
      await http().post(`/api/v1/drivers/${driverId}/absences/${created.body.id}/cancel`).set(auth(adminToken)).send({}).expect(200);
      expect((await availability(driverId, 0).expect(200)).body).toMatchObject({ isAvailable: true, absence: null });
    });

    it('la consulta de Flutter (me/availability) conserva su forma histórica', async () => {
      const { driverId, token } = await newDriver();
      await absence(driverId, 0).expect(201);
      const mine = await http().get('/api/v1/drivers/me/availability').set(auth(token)).expect(200);
      expect(Object.keys(mine.body).sort()).toEqual(['blockingRouteIds', 'compatibilityFlagBlocks', 'hasPersistedHolds', 'isAvailable']);
    });

    it('rechaza consultar la disponibilidad de una fecha pasada, inválida o de un repartidor inexistente', async () => {
      const { driverId } = await newDriver();
      expect((await availability(driverId, -1).expect(400)).body.code).toBe('AVAILABILITY_DATE_IN_PAST');
      await http().get(`/api/v1/drivers/${driverId}/availability?date=2030-13-01`).set(auth(adminToken)).expect(400);
      await availability(randomUUID(), 0).expect(404);
    });
  });

  describe('concurrencia: la asignación no puede ignorar una ausencia registrada a la vez', () => {
    it('si ambas operaciones compiten, o la ausencia gana (asignación 409 DRIVER_ABSENT) o la asignación gana y la ausencia informa el conflicto', async () => {
      const outcomes: string[] = [];
      for (let round = 0; round < 8; round++) {
        const { driverId } = await newDriver();
        const route = await draft(newOrder(0), 0).expect(201);
        const [assignment, registered] = await Promise.all([assign(route.body.id, driverId), absence(driverId, 0)]);

        expect(registered.status).toBe(201);
        if (assignment.status === 200) {
          // La asignación se confirmó antes: la ausencia debe ver la ruta y avisar al ADMIN.
          expect(registered.body.conflicts.map((c: any) => c.routeId)).toEqual([route.body.id]);
          outcomes.push('asignación primero');
        } else {
          // La ausencia se confirmó antes: la asignación debe rechazarse por ausencia y no dejar nada.
          expect(assignment.status).toBe(409);
          expect(assignment.body.code).toBe('DRIVER_ABSENT');
          expect(registered.body.conflicts).toEqual([]);
          expect(await db.client.orm.public.DriverReservation.where({ driverId }).all()).toHaveLength(0);
          expect((await db.client.orm.public.Route.where({ id: route.body.id }).first()).driverId).toBeNull();
          outcomes.push('ausencia primero');
        }
      }
      expect(outcomes).toHaveLength(8); // cada ronda cayó en uno de los dos desenlaces válidos
    });
  });
});
