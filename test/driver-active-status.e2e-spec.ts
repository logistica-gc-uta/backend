import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from '../src/prisma/contract.d';
import contractJson from '../src/prisma/contract.json' with { type: 'json' };
import { hashNewPassword } from '../src/modules/auth/password-hash.util.js';
import {
  startOwnedContainer,
  createOwnedDatabase,
  runPrismaMigrate,
  execPsqlCommand,
  cleanupOwnedResources,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(300000);

// Contrato inmediatamente anterior a la baja operativa (#82): sirve para probar la migración de cuentas existentes.
const BEFORE_STATUS = '973c66fbba6fd6fb7bc1926da46af1dd3efe74ca17073eb430209d58d890e95c';

/**
 * Issue #82: baja operativa reversible de repartidores, sobre PostgreSQL real (contenedor propio) y JWT reales.
 * La baja y la reactivación van por la API pública de ADMIN; el estado persistido se lee de la base de datos.
 */
describe('Baja operativa de repartidores (#82): PostgreSQL + JWT HTTP', () => {
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let base = '';
  const sockets: Socket[] = [];
  const realtimeOrigin = 'https://fixture.example';
  const previousOrigins = process.env.REALTIME_ALLOWED_ORIGINS;
  const secret = randomUUID() + randomUUID();
  const jwt = new JwtService({ secret });
  const password = 'Clave-de-prueba-' + randomUUID().slice(0, 8);
  const ids = { admin: randomUUID(), admin2: randomUUID(), client: randomUUID(), zone: randomUUID(), legacyUser: randomUUID(), legacyDriver: randomUUID() };
  const token = (sub: string, role: string) => jwt.sign({ sub, role, email: 'fixture@invalid.test' }, { expiresIn: '1h' });
  const api = (method: 'get' | 'post', path: string, body?: object, sub = ids.admin, role = 'ADMIN') =>
    request(app.getHttpServer())[method]('/api/v1' + path).auth(token(sub, role), { type: 'bearer' }).send(body);
  const now = () => Temporal.Now.instant();
  const tomorrow = () => Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate().add({ days: 1 }).toString();

  /** Repartidor nuevo con usuario propio y contraseña conocida (para probar el login real). */
  const makeDriver = async (label = 'driver') => {
    const userId = randomUUID();
    const driverId = randomUUID();
    const email = `${label}-${userId.slice(0, 8)}@fixture.invalid`;
    await db.orm.public.User.create({ id: userId, role: 'DRIVER', name: label, email, password: await hashNewPassword(password) });
    await db.orm.public.Driver.create({ id: driverId, userId, vehicle: 'Van' });
    return { userId, driverId, email };
  };
  const deactivate = (driverId: string, body: object = { reason: 'Baja operativa de prueba' }, sub = ids.admin) => api('post', `/drivers/${driverId}/deactivate`, body, sub);
  const activate = (driverId: string, body: object = {}, sub = ids.admin) => api('post', `/drivers/${driverId}/activate`, body, sub);
  const stateOf = async (driverId: string) => (await db.orm.public.Driver.where({ id: driverId }).first())!;
  const historyOf = (driverId: string) => db.orm.public.DriverStatusChange.where({ driverId }).all();
  const login = (email: string) => request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });

  const seedOrder = async () => {
    const product = await db.orm.public.Product.create({ name: 'Ramo ' + randomUUID().slice(0, 6), price: 10, stock: 50 });
    const order = await db.orm.public.Order.create({
      userId: ids.client, zoneId: ids.zone, deliveryAddress: 'Fixture street', scheduledDeliveryDate: now(), deliveryLat: -1.25, deliveryLng: -78.62, total: 10, subtotalCents: 1000n,
    });
    await db.orm.public.OrderItem.create({ orderId: order.id, productId: product.id, quantity: 1, price: 10, unitPriceCents: 1000n });
    return order;
  };
  /** Ruta en borrador con un pedido nuevo. */
  const draftRoute = async () => {
    const order = await seedOrder();
    const route = (await api('post', '/routes', { zoneId: ids.zone, routeDate: now().toString(), orderIds: [order.id] }).expect(201)).body;
    return { route, order };
  };
  const assign = (routeId: string, driverId: string) => api('post', `/routes/${routeId}/assign`, { driverId });
  const asDriver = (userId: string, method: 'get' | 'post' | 'patch', path: string, body?: object) =>
    request(app.getHttpServer())[method]('/api/v1' + path).auth(token(userId, 'DRIVER'), { type: 'bearer' }).send(body);
  const assignedRoute = async (driver: { driverId: string }) => {
    const { route, order } = await draftRoute();
    await assign(route.id, driver.driverId).expect(200);
    return { route, order };
  };
  const startRoute = async (driver: { driverId: string; userId: string }) => {
    const r = await assignedRoute(driver);
    await asDriver(driver.userId, 'post', `/routes/${r.route.id}/start`).expect(200);
    return r;
  };
  const completeRoute = async (driver: { driverId: string; userId: string }) => {
    const r = await startRoute(driver);
    for (const status of ['IN_TRANSIT', 'DELIVERED']) {
      const res = await asDriver(driver.userId, 'patch', `/orders/${r.order.id}/status`, { status });
      if (res.status !== 200) throw new Error(`${status}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    await asDriver(driver.userId, 'post', `/routes/${r.route.id}/complete`, {}).expect(200);
    return r;
  };

  beforeAll(async () => {
    startOwnedContainer();
    const dbName = 'driveractive_' + randomUUID().replaceAll('-', '').slice(0, 8);
    const url = createOwnedDatabase(dbName);
    // Cuentas EXISTENTES: se crean con el esquema anterior a la baja y después se migra.
    runPrismaMigrate(url, BEFORE_STATUS);
    execPsqlCommand(
      dbName,
      `INSERT INTO public."user" (id, name, email, password, role) VALUES ('${ids.legacyUser}', 'Legado', 'legado@fixture.invalid', 'x', 'DRIVER');
       INSERT INTO public.driver (id, "userId", vehicle) VALUES ('${ids.legacyDriver}', '${ids.legacyUser}', 'Van legado');`,
    );
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    db = postgres<Contract>({ contractJson, url });
    for (const [id, role] of [[ids.admin, 'ADMIN'], [ids.admin2, 'ADMIN'], [ids.client, 'CLIENT']] as const) {
      await db.orm.public.User.create({ id, role, name: role, email: id + '@fixture.invalid', password: 'not-a-real-password' });
    }
    await db.orm.public.Zone.create({ id: ids.zone, code: 'Z-82', name: 'Zona 82', depotLat: -1.24, depotLng: -78.61 });
    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const prisma = {
      client: db, orm: db.orm, sql: db.sql,
      user: db.orm.public.User, driver: db.orm.public.Driver, zone: db.orm.public.Zone, order: db.orm.public.Order,
      orderItem: db.orm.public.OrderItem, product: db.orm.public.Product, route: db.orm.public.Route,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(prisma).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    process.env.REALTIME_ALLOWED_ORIGINS = realtimeOrigin;
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    if (previousOrigins === undefined) delete process.env.REALTIME_ALLOWED_ORIGINS;
    else process.env.REALTIME_ALLOWED_ORIGINS = previousOrigins;
    await app?.close();
    await db?.close();
    cleanupOwnedResources();
  });

  describe('migración y estado persistido', () => {
    it('las cuentas existentes quedan ACTIVAS tras la migración, sin cambios de estado ni historial', async () => {
      expect(await stateOf(ids.legacyDriver)).toMatchObject({ isActive: true, statusChangedAt: null, statusChangedById: null, statusReason: null, isAvailable: true });
      expect(await historyOf(ids.legacyDriver)).toHaveLength(0);
      const listed = (await api('get', '/drivers').expect(200)).body.find((d: any) => d.id === ids.legacyDriver);
      expect(listed).toMatchObject({ isActive: true, statusChangedAt: null, statusReason: null });
      expect(listed.effectiveAvailability).toMatchObject({ isAvailable: true });
    });

    it('la base de datos exige actor y momento en toda baja y limita el motivo', async () => {
      const d = await makeDriver();
      await expect(db.orm.public.Driver.where({ id: d.driverId }).update({ isActive: false })).rejects.toThrow();
      await expect(db.orm.public.Driver.where({ id: d.driverId }).update({ statusReason: '   ' })).rejects.toThrow();
      expect((await stateOf(d.driverId)).isActive).toBe(true);
    });
  });

  describe('baja y reactivación por la API', () => {
    it('una baja queda registrada (actor, momento, motivo e historial) y se lee en el listado de ADMIN', async () => {
      const d = await makeDriver();
      const res = await deactivate(d.driverId, { reason: '  Licencia vencida  ' }).expect(200);
      expect(res.body).toMatchObject({ id: d.driverId, isActive: false, statusChangedById: ids.admin, statusReason: 'Licencia vencida', isAvailable: true });
      expect(res.body.statusChangedAt).toEqual(expect.any(String));
      expect(res.body.effectiveAvailability).toMatchObject({ isAvailable: false, hasPersistedHolds: false });
      expect(await stateOf(d.driverId)).toMatchObject({ isActive: false, statusChangedById: ids.admin, statusReason: 'Licencia vencida' });
      const listed = (await api('get', '/drivers').expect(200)).body.find((x: any) => x.id === d.driverId);
      expect(listed).toMatchObject({ isActive: false, statusReason: 'Licencia vencida' });
      const history = (await api('get', `/drivers/${d.driverId}/status-changes`).expect(200)).body;
      expect(history).toEqual([expect.objectContaining({ active: false, reason: 'Licencia vencida', actorId: ids.admin })]);
    });

    it('la reactivación restablece el estado y deja ambos hechos en el historial', async () => {
      const d = await makeDriver();
      await deactivate(d.driverId).expect(200);
      const res = await activate(d.driverId, { reason: 'Renovó la licencia' }, ids.admin2).expect(200);
      expect(res.body).toMatchObject({ isActive: true, statusChangedById: ids.admin2, statusReason: 'Renovó la licencia', isAvailable: true });
      expect(res.body.effectiveAvailability).toMatchObject({ isAvailable: true });
      const history = (await api('get', `/drivers/${d.driverId}/status-changes`).expect(200)).body;
      expect(history.map((h: any) => h.active)).toEqual([true, false]);
    });

    it('repetir la baja o la reactivación se rechaza con un motivo estable y no duplica el historial', async () => {
      const d = await makeDriver();
      expect((await activate(d.driverId).expect(409)).body.code).toBe('DRIVER_ALREADY_ACTIVE');
      await deactivate(d.driverId).expect(200);
      expect((await deactivate(d.driverId).expect(409)).body.code).toBe('DRIVER_ALREADY_INACTIVE');
      expect(await historyOf(d.driverId)).toHaveLength(1);
    });

    it('un repartidor inexistente es 404 y un id mal formado 400', async () => {
      await deactivate(randomUUID()).expect(404);
      await activate(randomUUID()).expect(404);
      await api('post', '/drivers/no-es-uuid/deactivate', {}).expect(400);
    });

    it('solo un ADMIN puede: CLIENT, DRIVER y anónimo se rechazan, el actor no se acepta en el cuerpo y no hay cambios', async () => {
      const d = await makeDriver();
      await api('post', `/drivers/${d.driverId}/deactivate`, { reason: 'x' }, ids.client, 'CLIENT').expect(403);
      await asDriver(d.userId, 'post', `/drivers/${d.driverId}/deactivate`, { reason: 'x' }).expect(403);
      await request(app.getHttpServer()).post(`/api/v1/drivers/${d.driverId}/deactivate`).send({}).expect(401);
      await api('post', `/drivers/${d.driverId}/deactivate`, { reason: 'x', actorId: ids.admin2 }).expect(400);
      await api('get', `/drivers/${d.driverId}/status-changes`, undefined, ids.client, 'CLIENT').expect(403);
      expect((await stateOf(d.driverId)).isActive).toBe(true);
      expect(await historyOf(d.driverId)).toHaveLength(0);
    });

    it('el historial es append-only: la base de datos rechaza editar o borrar un cambio', async () => {
      const d = await makeDriver();
      await deactivate(d.driverId).expect(200);
      const [change] = await historyOf(d.driverId);
      await expect(db.orm.public.DriverStatusChange.where({ id: change!.id }).update({ reason: 'manipulado' })).rejects.toThrow();
      await expect(db.orm.public.DriverStatusChange.where({ id: change!.id }).delete()).rejects.toThrow();
      expect(await historyOf(d.driverId)).toHaveLength(1);
    });
  });

  describe('acceso: login, sesión previa y nuevas asignaciones', () => {
    it('una sesión emitida antes de la baja deja de valer, el login se rechaza y la reactivación lo restablece todo', async () => {
      const d = await makeDriver();
      const before = await login(d.email).expect(200);
      const sessionToken = before.body.access_token as string;
      const operate = () => request(app.getHttpServer()).get('/api/v1/drivers/me/availability').auth(sessionToken, { type: 'bearer' });
      await operate().expect(200);

      await deactivate(d.driverId).expect(200);
      const blocked = await operate().expect(401);
      expect(blocked.body.code).toBe('DRIVER_INACTIVE');
      const refused = await login(d.email).expect(403);
      expect(refused.body.code).toBe('DRIVER_INACTIVE');
      expect(refused.body.access_token).toBeUndefined();

      await activate(d.driverId).expect(200);
      await operate().expect(200); // la misma sesión previa vuelve a valer
      await login(d.email).expect(200);
    });

    it('la baja de un repartidor no afecta el acceso de ADMIN ni de CLIENT', async () => {
      const d = await makeDriver();
      await deactivate(d.driverId).expect(200);
      await api('get', '/drivers').expect(200);
      await api('get', '/shop/orders?pageSize=1', undefined, ids.client, 'CLIENT').expect(200);
    });

    it('un repartidor inactivo no puede recibir una ruta: 409 DRIVER_INACTIVE y la ruta queda en borrador, sin reserva', async () => {
      const d = await makeDriver();
      await deactivate(d.driverId).expect(200);
      const { route } = await draftRoute();
      const res = await assign(route.id, d.driverId).expect(409);
      expect(res.body.code).toBe('DRIVER_INACTIVE');
      expect(await db.orm.public.Route.where({ id: route.id }).first()).toMatchObject({ status: 'DRAFT', driverId: null });
      expect(await db.orm.public.DriverReservation.where({ driverId: d.driverId }).all()).toHaveLength(0);
    });

    it('la reasignación de ADMIN a un repartidor inactivo se rechaza y la ruta conserva a su repartidor', async () => {
      const current = await makeDriver('actual');
      const target = await makeDriver('destino');
      await deactivate(target.driverId).expect(200);
      const { route } = await assignedRoute(current);
      const res = await api('post', '/dispatch/interventions', { requestId: randomUUID(), reason: 'Reasignar', action: 'REASSIGN_DRIVER', routeId: route.id, driverId: target.driverId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DRIVER_INACTIVE');
      expect(await db.orm.public.Route.where({ id: route.id }).first()).toMatchObject({ driverId: current.driverId });
      // reactivado, la misma reasignación procede
      await activate(target.driverId).expect(200);
      await api('post', '/dispatch/interventions', { requestId: randomUUID(), reason: 'Reasignar', action: 'REASSIGN_DRIVER', routeId: route.id, driverId: target.driverId }).expect(200);
    });

    it('un repartidor inactivo tampoco aparece como candidato: su disponibilidad efectiva es falsa', async () => {
      const d = await makeDriver();
      await deactivate(d.driverId).expect(200);
      const listed = (await api('get', '/drivers').expect(200)).body.find((x: any) => x.id === d.driverId);
      expect(listed.effectiveAvailability).toMatchObject({ isAvailable: false, hasPersistedHolds: false, compatibilityFlagBlocks: false });
    });

    it('la base de datos rechaza por sí sola una reserva o una ruta para un repartidor inactivo (red de seguridad)', async () => {
      const d = await makeDriver();
      const { route } = await draftRoute();
      await deactivate(d.driverId).expect(200);
      await expect(db.orm.public.DriverReservation.create({ routeId: route.id, driverId: d.driverId, reservedAt: now() })).rejects.toThrow();
      await expect(db.orm.public.Route.where({ id: route.id }).update({ driverId: d.driverId })).rejects.toThrow();
      expect(await db.orm.public.DriverReservation.where({ driverId: d.driverId }).all()).toHaveLength(0);
    });
  });

  describe('tiempo real (Socket.IO)', () => {
    const connect = async (jwtValue: string) => {
      const socket = io(base + '/realtime', {
        autoConnect: false, forceNew: true, reconnection: false, transports: ['websocket'],
        auth: { token: jwtValue }, extraHeaders: { Origin: realtimeOrigin },
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket connection timeout')), 4000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
        socket.connect();
      });
      return socket;
    };
    const subscribe = (socket: Socket, resource: string, id: string) =>
      new Promise<any>((resolve, reject) => {
        socket.timeout(4000).emit('resource.subscribe', { resource, id }, (error: Error | null, ack: any) => (error ? reject(error) : resolve(ack)));
      });

    it('un repartidor dado de baja no abre canal y una conexión previa ya no puede suscribirse; reactivado, vuelve a conectar', async () => {
      const d = await makeDriver('tiemporeal');
      // ruta terminada y con regreso al depósito confirmado: la baja procede y la ruta del repartidor sigue consultable
      const { route } = await completeRoute(d);
      await asDriver(d.userId, 'post', `/routes/${route.id}/return`, {}).expect(200);
      const driverToken = token(d.userId, 'DRIVER');
      const open = await connect(driverToken);
      expect(await subscribe(open, 'route', route.id)).toEqual({ ok: true });

      await deactivate(d.driverId).expect(200);

      await expect(connect(driverToken)).rejects.toThrow();
      // la conexión abierta antes de la baja ya no puede suscribirse: el servidor la rechaza (ack con error) o la cierra
      const outcome = await subscribe(open, 'route', route.id).then(
        (ack) => ({ rejected: ack?.ok === false }),
        () => ({ rejected: true }),
      );
      expect(outcome.rejected).toBe(true);

      await activate(d.driverId).expect(200);
      const again = await connect(driverToken);
      expect(again.connected).toBe(true);
    });
  });

  describe('la baja y las rutas del repartidor', () => {
    const expectBlocked = async (driver: { driverId: string }, status: string) => {
      const before = await stateOf(driver.driverId);
      const res = await deactivate(driver.driverId).expect(409);
      expect(res.body.code).toBe('DRIVER_HAS_OPEN_ROUTE');
      expect(res.body.blockingRoutes).toEqual([expect.objectContaining({ status, returnConfirmed: false })]);
      expect(await stateOf(driver.driverId)).toEqual(before); // no modifica datos
      expect(await historyOf(driver.driverId)).toHaveLength(0);
    };

    it('con una ruta ASSIGNED la baja devuelve conflicto y no cambia nada', async () => {
      const d = await makeDriver();
      await assignedRoute(d);
      await expectBlocked(d, 'ASSIGNED');
    });

    it('con una ruta IN_PROGRESS la baja devuelve conflicto', async () => {
      const d = await makeDriver();
      await startRoute(d);
      await expectBlocked(d, 'IN_PROGRESS');
    });

    it('con una ruta COMPLETED sin regreso al depósito confirmado la baja devuelve conflicto; con el regreso procede', async () => {
      const d = await makeDriver();
      const { route } = await completeRoute(d);
      await expectBlocked(d, 'COMPLETED');
      await asDriver(d.userId, 'post', `/routes/${route.id}/return`, {}).expect(200);
      await deactivate(d.driverId).expect(200);
      // la ruta y su historial siguen intactos
      expect(await db.orm.public.Route.where({ id: route.id }).first()).toMatchObject({ status: 'COMPLETED', driverId: d.driverId });
    });

    it('con una ruta INTERRUPTED (emergencia) sin regreso confirmado la baja devuelve conflicto; tras la liberación procede', async () => {
      const d = await makeDriver();
      const { route } = await startRoute(d);
      await api('post', '/dispatch/interventions', { requestId: randomUUID(), reason: 'Falla mecánica', action: 'EMERGENCY_DECLARE', routeId: route.id }).expect(200);
      await expectBlocked(d, 'INTERRUPTED');
      await api('post', '/dispatch/interventions', { requestId: randomUUID(), reason: 'Retorno', action: 'EMERGENCY_DRIVER_RELEASE', routeId: route.id }).expect(200);
      await deactivate(d.driverId).expect(200);
    });

    it('un repartidor sin rutas, o solo con borradores sin asignar, se puede dar de baja', async () => {
      const d = await makeDriver();
      await draftRoute();
      await deactivate(d.driverId).expect(200);
    });

    it('dar de baja a un repartidor no elimina su usuario, sus rutas ni su historial', async () => {
      const d = await makeDriver();
      const { route } = await completeRoute(d);
      await asDriver(d.userId, 'post', `/routes/${route.id}/return`, {}).expect(200);
      const routes = (await db.orm.public.Route.where({ driverId: d.driverId }).all()).length;
      await deactivate(d.driverId).expect(200);
      expect(await db.orm.public.User.where({ id: d.userId }).first()).toMatchObject({ role: 'DRIVER' });
      expect((await db.orm.public.Route.where({ driverId: d.driverId }).all()).length).toBe(routes);
    });
  });

  describe('ausencias y restricciones de disponibilidad', () => {
    it('la reactivación no anula la ausencia vigente ni la bandera de compatibilidad, y la baja tampoco las crea', async () => {
      const d = await makeDriver();
      const day = tomorrow();
      const absence = (await api('post', `/drivers/${d.driverId}/absences`, { startDate: day, endDate: day, reason: 'Vacaciones' }).expect(201)).body;
      await db.orm.public.Driver.where({ id: d.driverId }).update({ isAvailable: false });

      await deactivate(d.driverId).expect(200);
      const stillThere = (await api('get', `/drivers/${d.driverId}/absences`).expect(200)).body;
      expect(stillThere).toEqual([expect.objectContaining({ id: absence.id, cancelledAt: null })]);

      await activate(d.driverId).expect(200);
      expect((await api('get', `/drivers/${d.driverId}/absences`).expect(200)).body).toEqual([expect.objectContaining({ id: absence.id, cancelledAt: null })]);
      const state = await stateOf(d.driverId);
      expect(state).toMatchObject({ isActive: true, isAvailable: false }); // la restricción previa sigue
      const listed = (await api('get', '/drivers').expect(200)).body.find((x: any) => x.id === d.driverId);
      expect(listed.effectiveAvailability).toMatchObject({ isAvailable: false, compatibilityFlagBlocks: true });
    });
  });

  describe('concurrencia entre la asignación y la baja', () => {
    it('con una asignación y una baja simultáneas, un repartidor inactivo nunca conserva una asignación nueva', async () => {
      const outcomes: string[] = [];
      for (let i = 0; i < 8; i++) {
        const d = await makeDriver('carrera');
        const { route } = await draftRoute();
        const [a, b] = await Promise.all([assign(route.id, d.driverId), deactivate(d.driverId)]);
        const statuses = [a.status, b.status].sort();
        // exactamente uno gana: o se asignó (y la baja da DRIVER_HAS_OPEN_ROUTE) o se dio de baja (y la asignación da DRIVER_INACTIVE)
        expect(statuses).toEqual([200, 409]);
        if (a.status === 200) {
          expect(b.body.code).toBe('DRIVER_HAS_OPEN_ROUTE');
          outcomes.push('asignó');
        } else {
          expect(a.body.code).toBe('DRIVER_INACTIVE');
          outcomes.push('baja');
        }
        const driver = await stateOf(d.driverId);
        const persisted = await db.orm.public.Route.where({ id: route.id }).first();
        const reservations = (await db.orm.public.DriverReservation.where({ driverId: d.driverId }).all()).filter((r) => r.releasedAt === null);
        if (driver.isActive === false) {
          expect(persisted).toMatchObject({ status: 'DRAFT', driverId: null });
          expect(reservations).toHaveLength(0);
        } else {
          expect(persisted).toMatchObject({ status: 'ASSIGNED', driverId: d.driverId });
          expect(reservations).toHaveLength(1);
        }
      }
      expect(outcomes).toHaveLength(8);
    });

    it('dos bajas simultáneas del mismo repartidor: una gana y la otra recibe DRIVER_ALREADY_INACTIVE, con un solo registro', async () => {
      const d = await makeDriver();
      const results = await Promise.all([deactivate(d.driverId), deactivate(d.driverId, { reason: 'otra' }, ids.admin2), deactivate(d.driverId)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'DRIVER_ALREADY_INACTIVE')).toBe(true);
      expect(await historyOf(d.driverId)).toHaveLength(1);
    });
  });
});
