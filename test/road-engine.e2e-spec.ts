import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { startFakeOsrmServer } from './fake-osrm.js';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  execPsqlCommand,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(300_000);

/**
 * Issue #47: motor vial (OSRM) en las propuestas de rutas, sobre PostgreSQL real (contenedor propio) y un
 * servidor OSRM simulado en loopback. El simulador NO es un servicio de producción: la validación con calles
 * reales está en docs/issue-47-road-engine.md. Aquí se prueban los contratos y las fallas a través de la API.
 */
describe('Motor vial OSRM en las propuestas de rutas (#47) en PostgreSQL real', () => {
  let app: INestApplication;
  let db: any;
  let osrm: Awaited<ReturnType<typeof startFakeOsrmServer>>;
  let adminToken: string;
  let clientToken: string;
  const dbName = `road_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  // El historial de reservas de pedidos es inmutable (no se puede borrar): cada prueba usa su propio día.
  let dayNumber = 0;
  let DAY = '2030-03-01';
  let AT = `${DAY}T15:00:00Z`; // 10:00 en Guayaquil
  const nextDay = () => {
    dayNumber += 1;
    DAY = Temporal.PlainDate.from('2030-03-01').add({ days: dayNumber }).toString();
    AT = `${DAY}T15:00:00Z`;
  };
  const DEPOT = { lat: -1.241, lng: -78.619 };
  // El río simulado está en lng = -78.62: el depósito queda al este; «WEST» al otro lado.
  const WEST = { lat: -1.236, lng: -78.628 };
  const EAST = { lat: -1.236, lng: -78.612 };
  const RIVER = { riverLng: -78.62, bridgeLat: -1.215 };
  let sequence = 0;

  const newOrder = (at: { lat: number; lng: number }, when = AT) => {
    const id = randomUUID();
    execPsqlCommand(dbName, `
      INSERT INTO public."order" (id,"userId","zoneId",status,"deliveryAddress","deliveryLat","deliveryLng","scheduledDeliveryDate")
      VALUES ('${id}','client','zone','PENDING','Dirección ${++sequence}',${at.lat},${at.lng},'${when}')
    `);
    return id;
  };
  const proposals = (query = '') => http().get(`/api/v1/route-proposals?date=${DAY}${query}`).set(auth(adminToken));
  const count = async (model: 'Route' | 'OrderClaim' | 'Order') => (await db.client.orm.public[model].all()).length;

  beforeAll(async () => {
    osrm = await startFakeOsrmServer({ mode: 'ok', ...RIVER });
    process.env.NODE_ENV = 'test';
    process.env.ROAD_ENGINE = 'OSRM';
    process.env.OSRM_BASE_URL = osrm.url;
    process.env.OSRM_TIMEOUT_MS = '1500';
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
    execPsqlCommand(dbName, `
      INSERT INTO public."user" (id,name,email,password,role) VALUES
        ('admin','Admin','admin@fixture.invalid','fixture','ADMIN'),
        ('client','Client','client@fixture.invalid','fixture','CLIENT');
      INSERT INTO public.zone (id,name,code,"depotLat","depotLng") VALUES ('zone','Centro','CEN-01',${DEPOT.lat},${DEPOT.lng});
    `);
    adminToken = jwt.sign({ sub: 'admin', email: 'admin@fixture.invalid', role: 'ADMIN' });
    clientToken = jwt.sign({ sub: 'client', email: 'client@fixture.invalid', role: 'CLIENT' });
  });

  afterAll(async () => {
    for (const key of ['ROAD_ENGINE', 'OSRM_BASE_URL', 'OSRM_TIMEOUT_MS']) delete process.env[key];
    if (app) await app.close();
    if (osrm) await osrm.close();
    cleanupOwnedResources();
  });

  beforeEach(() => {
    osrm.setOptions({ mode: 'ok', ...RIVER });
    nextDay();
  });

  describe('estado del motor', () => {
    it('el ADMIN ve si el motor responde, sin que se exponga la URL de la instancia', async () => {
      const res = await http().get('/api/v1/route-proposals/road-engine').set(auth(adminToken)).expect(200);
      expect(res.body).toMatchObject({ engine: 'OSRM', configured: true, available: true, profile: 'car' });
      expect(JSON.stringify(res.body)).not.toContain(osrm.url);
    });

    it('un CLIENT no lo consulta y sin sesión tampoco', async () => {
      await http().get('/api/v1/route-proposals/road-engine').set(auth(clientToken)).expect(403);
      await http().get('/api/v1/route-proposals/road-engine').expect(401);
    });

    it('con el motor caído informa available=false en lugar de fallar', async () => {
      osrm.setOptions({ mode: 'server-error' });
      const res = await http().get('/api/v1/route-proposals/road-engine').set(auth(adminToken)).expect(200);
      expect(res.body).toMatchObject({ engine: 'OSRM', configured: true, available: false });
    });
  });

  describe('propuesta con métricas viales', () => {
    it('declara la procedencia vial, las unidades y que no hay tráfico en vivo ni hora de llegada garantizada', async () => {
      newOrder(EAST);
      const res = await proposals().expect(200);
      expect(res.body.distanceMethod).toBe('OSRM_ROAD_NETWORK');
      expect(res.body.roadMetrics).toMatchObject({ provider: 'OSRM', profile: 'car', distanceUnit: 'km', durationUnit: 's', directional: true, trafficAware: false, estimate: true });
    });

    it('dos puntos separados por el río: el recorrido por el puente es mayor que la línea recta y se muestra la procedencia vial', async () => {
      newOrder(WEST); // al otro lado del río respecto del depósito
      const res = await proposals().expect(200);
      const [proposal] = res.body.proposals;
      expect(res.body.distanceMethod).toBe('OSRM_ROAD_NETWORK');
      expect(proposal.totalDistanceKm).toBeGreaterThan(proposal.straightLineKm * 1.5);
      expect(proposal.totalDurationSeconds).toBeGreaterThan(0);

      // Mismo trato en el lado del depósito: solo el factor normal de las calles.
      nextDay();
      newOrder(EAST);
      const near = (await proposals().expect(200)).body.proposals[0];
      expect(near.totalDistanceKm / near.straightLineKm).toBeLessThan(proposal.totalDistanceKm / proposal.straightLineKm);
    });

    it('cada parada trae su tramo (distancia y duración) y la vuelta al depósito; la suma coincide con el total', async () => {
      newOrder(EAST);
      newOrder({ lat: -1.238, lng: -78.605 });
      const [proposal] = (await proposals().expect(200)).body.proposals;
      expect(proposal.stops.every((stop: any) => stop.legDistanceKm > 0 && stop.legDurationSeconds > 0)).toBe(true);
      const sum = proposal.stops.reduce((total: number, stop: any) => total + stop.legDistanceKm, 0) + proposal.returnLegDistanceKm;
      expect(sum).toBeCloseTo(proposal.totalDistanceKm, 2);
      const seconds = proposal.stops.reduce((total: number, stop: any) => total + stop.legDurationSeconds, 0) + proposal.returnLegDurationSeconds;
      expect(Math.abs(seconds - proposal.totalDurationSeconds)).toBeLessThanOrEqual(proposal.stops.length + 1); // redondeo por tramo
    });

    it('el mapa recibe el trazado solo si lo pide (includeGeometry) y el planificador no lo necesita', async () => {
      newOrder(EAST);
      const without = (await proposals().expect(200)).body.proposals[0];
      expect(without.geometry).toBeUndefined();
      const calls = osrm.calls.length;
      const withGeometry = (await proposals('&includeGeometry=true').expect(200)).body.proposals[0];
      expect(withGeometry.geometry.type).toBe('LineString');
      expect(withGeometry.geometry.coordinates).toHaveLength(withGeometry.stops.length + 2);
      expect(osrm.calls.slice(calls).some((url) => url.startsWith('/route/v1/'))).toBe(true);
      await proposals('&includeGeometry=quizás').expect(400);
    });

    it('un CLIENT no pide propuestas viales', async () => {
      await http().get(`/api/v1/route-proposals?date=${DAY}`).set(auth(clientToken)).expect(403);
    });
  });

  describe('fallas del motor: no se genera nada y no se cambia nada', () => {
    const snapshot = async () => ({ routes: await count('Route'), claims: await count('OrderClaim'), orders: await count('Order') });

    it('OSRM caído: 503 ROAD_ENGINE_UNAVAILABLE, los pedidos siguen pendientes y una ruta ya generada no se cancela', async () => {
      const kept = newOrder(EAST);
      const draft = await http().post('/api/v1/routes').set(auth(adminToken)).send({ zoneId: 'zone', orderIds: [kept], routeDate: AT }).expect(201);
      const pending = newOrder(WEST);
      const before = await snapshot();

      osrm.setOptions({ mode: 'server-error' });
      const res = await proposals().expect(503);

      expect(res.body).toMatchObject({ statusCode: 503, code: 'ROAD_ENGINE_UNAVAILABLE' });
      expect(res.body.message).toEqual(expect.any(String));
      expect(await snapshot()).toEqual(before); // nada se persistió ni se borró
      expect((await db.client.orm.public.Route.where({ id: draft.body.id }).first()).status).toBe('DRAFT');
      expect((await db.client.orm.public.Order.where({ id: pending }).first()).status).toBe('PENDING');
      expect(JSON.stringify(res.body)).not.toContain(osrm.url);
    });

    it('OSRM lento (tiempo agotado): 503 y sin distancias ficticias', async () => {
      newOrder(EAST);
      osrm.setOptions({ mode: 'slow', slowMs: 3000 });
      const res = await proposals().expect(503);
      expect(res.body.code).toBe('ROAD_ENGINE_UNAVAILABLE');
      expect(res.body.message).toContain('ms');
      expect(res.body.proposals).toBeUndefined();
    });

    it('respuesta incompleta del motor: 502 ROAD_ENGINE_BAD_RESPONSE, nunca ceros', async () => {
      newOrder(EAST);
      osrm.setOptions({ mode: 'incomplete' });
      const res = await proposals().expect(502);
      expect(res.body).toMatchObject({ code: 'ROAD_ENGINE_BAD_RESPONSE' });
      expect(res.body.proposals).toBeUndefined();
    });

    it('par de puntos sin recorrido: 422 ROAD_ROUTE_NOT_FOUND con los pedidos afectados', async () => {
      const a = newOrder(EAST);
      const b = newOrder(WEST);
      const before = await snapshot();
      osrm.setOptions({ mode: 'no-route-pair', isolatedIndex: 1, ...RIVER });
      const res = await proposals().expect(422);
      expect(res.body).toMatchObject({ statusCode: 422, code: 'ROAD_ROUTE_NOT_FOUND' });
      expect([a, b].some((id) => res.body.details.orderIds.includes(id))).toBe(true);
      expect(await snapshot()).toEqual(before);
    });

    it('punto lejos de la red vial: 422 ROAD_POINT_OFF_NETWORK con el pedido afectado', async () => {
      newOrder(EAST);
      const far = newOrder(WEST);
      osrm.setOptions({ mode: 'far-point', isolatedIndex: 2, ...RIVER });
      const res = await proposals().expect(422);
      expect(res.body.code).toBe('ROAD_POINT_OFF_NETWORK');
      expect(res.body.details.orderIds).toEqual([far]);
    });

    it('más puntos que el límite configurado: 422 ROAD_MATRIX_TOO_LARGE sin llamar a OSRM', async () => {
      // El límite por defecto es 300 puntos; se comprueba con el servicio configurado para 3.
      const { RoadMetricsService } = await import('../src/modules/routes/road/road-metrics.service.js');
      const { DEFAULT_ROAD_CONFIG } = await import('../src/modules/routes/road/road-metrics.types.js');
      const tight = new RoadMetricsService({ ...DEFAULT_ROAD_CONFIG, engine: 'OSRM', baseUrl: osrm.url, maxPoints: 3 });
      const calls = osrm.calls.length;
      await expect(tight.matrixFor([DEPOT, EAST, WEST, { lat: -1.2, lng: -78.6 }])).rejects.toMatchObject({ code: 'ROAD_MATRIX_TOO_LARGE' });
      expect(osrm.calls.length).toBe(calls);
    });

    it('al volver el motor, la misma petición funciona sin intervención', async () => {
      newOrder(EAST);
      osrm.setOptions({ mode: 'server-error' });
      await proposals().expect(503);
      osrm.setOptions({ mode: 'ok', ...RIVER });
      await proposals().expect(200);
    });
  });

  describe('urgencias con el motor vial', () => {
    const urgentOrder = () => {
      const id = randomUUID();
      const today = Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate().toString();
      execPsqlCommand(dbName, `
        INSERT INTO public."user" (id,name,email,password,role) VALUES ('urg-driver','Repartidor','urg@fixture.invalid','fixture','DRIVER') ON CONFLICT DO NOTHING;
        INSERT INTO public.driver (id,"userId",vehicle,"isAvailable") VALUES ('urg-driver','urg-driver','Moto',true) ON CONFLICT DO NOTHING;
        INSERT INTO public."order" (id,"userId","zoneId",status,"deliveryAddress","deliveryLat","deliveryLng","scheduledDeliveryDate")
        VALUES ('${id}','client','zone','PENDING','Urgente',${EAST.lat},${EAST.lng},'${today}T15:00:00Z')
      `);
      return id;
    };

    it('con el motor disponible la urgencia se mide por calles', async () => {
      const id = urgentOrder();
      const res = await http().get(`/api/v1/dispatch/orders/${id}/proposal`).set(auth(adminToken)).expect(200);
      expect(res.body.distanceMethod).toBe('OSRM_ROAD_NETWORK');
      expect(res.body.totalDistanceKm).toBeGreaterThan(0);
    });

    it('con el motor caído la urgencia queda BLOQUEADA con el código del error: no se propone una salida con datos inexistentes', async () => {
      const id = urgentOrder();
      osrm.setOptions({ mode: 'server-error' });
      const res = await http().get(`/api/v1/dispatch/orders/${id}/proposal`).set(auth(adminToken)).expect(200);
      expect(res.body).toMatchObject({ kind: 'BLOCKED', reasons: ['ROAD_ENGINE_UNAVAILABLE'], orderIds: [], totalDistanceKm: 0 });
      expect((await db.client.orm.public.Order.where({ id }).first()).status).toBe('PENDING');
    });
  });

  describe('prioridad horaria, margen dinámico y origen común (#48)', () => {
    const snapshot = async () => ({ routes: await count('Route'), claims: await count('OrderClaim'), orders: await count('Order') });

    it('separa 10:00, 10:25 y 10:50 con margen por defecto de 30 min en [10:00, 10:25] + [10:50] en orden cronológico', async () => {
      const o3 = newOrder({ lat: -1.2371, lng: -78.6109 }, `${DAY}T15:50:00Z`);
      const o1 = newOrder({ lat: -1.236, lng: -78.612 }, `${DAY}T15:00:00Z`);
      const o2 = newOrder({ lat: -1.237, lng: -78.611 }, `${DAY}T15:25:00Z`);

      const res = await proposals().expect(200);

      expect(res.body.timeWindowMarginMinutes).toBe(30);
      expect(res.body.proposals).toHaveLength(2);
      expect(res.body.proposals[0].orderIds).toEqual([o1, o2]);
      expect(res.body.proposals[1].orderIds).toEqual([o3]);
    });

    it('PATCH /api/v1/admin/shop-settings cambia timeWindowMarginMinutes y modifica la agrupación en vivo', async () => {
      const o1 = newOrder({ lat: -1.236, lng: -78.612 }, `${DAY}T15:00:00Z`);
      const o2 = newOrder({ lat: -1.237, lng: -78.611 }, `${DAY}T15:25:00Z`);
      const o3 = newOrder({ lat: -1.2371, lng: -78.6109 }, `${DAY}T15:50:00Z`);

      const settingsBefore = await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200);
      expect(settingsBefore.body.routePlanning.timeWindowMarginMinutes).toBe(30);

      const updated = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: settingsBefore.body.version,
          routePlanning: { timeWindowMarginMinutes: 60 },
        })
        .expect(200);
      expect(updated.body.routePlanning.timeWindowMarginMinutes).toBe(60);

      try {
        const res = await proposals().expect(200);
        expect(res.body.timeWindowMarginMinutes).toBe(60);
        expect(res.body.proposals).toHaveLength(1);
        expect(res.body.proposals[0].orderIds).toEqual([o1, o2, o3]);
      } finally {
        await http()
          .patch('/api/v1/admin/shop-settings')
          .set(auth(adminToken))
          .send({
            expectedVersion: updated.body.version,
            routePlanning: { timeWindowMarginMinutes: settingsBefore.body.routePlanning.timeWindowMarginMinutes },
          })
          .expect(200);
      }
    });

    it('cuando StoreCoverage está configurado usa su ubicación como origen y retorno común de las propuestas', async () => {
      const STORE = { lat: -1.24908, lng: -78.61675 };
      await http()
        .put('/api/v1/admin/store-coverage')
        .set(auth(adminToken))
        .send({
          location: STORE,
          coverage: {
            type: 'Polygon',
            coordinates: [
              [
                [-78.7, -1.3],
                [-78.5, -1.3],
                [-78.5, -1.1],
                [-78.7, -1.1],
                [-78.7, -1.3],
              ],
            ],
          },
        })
        .expect(200);

      newOrder(EAST, `${DAY}T15:00:00Z`);
      const res = await proposals('&includeGeometry=true').expect(200);

      expect(res.body.proposals).toHaveLength(1);
      expect(res.body.proposals[0].depot).toEqual(STORE);
      expect(res.body.proposals[0].geometry.coordinates[0]).toEqual([STORE.lng, STORE.lat]);
      expect(res.body.proposals[0].geometry.coordinates.at(-1)).toEqual([STORE.lng, STORE.lat]);
    });

    it('con OSRM caído sigue siendo estrictamente de solo lectura (503 sin mutaciones en BD)', async () => {
      newOrder(EAST, `${DAY}T15:00:00Z`);
      const before = await snapshot();

      osrm.setOptions({ mode: 'server-error' });
      const res = await proposals().expect(503);

      expect(res.body.code).toBe('ROAD_ENGINE_UNAVAILABLE');
      expect(await snapshot()).toEqual(before);
    });
  });
});
