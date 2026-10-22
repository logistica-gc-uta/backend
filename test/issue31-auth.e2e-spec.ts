import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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

  it('registra un CLIENT y la respuesta no expone la contraseña', async () => {
    const email = emailFor('register');
    registeredEmails.push(email);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: 'Cliente Issue 31', email, password })
      .expect(201);

    expect(response.body.role).toBe(Role.CLIENT);
    expect(response.body.email).toBe(email);
    expect(response.body).not.toHaveProperty('password');
    expect(secretKeys(response.body)).toEqual([]);

    const stored = await prisma.user.where({ email }).first();
    expect(stored.role).toBe(Role.CLIENT);
  });

  it.each([Role.ADMIN, Role.DRIVER])(
    'rechaza el registro con role %s y no crea ningún usuario',
    async (role) => {
      const email = emailFor(`escalation-${role}`);

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ name: 'Escalation', email, password, role })
        .expect(400);

      expect(response.body.message.join(' ')).toContain('role');
      const stored = await prisma.user.where({ email }).first();
      expect(stored).toBeNull();
    },
  );

  it.each([Role.ADMIN, Role.CLIENT, Role.DRIVER])(
    'conserva el login de %s con su forma de respuesta actual',
    async (role) => {
      const user = users.get(role)!;

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password })
        .expect(200);

      expect(typeof response.body.access_token).toBe('string');
      expect(response.body.user).toEqual({
        id: user.id,
        name: user.name,
        email: user.email,
        role,
      });
      expect(secretKeys(response.body)).toEqual([]);
    },
  );

  it('conserva el 401 y su mensaje para credenciales inválidas', async () => {
    const user = users.get(Role.CLIENT)!;

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'wrong-password' })
      .expect(401);

    expect(response.body.message).toBe('Credenciales inválidas');
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
      { properties?: Record<string, unknown> } | undefined
    >;
    const schema = schemas['AdminRouteHistoryUserDto'];
    expect(schema).toBeDefined();
    expect(Object.keys(schema?.properties ?? {})).not.toContain('password');
  });
});
