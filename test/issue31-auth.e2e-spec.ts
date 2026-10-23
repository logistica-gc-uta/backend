import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { Role } from '../src/modules/auth/dto/register.dto.js';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  runPrismaMigrate,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(180_000);

/**
 * Every key that would expose a secret, at any depth of the payload.
 * `access_token` is excluded on purpose: it is the documented login contract.
 */
function secretKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => secretKeys(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nested]) => [
      ...(/password|secret|hash|credential|api[-_]?key/i.test(key)
        ? [`${path}.${key}`]
        : []),
      ...secretKeys(nested, `${path}.${key}`),
    ],
  );
}

describe('Issue 31 — registro público exclusivo CLIENT y redacción de secretos (PostgreSQL real)', () => {
  let app: INestApplication;
  let prisma: any;
  let fixtures: any;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const emailFor = (label: string) => `issue31-${label}-${run}@delivery.test`;
  const password = 'secret123';
  const registeredEmails: string[] = [];
  const passwordHashes: string[] = [];
  const tokens = new Map<Role, string>();
  const users = new Map<Role, { id: string; name: string; email: string }>();
  let routeId = '';
  let ownOrderId = '';
  let foreignOrderId = '';

  beforeAll(async () => {
    const database = `issue31_${run}`;
    const url = createOwnedDatabase(database);
    runPrismaMigrate(url);

    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');
    const { SecurityFixtureManager } = await import(
      './orders-security.fixtures.js'
    );

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
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
    fixtures = new SecurityFixtureManager(prisma, app.get(JwtService));

    for (const role of [Role.ADMIN, Role.CLIENT, Role.DRIVER]) {
      const user = await fixtures.createUser(role, `issue31-${role.toLowerCase()}`);
      users.set(role, user);
      tokens.set(role, user.token);
      const stored = await prisma.user.where({ id: user.id }).first();
      passwordHashes.push(stored.password);
    }

    const driver = await fixtures.createDriver(users.get(Role.DRIVER)!.id);
    const zone = await fixtures.createZone();
    const route = await fixtures.createRoute(driver.id, zone.id);
    routeId = route.id;

    const otherClient = await fixtures.createUser(Role.CLIENT, 'issue31-other-client');
    const otherClientRow = await prisma.user.where({ id: otherClient.id }).first();
    passwordHashes.push(otherClientRow.password);
    const ownOrder = await fixtures.createOrder(users.get(Role.CLIENT)!.id, zone.id);
    const foreignOrder = await fixtures.createOrder(otherClient.id, zone.id);
    ownOrderId = ownOrder.id;
    foreignOrderId = foreignOrder.id;
  });

  afterAll(async () => {
    if (prisma) {
      for (const email of registeredEmails) {
        try {
          await prisma.user.where({ email }).delete();
        } catch {
          // La fila propia ya no existe: nada que limpiar.
        }
      }
    }
    if (fixtures) await fixtures.cleanup();
    if (app) await app.close();
    cleanupOwnedResources();
  });

  it('registra un CLIENT, normaliza los campos y devuelve solo la allowlist', async () => {
    const email = emailFor('register');
    registeredEmails.push(email);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: ' Cliente Issue 31 ', email: email.toUpperCase(), password })
      .expect(201);

    expect(response.body).toMatchObject({
      name: 'Cliente Issue 31',
      email,
      role: Role.CLIENT,
    });
    expect(Object.keys(response.body).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'role',
    ]);
    expect(secretKeys(response.body)).toEqual([]);

    const stored = await prisma.user.where({ email }).first();
    expect(stored.role).toBe(Role.CLIENT);
    expect(stored.password).toMatch(/^bcrypt-sha256:v1:\$2[aby]\$10\$/);
    expect(response.body).not.toHaveProperty('password');
  });

  it('acepta los límites mínimos de nombre y contraseña tras recortar el nombre', async () => {
    const email = emailFor('minimum-boundary');
    registeredEmails.push(email);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: ' XY ', email, password: 'p'.repeat(8) })
      .expect(201);

    expect(response.body.name).toBe('XY');
  });

  it('acepta los límites máximos exactos del nombre y contraseña', async () => {
    const email = emailFor('maximum-boundary');
    registeredEmails.push(email);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: 'N'.repeat(120), email, password: 'p'.repeat(128) })
      .expect(201);

    expect(response.body.name).toHaveLength(120);
    const stored = await prisma.user.where({ email }).first();
    expect(stored.password).not.toBe('p'.repeat(128));
  });

  it.each([
    { field: 'name', value: ' A ' },
    { field: 'name', value: 'N'.repeat(121) },
    { field: 'email', value: 'not-an-email' },
    { field: 'password', value: 'p'.repeat(6) },
    { field: 'password', value: 'p'.repeat(129) },
  ])('rechaza valores fuera de los límites de registro: $field', async ({ field, value }) => {
    const email = emailFor(`invalid-${field}-${value.length}`);
    const body: Record<string, unknown> = {
      name: 'Valid Name',
      email,
      password,
      [field]: value,
    };

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(body)
      .expect(400);

    expect(response.body).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      code: 'VALIDATION_ERROR',
    });
  });

  it.each([Role.ADMIN, Role.CLIENT, Role.DRIVER])(
    'rechaza el registro con role %s explícito y no crea ningún usuario',
    async (role) => {
      const email = emailFor(`escalation-${role}`);

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ name: 'Escalation', email, password, role })
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VALIDATION_ERROR',
      });
      expect(response.body.message.join(' ')).toContain('role');
      const stored = await prisma.user.where({ email }).first();
      expect(stored).toBeNull();
    },
  );

  it.each([
    ['isAdmin', true],
    ['permissions', ['ADMIN']],
    ['userId', 'forged-user-id'],
    ['createdAt', '2026-01-01T00:00:00.000Z'],
    ['unexpected', 'value'],
  ])('rechaza el atributo de asignación masiva %s', async (field: string, value: unknown) => {
    const email = emailFor(`mass-assignment-${field}`);
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        name: 'Mass Assignment',
        email,
        password,
        [field]: value,
      })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.message.join(' ')).toContain(field);
    expect(await prisma.user.where({ email }).first()).toBeNull();
  });

  it('rechaza duplicados normalizados con 409 EMAIL_ALREADY_EXISTS', async () => {
    const email = emailFor('normalized-duplicate');
    registeredEmails.push(email);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: 'Normalized Email', email: email.toUpperCase(), password })
      .expect(201);

    const duplicate = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: 'Normalized Email', email, password })
      .expect(409);

    expect(duplicate.body).toMatchObject({
      statusCode: 409,
      message: 'El correo electrónico ya se encuentra registrado',
      error: 'Conflict',
      code: 'EMAIL_ALREADY_EXISTS',
    });
  });

  it('fuerza dos INSERT reales después de ambas preconsultas: 201 + 409 único', async () => {
    const email = emailFor('concurrent-registration');
    registeredEmails.push(email);
    const payload = { name: 'Concurrent Client', email, password };
    const collection = prisma.user;
    const originalCreate = collection.create.bind(collection);
    let arrived = 0;
    let release!: () => void;
    let rejectBarrier!: (reason: Error) => void;
    const bothAtInsert = new Promise<void>((resolve, reject) => {
      release = resolve;
      rejectBarrier = reject;
    });
    const timeout = setTimeout(() => rejectBarrier(new Error('Both requests did not reach the INSERT barrier')), 10_000);
    const createSpy = jest.spyOn(collection, 'create').mockImplementation(async (data: any) => {
      arrived += 1;
      if (arrived === 2) release();
      await bothAtInsert;
      return originalCreate(data);
    });

    try {
      const responses = await Promise.all([
        request(app.getHttpServer()).post('/api/v1/auth/register').send(payload),
        request(app.getHttpServer()).post('/api/v1/auth/register').send(payload),
      ]);
      expect(arrived).toBe(2);
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);
      expect(responses.find((response) => response.status === 409)?.body).toMatchObject({
        statusCode: 409,
        code: 'EMAIL_ALREADY_EXISTS',
      });
      const created = responses.find((response) => response.status === 201)!;
      expect(created.body.role).toBe(Role.CLIENT);
      expect(Object.keys(created.body).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'name',
        'role',
      ]);
      expect(secretKeys(created.body)).toEqual([]);
      const rows = await prisma.user.where({ email }).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(created.body.id);
      expect(rows[0].role).toBe(Role.CLIENT);
    } finally {
      clearTimeout(timeout);
      createSpy.mockRestore();
    }
  });

  it('distingue todo el password nuevo más allá de 72 bytes, incluso Unicode', async () => {
    const email = emailFor('long-password');
    registeredEmails.push(email);
    const longPassword = `${'x'.repeat(72)}🔐${'y'.repeat(54)}`;
    const differentSuffix = `${'x'.repeat(72)}🔑${'y'.repeat(54)}`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: 'Long Password', email, password: longPassword })
      .expect(201);
    const row = await prisma.user.where({ email }).first();
    expect(row.password).toMatch(/^bcrypt-sha256:v1:\$2[aby]\$10\$/);
    expect(JSON.stringify(created.body)).not.toContain(row.password);

    await request(app.getHttpServer()).post('/api/v1/auth/login')
      .send({ email, password: longPassword }).expect(200);
    const denied = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .send({ email, password: differentSuffix }).expect(401);
    expect(denied.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('mantiene login de cuentas mixtas preexistentes con password menor al nuevo mínimo', async () => {
    const legacy = await fixtures.createUser(Role.CLIENT, 'legacy-mixed-case');
    const storedEmail = `Issue31-Legacy-${run}@Delivery.Test`;
    const legacyPassword = 'oldpw';
    const legacyHash = await bcrypt.hash(legacyPassword, 10);
    await prisma.user.where({ id: legacy.id }).update({
      email: storedEmail,
      password: legacyHash,
    });
    passwordHashes.push(legacyHash);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: storedEmail.toLowerCase(), password: legacyPassword })
      .expect(200);

    expect(response.body.user.email).toBe(storedEmail);
    expect(secretKeys(response.body)).toEqual([]);
  });

  it('rechaza login ambiguo por colisión legacy sin seleccionar una cuenta', async () => {
    const first = await fixtures.createUser(Role.CLIENT, 'legacy-collision-a');
    const second = await fixtures.createUser(Role.CLIENT, 'legacy-collision-b');
    const mixedEmail = `Issue31-Collision-${run}@Delivery.Test`;
    const duplicateCaseVariant = mixedEmail.toUpperCase();
    await prisma.user.where({ id: first.id }).update({ email: mixedEmail });
    await prisma.user.where({ id: second.id }).update({ email: duplicateCaseVariant });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: mixedEmail.toLowerCase(), password })
      .expect(401);
    expect(login.body.code).toBe('INVALID_CREDENTIALS');

    const registration = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: 'Ambiguous Legacy', email: mixedEmail.toLowerCase(), password })
      .expect(409);
    expect(registration.body.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it.each([Role.ADMIN, Role.CLIENT, Role.DRIVER])(
    'conserva el login de %s con su forma de respuesta actual',
    async (role) => {
      const user = users.get(role)!;

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password })
        .expect(200);

      expect(typeof response.body.access_token).toBe('string');
      expect(Object.keys(response.body).sort()).toEqual(['access_token', 'user']);
      expect(response.body.user).toEqual({
        id: user.id,
        name: user.name,
        email: user.email,
        role,
      });
      expect(Object.keys(response.body.user).sort()).toEqual([
        'email',
        'id',
        'name',
        'role',
      ]);
      expect(secretKeys(response.body)).toEqual([]);
    },
  );

  it('conserva el 401 y su mensaje para credenciales inválidas', async () => {
    const user = users.get(Role.CLIENT)!;

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'wrong-password' })
      .expect(401);

    expect(response.body).toMatchObject({
      statusCode: 401,
      message: 'Credenciales inválidas',
      error: 'Unauthorized',
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('devuelve VALIDATION_ERROR con campos Nest heredados en login inválido', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '' })
      .expect(400);

    expect(response.body).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      code: 'VALIDATION_ERROR',
    });
    expect(Array.isArray(response.body.message)).toBe(true);
  });

  it('deniega 401 anónimo en endpoints ADMIN, DRIVER y pedido propio existentes', async () => {
    for (const path of ['/api/v1/drivers', '/api/v1/drivers/me/routes', `/api/v1/orders/${ownOrderId}`]) {
      const response = await request(app.getHttpServer()).get(path);
      expect(response.status).toBe(401);
      expect(secretKeys(response.body)).toEqual([]);
    }
  });

  it('revalida el rol desde DB: un JWT ADMIN previo pierde permiso tras downgrade', async () => {
    const actor = await fixtures.createUser(Role.ADMIN, 'issue31-downgrade');
    try {
      await request(app.getHttpServer()).get('/api/v1/drivers')
        .set('Authorization', `Bearer ${actor.token}`).expect(200);
      await prisma.user.where({ id: actor.id }).update({ role: Role.CLIENT });
      const denied = await request(app.getHttpServer()).get('/api/v1/drivers')
        .set('Authorization', `Bearer ${actor.token}`).expect(403);
      expect(secretKeys(denied.body)).toEqual([]);
    } finally {
      await prisma.user.where({ id: actor.id }).update({ role: Role.ADMIN });
    }
  });

  it('mantiene las guardas ADMIN de conductores sin depender de rutas Shop inexistentes', async () => {
    const admin = await request(app.getHttpServer())
      .get('/api/v1/drivers')
      .set('Authorization', `Bearer ${tokens.get(Role.ADMIN)}`);
    expect(admin.status).toBe(200);

    for (const role of [Role.CLIENT, Role.DRIVER]) {
      const denied = await request(app.getHttpServer())
        .get('/api/v1/drivers')
        .set('Authorization', `Bearer ${tokens.get(role)}`);
      expect(denied.status).toBe(403);
    }
  });

  it('mantiene la guarda DRIVER sobre sus rutas y rechaza otros roles', async () => {
    const driver = await request(app.getHttpServer())
      .get('/api/v1/drivers/me/routes')
      .set('Authorization', `Bearer ${tokens.get(Role.DRIVER)}`);
    expect(driver.status).toBe(200);

    for (const role of [Role.ADMIN, Role.CLIENT]) {
      const denied = await request(app.getHttpServer())
        .get('/api/v1/drivers/me/routes')
        .set('Authorization', `Bearer ${tokens.get(role)}`);
      expect(denied.status).toBe(403);
    }
  });

  it('mantiene el acceso CLIENT únicamente a pedidos propios', async () => {
    const ownOrder = await request(app.getHttpServer())
      .get(`/api/v1/orders/${ownOrderId}`)
      .set('Authorization', `Bearer ${tokens.get(Role.CLIENT)}`);
    expect(ownOrder.status).toBe(200);
    expect(ownOrder.body.id).toBe(ownOrderId);
    expect(ownOrder.body.userId).toBe(users.get(Role.CLIENT)!.id);

    const foreignOrder = await request(app.getHttpServer())
      .get(`/api/v1/orders/${foreignOrderId}`)
      .set('Authorization', `Bearer ${tokens.get(Role.CLIENT)}`);
    expect(foreignOrder.status).toBe(403);
  });

  it('no expone el hash de contraseña en el listado ADMIN de repartidores', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/drivers')
      .set('Authorization', `Bearer ${tokens.get(Role.ADMIN)}`)
      .expect(200);

    expect(response.body.length).toBeGreaterThan(0);
    expect(secretKeys(response.body)).toEqual([]);
    const payload = JSON.stringify(response.body);
    for (const hash of passwordHashes) expect(payload).not.toContain(hash);
    expect(Object.keys(response.body[0].user).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'role',
    ]);
  });

  it('no expone el hash de contraseña en el listado ADMIN de rutas', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/routes')
      .set('Authorization', `Bearer ${tokens.get(Role.ADMIN)}`)
      .expect(200);

    expect(response.body.length).toBeGreaterThan(0);
    expect(secretKeys(response.body)).toEqual([]);
    const payload = JSON.stringify(response.body);
    for (const hash of passwordHashes) expect(payload).not.toContain(hash);
    expect(response.body[0].driver.user).toBeDefined();
    expect(Object.keys(response.body[0].driver.user).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'role',
    ]);
  });

  it('no expone el hash de contraseña en el detalle ADMIN de una ruta', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/routes/${routeId}`)
      .set('Authorization', `Bearer ${tokens.get(Role.ADMIN)}`)
      .expect(200);

    expect(secretKeys(response.body)).toEqual([]);
    const payload = JSON.stringify(response.body);
    for (const hash of passwordHashes) expect(payload).not.toContain(hash);
    expect(response.body.driver.user).toBeDefined();
    expect(Object.keys(response.body.driver.user).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'role',
    ]);
  });

  it('documenta el DTO de usuario ADMIN sin la propiedad password', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth({ type: 'http' }, 'JWT-auth').build(),
    );

    const schemas = (document.components?.schemas ?? {}) as unknown as Record<
      string,
      {
        properties?: Record<
          string,
          { enum?: string[]; minLength?: number; maxLength?: number }
        >;
      } | undefined
    >;
    const schema = schemas['AdminRouteHistoryUserDto'];
    expect(schema).toBeDefined();
    expect(Object.keys(schema?.properties ?? {})).not.toContain('password');

    const register = schemas['RegisterDto'];
    expect(Object.keys(register?.properties ?? {}).sort()).toEqual([
      'email',
      'name',
      'password',
    ]);
    expect(register?.properties?.name).toMatchObject({ minLength: 2, maxLength: 120 });
    expect(register?.properties?.password).toMatchObject({ minLength: 8, maxLength: 128 });
    expect(schemas['RegisterResponseDto']?.properties?.role?.enum).toEqual([
      Role.CLIENT,
    ]);
    expect(schemas['AuthErrorResponseDto']?.properties?.code?.enum).toEqual([
      'VALIDATION_ERROR',
      'INVALID_CREDENTIALS',
      'EMAIL_ALREADY_EXISTS',
    ]);
  });
});
