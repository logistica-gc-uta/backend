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

jest.setTimeout(240_000);

/**
 * Issue #43: gestión ADMIN de perfiles de repartidor sobre PostgreSQL real (contenedor propio).
 * Verifica permisos, validaciones, atomicidad (sin usuario/perfil parcial) y que corregir un perfil
 * no libera a un repartidor ocupado ni toca sus rutas.
 */
describe('Gestión ADMIN de repartidores (#43) en PostgreSQL real', () => {
  let app: INestApplication;
  let db: any;
  let adminToken: string;
  let clientToken: string;
  let clientEmail: string;
  let jwtSign: (payload: Record<string, unknown>) => string;
  const dbName = `drivers_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = () => randomUUID().slice(0, 8);

  const count = async (model: 'User' | 'Driver'): Promise<number> => (await db.client.orm.public[model].all()).length;
  const snapshot = async () => ({ users: await count('User'), drivers: await count('Driver') });
  const create = (body: Record<string, unknown>, token = adminToken) => http().post('/api/v1/drivers').set(auth(token)).send(body);
  const newDriverBody = () => ({ name: 'Carlos Chofer', email: `driver-${unique()}@example.test`, vehicle: 'Camioneta Hilux blanca' });

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

    const adminId = randomUUID();
    await db.user.create({ id: adminId, name: 'Admin', email: 'admin-43@example.test', password: 'fixture-not-real', role: 'ADMIN' });
    adminToken = jwtSign({ sub: adminId, email: 'admin-43@example.test', role: 'ADMIN' });
    const clientId = randomUUID();
    clientEmail = `client-43-${unique()}@example.test`;
    await db.user.create({ id: clientId, name: 'Cliente', email: clientEmail, password: 'fixture-not-real', role: 'CLIENT' });
    clientToken = jwtSign({ sub: clientId, email: clientEmail, role: 'CLIENT' });
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
  });

  describe('POST /drivers — alta', () => {
    it('crea identidad DRIVER y perfil, devuelve la contraseña temporal una sola vez y nunca el hash', async () => {
      const body = newDriverBody();
      const before = await snapshot();
      const res = await create({ ...body, name: `  ${body.name}  `, email: body.email.toUpperCase() }).expect(201);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        vehicle: body.vehicle,
        isAvailable: true,
        user: { name: body.name, email: body.email, role: 'DRIVER' },
        effectiveAvailability: { isAvailable: true, blockingRouteIds: [] },
      });
      expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(JSON.stringify(res.body)).not.toMatch(/bcrypt|"password"|\$2[aby]\$/);
      expect(await snapshot()).toEqual({ users: before.users + 1, drivers: before.drivers + 1 });

      // En BD: rol DRIVER, contraseña solo como hash y perfil enlazado a esa identidad.
      const user = await db.client.orm.public.User.where({ email: body.email }).first();
      expect(user.role).toBe('DRIVER');
      expect(user.password).not.toContain(res.body.temporaryPassword);
      expect(user.password).toMatch(/^bcrypt-sha256:v1:\$2/);
      expect((await db.client.orm.public.Driver.where({ userId: user.id }).first()).id).toBe(res.body.id);
    });

    it('la contraseña temporal permite iniciar sesión como DRIVER y consultar su disponibilidad', async () => {
      const body = newDriverBody();
      const created = await create(body).expect(201);
      const login = await http().post('/api/v1/auth/login').send({ email: body.email, password: created.body.temporaryPassword }).expect(200);
      const availability = await http().get('/api/v1/drivers/me/availability').set(auth(login.body.access_token)).expect(200);
      expect(availability.body.isAvailable).toBe(true);
      await http().get('/api/v1/drivers/me/routes').set(auth(login.body.access_token)).expect(200, []);
    });

    it('cada alta recibe una contraseña distinta (no hay clave compartida)', async () => {
      const first = await create(newDriverBody()).expect(201);
      const second = await create(newDriverBody()).expect(201);
      expect(first.body.temporaryPassword).not.toBe(second.body.temporaryPassword);
    });

    it('un CLIENT, un DRIVER o un anónimo no pueden crear repartidores y no queda ningún dato parcial', async () => {
      const before = await snapshot();
      const driverId = randomUUID();
      await db.user.create({ id: driverId, name: 'Otro', email: `otro-${unique()}@example.test`, password: 'fixture-not-real', role: 'DRIVER' });
      const driverToken = jwtSign({ sub: driverId, email: 'otro@example.test', role: 'DRIVER' });
      const afterDriverUser = { ...before, users: before.users + 1 };

      await create(newDriverBody(), clientToken).expect(403);
      await create(newDriverBody(), driverToken).expect(403);
      await http().post('/api/v1/drivers').send(newDriverBody()).expect(401);
      expect(await snapshot()).toEqual(afterDriverUser);
    });

    it('no permite elevar privilegios: role, isAvailable o userId en el cuerpo se rechazan con 400', async () => {
      const before = await snapshot();
      await create({ ...newDriverBody(), role: 'ADMIN' }).expect(400);
      await create({ ...newDriverBody(), isAvailable: false }).expect(400);
      await create({ ...newDriverBody(), userId: randomUUID() }).expect(400);
      await create({ ...newDriverBody(), password: 'claveElegidaPorQuienSea1' }).expect(400);
      expect(await snapshot()).toEqual(before);
    });

    it('valida campos: nombre corto, correo inválido, vehículo faltante', async () => {
      const before = await snapshot();
      await create({ ...newDriverBody(), name: 'A' }).expect(400);
      await create({ ...newDriverBody(), email: 'no-es-correo' }).expect(400);
      const { vehicle: _omitted, ...withoutVehicle } = newDriverBody();
      await create(withoutVehicle).expect(400);
      await create({ ...newDriverBody(), vehicle: '   ' }).expect(400);
      expect(await snapshot()).toEqual(before);
    });

    it('un correo ya registrado (aunque cambie la capitalización) da 409 EMAIL_ALREADY_EXISTS sin crear nada', async () => {
      const before = await snapshot();
      const res = await create({ ...newDriverBody(), email: clientEmail.toUpperCase() }).expect(409);
      expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
      expect(await snapshot()).toEqual(before);
    });

    it('si falla la creación del perfil se revierte también la identidad (sin usuario huérfano)', async () => {
      execPsqlCommand(dbName, `
        CREATE FUNCTION public.fail_driver_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fallo inyectado'; END $$;
        CREATE TRIGGER trg_fail_driver_insert BEFORE INSERT ON public.driver FOR EACH ROW EXECUTE FUNCTION public.fail_driver_insert();
      `);
      try {
        const before = await snapshot();
        const body = newDriverBody();
        await create(body).expect(500);
        expect(await snapshot()).toEqual(before);
        expect(await db.client.orm.public.User.where({ email: body.email }).first()).toBeNull();
      } finally {
        execPsqlCommand(dbName, 'DROP TRIGGER trg_fail_driver_insert ON public.driver; DROP FUNCTION public.fail_driver_insert();');
      }
    });
  });

  describe('PATCH /drivers/:id — corrección', () => {
    const createDriver = async () => {
      const body = newDriverBody();
      const res = await create(body).expect(201);
      return { ...body, id: res.body.id as string, userId: res.body.userId as string, password: res.body.temporaryPassword as string };
    };
    const patch = (id: string, body: Record<string, unknown>, token = adminToken) => http().patch(`/api/v1/drivers/${id}`).set(auth(token)).send(body);

    it('corrige nombre, correo y vehículo; el nuevo correo inicia sesión con la misma contraseña y el anterior deja de servir', async () => {
      const driver = await createDriver();
      const newEmail = `corregido-${unique()}@example.test`;
      const res = await patch(driver.id, { name: 'Carlos Corregido', email: newEmail.toUpperCase(), vehicle: 'Moto 150cc' }).expect(200);

      expect(res.body).toMatchObject({ id: driver.id, vehicle: 'Moto 150cc', user: { name: 'Carlos Corregido', email: newEmail, role: 'DRIVER' } });
      expect(JSON.stringify(res.body)).not.toMatch(/bcrypt|"password"|temporaryPassword/);
      await http().post('/api/v1/auth/login').send({ email: newEmail, password: driver.password }).expect(200);
      await http().post('/api/v1/auth/login').send({ email: driver.email, password: driver.password }).expect(401);
    });

    it('acepta una corrección parcial y rechaza un cuerpo vacío, campos no permitidos, ids inválidos y repartidores inexistentes', async () => {
      const driver = await createDriver();
      const res = await patch(driver.id, { vehicle: 'Camión pequeño' }).expect(200);
      expect(res.body.vehicle).toBe('Camión pequeño');
      expect(res.body.user.name).toBe(driver.name);

      await patch(driver.id, {}).expect(400);
      await patch(driver.id, { role: 'ADMIN' }).expect(400);
      await patch(driver.id, { isAvailable: true }).expect(400);
      await patch(driver.id, { name: 'A' }).expect(400);
      await patch('no-es-uuid', { name: 'Carlos' }).expect(400);
      await patch(randomUUID(), { name: 'Carlos' }).expect(404);
    });

    it('un correo ya usado da 409 y no cambia ningún otro campo de la misma petición', async () => {
      const driver = await createDriver();
      const other = await createDriver();
      const res = await patch(driver.id, { name: 'Nombre que no debe guardarse', vehicle: 'Vehículo que no debe guardarse', email: other.email.toUpperCase() }).expect(409);
      expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
      const stored = await db.client.orm.public.Driver.where({ id: driver.id }).first();
      const user = await db.client.orm.public.User.where({ id: driver.userId }).first();
      expect(stored.vehicle).toBe(driver.vehicle);
      expect(user.name).toBe(driver.name);
      expect(user.email).toBe(driver.email);
    });

    it('un CLIENT, un DRIVER o un anónimo no pueden editar perfiles', async () => {
      const driver = await createDriver();
      const driverToken = jwtSign({ sub: driver.userId, email: driver.email, role: 'DRIVER' });
      await patch(driver.id, { name: 'Otro Nombre' }, clientToken).expect(403);
      await patch(driver.id, { name: 'Otro Nombre' }, driverToken).expect(403);
      await http().patch(`/api/v1/drivers/${driver.id}`).send({ name: 'Otro Nombre' }).expect(401);
      expect((await db.client.orm.public.User.where({ id: driver.userId }).first()).name).toBe(driver.name);
    });

    it('corregir los datos de un repartidor ocupado conserva sus rutas, su reserva y su indisponibilidad', async () => {
      const driver = await createDriver();
      const zoneId = randomUUID();
      await db.client.orm.public.Zone.create({ id: zoneId, name: `Zona ${unique()}`, code: `Z${unique().toUpperCase()}` });
      const routeId = randomUUID();
      // La BD exige la reserva activa en la misma transacción que la ruta ASSIGNED (así lo hace la asignación real).
      await db.client.transaction(async (tx: any) => {
        await tx.orm.public.Route.create({ id: routeId, driverId: driver.id, zoneId, status: 'ASSIGNED' });
        await tx.orm.public.DriverReservation.create({ id: randomUUID(), driverId: driver.id, routeId, reservedAt: Temporal.Now.instant() });
      });
      await db.client.orm.public.Driver.where({ id: driver.id }).update({ isAvailable: false });

      const driverToken = jwtSign({ sub: driver.userId, email: driver.email, role: 'DRIVER' });
      const routesBefore = await http().get('/api/v1/drivers/me/routes').set(auth(driverToken)).expect(200);
      const availabilityBefore = (await http().get('/api/v1/drivers/me/availability').set(auth(driverToken)).expect(200)).body;
      expect(availabilityBefore).toMatchObject({ isAvailable: false, blockingRouteIds: [routeId] });
      expect(routesBefore.body).toHaveLength(1);

      const res = await patch(driver.id, { name: 'Carlos Ocupado Corregido', vehicle: 'Furgoneta' }).expect(200);

      expect(res.body.isAvailable).toBe(false); // editar no vuelve disponible a un repartidor ocupado
      expect(res.body.effectiveAvailability).toMatchObject({ isAvailable: false, blockingRouteIds: [routeId] });
      const availabilityAfter = (await http().get('/api/v1/drivers/me/availability').set(auth(driverToken)).expect(200)).body;
      expect(availabilityAfter).toEqual(availabilityBefore);
      const routesAfter = await http().get('/api/v1/drivers/me/routes').set(auth(driverToken)).expect(200);
      expect(routesAfter.body.map((r: any) => ({ id: r.id, status: r.status }))).toEqual(routesBefore.body.map((r: any) => ({ id: r.id, status: r.status })));
      const route = await db.client.orm.public.Route.where({ id: routeId }).first();
      expect(route).toMatchObject({ driverId: driver.id, status: 'ASSIGNED' });
      const reservation = await db.client.orm.public.DriverReservation.where({ driverId: driver.id }).first();
      expect(reservation.releasedAt).toBeNull();
    });
  });

  describe('GET /drivers — consultas existentes', () => {
    it('el listado ADMIN incluye a los repartidores nuevos con la misma forma de siempre y sin hashes', async () => {
      const created = await create(newDriverBody()).expect(201);
      await http().get('/api/v1/drivers').set(auth(clientToken)).expect(403);
      const list = await http().get('/api/v1/drivers').set(auth(adminToken)).expect(200);
      const item = list.body.find((d: any) => d.id === created.body.id);
      expect(item).toMatchObject({ id: created.body.id, userId: created.body.userId, vehicle: created.body.vehicle, isAvailable: true, effectiveAvailability: { isAvailable: true } });
      expect(Object.keys(item.user).sort()).toEqual(['createdAt', 'email', 'id', 'name', 'role']);
      expect(JSON.stringify(list.body)).not.toMatch(/bcrypt|"password"|\$2[aby]\$/);
    });
  });
});
