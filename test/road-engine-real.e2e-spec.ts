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
 * Evidencia de punta a punta con un OSRM REAL (calles de Ecuador, perfil `car`), ejecutada a mano:
 *
 *   OSRM_REAL_URL=http://127.0.0.1:5001 pnpm test:e2e -- test/road-engine-real
 *
 * Sin `OSRM_REAL_URL` (por ejemplo en el CI) la suite no hace nada: el CI usa el OSRM simulado de
 * road-engine.e2e-spec.ts. La instancia debe ser LOCAL; nunca se valida contra un servicio público.
 */
const realUrl = process.env.OSRM_REAL_URL;
const suite = realUrl && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(realUrl) ? describe : describe.skip;

suite('Motor vial OSRM real en las propuestas de rutas (#47) en PostgreSQL real', () => {
  let app: INestApplication;
  let adminToken: string;
  const dbName = `roadreal_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const STORE = { lat: -1.24908, lng: -78.61675 };
  // Par con gran rodeo vial medido en docs/osrm/validation-results.json: 1,0 km en línea recta, ~11 km por calles.
  const BARRIER_A = { lat: -1.245, lng: -78.606 };
  const BARRIER_B = { lat: -1.245, lng: -78.597 };
  const DAY = '2030-04-01';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ROAD_ENGINE = 'OSRM';
    process.env.OSRM_BASE_URL = realUrl;
    process.env.OSRM_TIMEOUT_MS = '15000';
    startOwnedContainer();
    const dbUrl = createOwnedDatabase(dbName);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { JwtService } = await import('@nestjs/jwt');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    execPsqlCommand(dbName, `
      INSERT INTO public."user" (id,name,email,password,role) VALUES ('admin','Admin','admin@fixture.invalid','fixture','ADMIN'),('client','Client','client@fixture.invalid','fixture','CLIENT');
      INSERT INTO public.zone (id,name,code,"depotLat","depotLng") VALUES ('zone','Centro','CEN-01',${STORE.lat},${STORE.lng});
      INSERT INTO public."order" (id,"userId","zoneId",status,"deliveryAddress","deliveryLat","deliveryLng","scheduledDeliveryDate") VALUES
        ('${randomUUID()}','client','zone','PENDING','Punto A',${BARRIER_A.lat},${BARRIER_A.lng},'${DAY}T15:00:00Z'),
        ('${randomUUID()}','client','zone','PENDING','Punto B',${BARRIER_B.lat},${BARRIER_B.lng},'${DAY}T15:00:00Z');
    `);
    adminToken = app.get(JwtService).sign({ sub: 'admin', email: 'admin@fixture.invalid', role: 'ADMIN' });
  });

  afterAll(async () => {
    for (const key of ['ROAD_ENGINE', 'OSRM_BASE_URL', 'OSRM_TIMEOUT_MS']) delete process.env[key];
    if (app) await app.close();
    cleanupOwnedResources();
  });

  it('el motor real responde y el ADMIN lo ve disponible', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/route-proposals/road-engine').set({ Authorization: `Bearer ${adminToken}` }).expect(200);
    expect(res.body).toMatchObject({ engine: 'OSRM', available: true, profile: 'car' });
  });

  it('dos puntos a 1 km en línea recta pero separados por un obstáculo: el recorrido vial es mucho mayor y se declara su procedencia', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/route-proposals?date=${DAY}&includeGeometry=true`).set({ Authorization: `Bearer ${adminToken}` }).expect(200);
    const [proposal] = res.body.proposals;
    console.log('EVIDENCIA OSRM REAL', JSON.stringify({
      distanceMethod: res.body.distanceMethod, roadMetrics: res.body.roadMetrics, orders: proposal.orderIds.length,
      totalDistanceKm: proposal.totalDistanceKm, straightLineKm: proposal.straightLineKm, totalDurationSeconds: proposal.totalDurationSeconds,
      geometryPoints: proposal.geometry.coordinates.length,
    }));
    expect(res.body.distanceMethod).toBe('OSRM_ROAD_NETWORK');
    expect(res.body.roadMetrics).toMatchObject({ provider: 'OSRM', trafficAware: false, estimate: true });
    expect(proposal.totalDistanceKm).toBeGreaterThan(proposal.straightLineKm * 1.5);
    expect(proposal.totalDurationSeconds).toBeGreaterThan(0);
    expect(proposal.geometry.coordinates.length).toBeGreaterThan(proposal.stops.length + 2); // el trazado sigue las calles, no une los puntos en línea recta
  });
});
