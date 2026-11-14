import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
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

jest.setTimeout(240000);

/**
 * Issue #53: configuración de producción. Sobre PostgreSQL real (contenedor propio) y JWT reales:
 * 1) el arranque con configuración insegura falla antes de cargar la aplicación y sin mostrar valores;
 * 2) con configuración de producción válida, la web autorizada conserva el servicio, un origen ajeno no recibe CORS,
 *    Swagger queda apagado y el acceso sigue exigiendo autenticación, rol y propiedad por objeto.
 * Los secretos de la prueba se generan aquí; ninguno es una credencial real.
 */
describe('Configuración de producción (#53): PostgreSQL + JWT HTTP', () => {
  const secret = randomUUID() + randomUUID(); // 72 caracteres: cumple el mínimo de producción
  const webOrigin = 'https://tienda.example.test';
  const foreignOrigin = 'https://otro-sitio.example.test';
  const legacyFixedSecret = 'uta_logistica_jwt_secret_key_2026_super_secure';
  const productionEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    NODE_ENV: 'production',
    JWT_SECRET: secret,
    DATABASE_URL: 'postgresql://app:' + randomUUID() + '@db.internal:5432/app',
    CORS_ALLOWED_ORIGINS: webOrigin,
    ...extra,
  });
  const ids = { client: randomUUID(), otherClient: randomUUID(), admin: randomUUID(), driverUser: randomUUID() };
  const sign = (sub: string, role: string, key = secret) =>
    new JwtService({ secret: key }).sign({ sub, role, email: 'fixture@invalid.test' });

  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let orderId: string;

  beforeAll(async () => {
    startOwnedContainer();
    const url = createOwnedDatabase('prodcfg_' + randomUUID().replaceAll('-', '').slice(0, 8));
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    db = postgres<Contract>({ contractJson, url });
    for (const [id, role] of [
      [ids.client, 'CLIENT'],
      [ids.otherClient, 'CLIENT'],
      [ids.admin, 'ADMIN'],
      [ids.driverUser, 'DRIVER'],
    ] as const) {
      await db.orm.public.User.create({ id, role, name: role, email: id + '@fixture.invalid', password: 'not-a-real-password' });
    }
    const zone = await db.orm.public.Zone.create({ code: randomUUID(), name: 'Zona', depotLat: -1.24, depotLng: -78.61 });
    orderId = (
      await db.orm.public.Order.create({ userId: ids.client, zoneId: zone.id, deliveryAddress: 'Fixture street', deliveryLat: -1.25, deliveryLng: -78.62 })
    ).id;

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { loadRuntimeConfig } = await import('../src/config/runtime-config.js');
    const prisma = {
      client: db, orm: db.orm, sql: db.sql,
      user: db.orm.public.User, driver: db.orm.public.Driver, zone: db.orm.public.Zone, order: db.orm.public.Order,
      orderItem: db.orm.public.OrderItem, product: db.orm.public.Product, route: db.orm.public.Route,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(prisma).compile();
    app = moduleRef.createNestApplication();
    // Exactamente la configuración del arranque real, con valores de producción válidos.
    configureApp(app, loadRuntimeConfig(productionEnv()));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    cleanupOwnedResources();
  });

  describe('arranque', () => {
    it('producción sin JWT_SECRET no arranca: informa la variable, sale con código 1 y no revela ningún valor', async () => {
      const { startApplication } = await import('../src/bootstrap.js');
      const logger = new Logger('test');
      const errors: string[] = [];
      jest.spyOn(logger, 'error').mockImplementation((message: unknown) => void errors.push(String(message)));
      const env = productionEnv();
      delete env.JWT_SECRET;
      const result = await startApplication(env, logger);
      expect(result).toEqual({ started: false, exitCode: 1 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('JWT_SECRET es obligatorio');
      expect(errors[0]).not.toContain(legacyFixedSecret);
      expect(errors[0]).not.toContain(env.DATABASE_URL!);
    });

    it('producción con el secreto fijo antiguo o uno corto no arranca y no repite el valor', async () => {
      const { startApplication } = await import('../src/bootstrap.js');
      for (const weak of [legacyFixedSecret, 'demasiado-corto-pero-privado']) {
        const logger = new Logger('test');
        const errors: string[] = [];
        jest.spyOn(logger, 'error').mockImplementation((message: unknown) => void errors.push(String(message)));
        expect(await startApplication(productionEnv({ JWT_SECRET: weak }), logger)).toEqual({ started: false, exitCode: 1 });
        expect(errors.join('\n')).not.toContain(weak);
      }
    });

    it('producción con la credencial de la base de desarrollo, sin orígenes CORS o con comodín no arranca', async () => {
      const { startApplication } = await import('../src/bootstrap.js');
      const cases: NodeJS.ProcessEnv[] = [
        productionEnv({ DATABASE_URL: 'postgresql://logistica_user:logistica_password123@db.internal:5432/x' }),
        productionEnv({ CORS_ALLOWED_ORIGINS: '' }),
        productionEnv({ CORS_ALLOWED_ORIGINS: '*' }),
      ];
      for (const env of cases) {
        const logger = new Logger('test');
        jest.spyOn(logger, 'error').mockImplementation(() => undefined);
        expect(await startApplication(env, logger)).toMatchObject({ started: false, exitCode: 1 });
      }
    });
  });

  describe('autenticación con la configuración de producción', () => {
    it('un token firmado con el secreto fijo antiguo se rechaza y uno firmado con el secreto configurado se acepta', async () => {
      const route = `/api/v1/shop/orders/${orderId}`;
      await request(app.getHttpServer()).get(route).auth(sign(ids.client, 'CLIENT', legacyFixedSecret), { type: 'bearer' }).expect(401);
      await request(app.getHttpServer()).get(route).auth(sign(ids.client, 'CLIENT'), { type: 'bearer' }).expect(200);
    });

    it('sin token se rechaza; un token manipulado o de un usuario inexistente también', async () => {
      const route = `/api/v1/shop/orders/${orderId}`;
      await request(app.getHttpServer()).get(route).expect(401);
      await request(app.getHttpServer()).get(route).auth(sign(ids.client, 'CLIENT') + 'x', { type: 'bearer' }).expect(401);
      await request(app.getHttpServer()).get(route).auth(sign(randomUUID(), 'CLIENT'), { type: 'bearer' }).expect(401);
    });

    it('propiedad por objeto: el dueño ve su pedido y otro cliente no, también desde la web autorizada', async () => {
      const route = `/api/v1/shop/orders/${orderId}`;
      const owner = await request(app.getHttpServer()).get(route).set('Origin', webOrigin).auth(sign(ids.client, 'CLIENT'), { type: 'bearer' }).expect(200);
      expect(owner.body.id).toBe(orderId);
      const other = await request(app.getHttpServer()).get(route).set('Origin', webOrigin).auth(sign(ids.otherClient, 'CLIENT'), { type: 'bearer' }).expect((r) => {
        if (r.status !== 403 && r.status !== 404) throw new Error(`se esperaba 403 o 404 y fue ${r.status}`);
      });
      expect(JSON.stringify(other.body)).not.toContain('Fixture street');
    });

    it('roles: CLIENT y DRIVER no acceden a la bandeja del ADMIN y el ADMIN sí', async () => {
      const inbox = '/api/v1/dispatch/inbox';
      await request(app.getHttpServer()).get(inbox).expect(401);
      await request(app.getHttpServer()).get(inbox).auth(sign(ids.client, 'CLIENT'), { type: 'bearer' }).expect(403);
      await request(app.getHttpServer()).get(inbox).auth(sign(ids.driverUser, 'DRIVER'), { type: 'bearer' }).expect(403);
      await request(app.getHttpServer()).get(inbox).auth(sign(ids.admin, 'ADMIN'), { type: 'bearer' }).expect(200);
    });

    it('un cliente sin cabecera Origin (Flutter) conserva el servicio', async () => {
      await request(app.getHttpServer()).get(`/api/v1/shop/orders/${orderId}`).auth(sign(ids.client, 'CLIENT'), { type: 'bearer' }).expect(200);
    });
  });

  describe('CORS', () => {
    it('la web autorizada recibe sus cabeceras CORS y el preflight se responde', async () => {
      const pre = await request(app.getHttpServer())
        .options(`/api/v1/shop/orders/${orderId}`)
        .set('Origin', webOrigin)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization');
      expect(pre.status).toBe(204);
      expect(pre.headers['access-control-allow-origin']).toBe(webOrigin);
      const real = await request(app.getHttpServer()).get(`/api/v1/shop/orders/${orderId}`).set('Origin', webOrigin).auth(sign(ids.client, 'CLIENT'), { type: 'bearer' }).expect(200);
      expect(real.headers['access-control-allow-origin']).toBe(webOrigin);
    });

    it('un origen ajeno no recibe CORS ni en el preflight ni en la respuesta', async () => {
      const pre = await request(app.getHttpServer())
        .options(`/api/v1/shop/orders/${orderId}`)
        .set('Origin', foreignOrigin)
        .set('Access-Control-Request-Method', 'GET');
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
      const real = await request(app.getHttpServer()).get(`/api/v1/shop/orders/${orderId}`).set('Origin', foreignOrigin).auth(sign(ids.client, 'CLIENT'), { type: 'bearer' });
      expect(real.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('CORS no sustituye la autenticación: la web autorizada sin token también recibe 401', async () => {
      await request(app.getHttpServer()).get(`/api/v1/shop/orders/${orderId}`).set('Origin', webOrigin).expect(401);
    });
  });

  describe('Swagger', () => {
    it('en producción la documentación no se publica por defecto', async () => {
      await request(app.getHttpServer()).get('/api/docs').expect(404);
      await request(app.getHttpServer()).get('/api/docs-json').expect(404);
    });

    it('SWAGGER_ENABLED=true la publica y en desarrollo está activa por defecto', async () => {
      const { configureApp } = await import('../src/bootstrap.js');
      const { loadRuntimeConfig } = await import('../src/config/runtime-config.js');
      for (const env of [productionEnv({ SWAGGER_ENABLED: 'true' }), { NODE_ENV: 'development' }]) {
        const probe = (await Test.createTestingModule({}).compile()).createNestApplication();
        configureApp(probe, loadRuntimeConfig(env));
        await probe.init();
        try {
          await request(probe.getHttpServer()).get('/api/docs').expect(200);
          expect((await request(probe.getHttpServer()).get('/api/docs-json').expect(200)).body.openapi).toBeDefined();
        } finally {
          await probe.close();
        }
      }
    });

    it('en desarrollo sin lista de orígenes CORS queda abierto', async () => {
      const { configureApp } = await import('../src/bootstrap.js');
      const { loadRuntimeConfig } = await import('../src/config/runtime-config.js');
      const probe = (await Test.createTestingModule({}).compile()).createNestApplication();
      configureApp(probe, loadRuntimeConfig({ NODE_ENV: 'development' }));
      await probe.init();
      try {
        const res = await request(probe.getHttpServer()).options('/api/v1/x').set('Origin', 'http://localhost:51234').set('Access-Control-Request-Method', 'GET');
        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:51234');
      } finally {
        await probe.close();
      }
    });
  });
});
