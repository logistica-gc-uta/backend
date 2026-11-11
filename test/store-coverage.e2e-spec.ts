import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(240_000);

const coverageA = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};

const coverageB = {
  type: 'Polygon',
  coordinates: [
    [
      [20, 20],
      [30, 20],
      [30, 30],
      [20, 30],
      [20, 20],
    ],
  ],
};

const storeA = {
  location: { lat: 1, lng: 1 },
  coverage: coverageA,
};

describe('Store coverage HTTP contract (owned PostgreSQL fixture)', () => {
  let app: INestApplication;
  let db: any;
  let adminToken: string;
  let clientToken: string;
  let driverToken: string;
  let adminUserId: string;
  let clientUserId: string;
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);
  let dbUrl: string;
  let ownedContainerId: string | null = null;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  const expectErrorEnvelope = (body: any, expectedCode: string) => {
    expect(body).toEqual({
      error: {
        code: expectedCode,
        message: expect.any(String),
        details: expect.any(Object),
        requestId: expect.any(String),
      },
    });
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/password|credential|postgresql:\/\/|secret/i);
  };

  beforeAll(async () => {
    const receipt = startOwnedContainer();
    ownedContainerId = receipt.containerId;
    console.log(`[TEST-CONTAINER-RECEIPT] containerId=${receipt.containerId}`);
    dbUrl = createOwnedDatabase(`store_coverage_${dbSuffix}`);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    db = app.get(PrismaService);
    const jwt = app.get(JwtService);

    for (const role of ['ADMIN', 'CLIENT', 'DRIVER'] as const) {
      const id = randomUUID();
      const email = `${role.toLowerCase()}-${id}@example.test`;
      await db.user.create({
        id,
        name: `Fixture ${role}`,
        email,
        password: 'fixture-password-not-real',
        role,
      });
      const token = jwt.sign({ sub: id, email, role });
      if (role === 'ADMIN') {
        adminToken = token;
        adminUserId = id;
      }
      if (role === 'CLIENT') {
        clientToken = token;
        clientUserId = id;
      }
      if (role === 'DRIVER') driverToken = token;
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
    if (ownedContainerId) {
      console.log(`[TEST-CONTAINER-CLEANUP] containerId=${ownedContainerId}`);
    }
  });

  it('GET reports unconfigured without inventing coordinates', async () => {
    const res = await http().get('/api/v1/store-coverage').expect(200);
    expect(res.body).toEqual({ configured: false });
    expect(res.body.location).toBeUndefined();
  });

  it('evaluate rejects points while unconfigured', async () => {
    const res = await http()
      .post('/api/v1/store-coverage/evaluate')
      .send({ lat: 5, lng: 5 })
      .expect(409);
    expectErrorEnvelope(res.body, 'STORE_NOT_CONFIGURED');
  });

  it('forbids unauthenticated and non-ADMIN writes', async () => {
    const unauth = await http().put('/api/v1/admin/store-coverage').send(storeA).expect(401);
    expectErrorEnvelope(unauth.body, 'UNAUTHENTICATED');

    const client = await http()
      .put('/api/v1/admin/store-coverage')
      .set(auth(clientToken))
      .send(storeA)
      .expect(403);
    expectErrorEnvelope(client.body, 'FORBIDDEN');

    const driver = await http()
      .put('/api/v1/admin/store-coverage')
      .set(auth(driverToken))
      .send(storeA)
      .expect(403);
    expectErrorEnvelope(driver.body, 'FORBIDDEN');

    const still = await http().get('/api/v1/store-coverage').expect(200);
    expect(still.body).toEqual({ configured: false });
  });

  it('rejects invalid first write without creating a row', async () => {
    const invalid = await http()
      .put('/api/v1/admin/store-coverage')
      .set(auth(adminToken))
      .send({
        location: { lat: 1, lng: 1 },
        coverage: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] },
      })
      .expect(400);
    expectErrorEnvelope(invalid.body, 'STORE_COVERAGE_INVALID');

    const rows = await db.storeCoverage.all();
    expect(rows).toHaveLength(0);
  });

  it('serializes concurrent first configurations without a 500', async () => {
    const [first, second] = await Promise.all([
      http().put('/api/v1/admin/store-coverage').set(auth(adminToken)).send(storeA),
      http()
        .put('/api/v1/admin/store-coverage')
        .set(auth(adminToken))
        .send({ location: { lat: 2, lng: 2 }, coverage: coverageA }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const rows = await db.storeCoverage.all();
    expect(rows).toHaveLength(1);
  });

  it('ADMIN persists a valid store and coverage', async () => {
    const res = await http()
      .put('/api/v1/admin/store-coverage')
      .set(auth(adminToken))
      .send(storeA)
      .expect(200);

    expect(res.body.configured).toBe(true);
    expect(res.body.location).toEqual({ lat: 1, lng: 1 });
    expect(res.body.coverage).toEqual(coverageA);
    expect(res.body.updatedById).toBe(adminUserId);

    const read = await http().get('/api/v1/store-coverage').expect(200);
    expect(read.body.configured).toBe(true);
    expect(read.body.location).toEqual({ lat: 1, lng: 1 });
    expect(read.body.coverage).toEqual(coverageA);
  });

  it('accepts interior and boundary points and rejects exterior points', async () => {
    const interior = await http()
      .post('/api/v1/store-coverage/evaluate')
      .send({ lat: 5, lng: 5 })
      .expect(200);
    expect(interior.body).toEqual({ accepted: true, position: 'INTERIOR' });

    const boundary = await http()
      .post('/api/v1/store-coverage/evaluate')
      .send({ lat: 0, lng: 5 })
      .expect(200);
    expect(boundary.body).toEqual({ accepted: true, position: 'BOUNDARY' });

    const exterior = await http()
      .post('/api/v1/store-coverage/evaluate')
      .send({ lat: 5, lng: 15 })
      .expect(200);
    expect(exterior.body).toEqual({ accepted: false, position: 'EXTERIOR' });
  });

  it('invalid later write leaves persisted configuration unchanged', async () => {
    const invalid = await http()
      .put('/api/v1/admin/store-coverage')
      .set(auth(adminToken))
      .send({
        location: { lat: 999, lng: 1 },
        coverage: coverageA,
      })
      .expect(400);

    expectErrorEnvelope(invalid.body, 'STORE_LOCATION_INVALID');

    const extra = await http()
      .put('/api/v1/admin/store-coverage')
      .set(auth(adminToken))
      .send({ ...storeA, unexpected: true })
      .expect(400);
    expectErrorEnvelope(extra.body, 'VALIDATION_ERROR');

    const degenerate = await http()
      .put('/api/v1/admin/store-coverage')
      .set(auth(adminToken))
      .send({
        location: { lat: 1, lng: 1 },
        coverage: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [2, 0],
              [0, 0],
            ],
          ],
        },
      })
      .expect(400);
    expectErrorEnvelope(degenerate.body, 'STORE_COVERAGE_INVALID');

    const evaluateInvalid = await http()
      .post('/api/v1/store-coverage/evaluate')
      .send({ lat: 999, lng: 1 })
      .expect(400);
    expectErrorEnvelope(evaluateInvalid.body, 'STORE_LOCATION_INVALID');

    const read = await http().get('/api/v1/store-coverage').expect(200);
    expect(read.body.coverage).toEqual(coverageA);
  });

  it('coverage change does not mutate an already accepted order', async () => {
    const zone = await db.zone.create({
      name: `Fixture zone ${randomUUID().slice(0, 8)}`,
      code: `FZ-${randomUUID().slice(0, 6)}`,
    });
    const order = await db.order.create({
      userId: clientUserId,
      zoneId: zone.id,
      status: 'PENDING',
      total: 10,
      deliveryAddress: 'Fixture address inside coverage A',
      deliveryLat: 5,
      deliveryLng: 5,
    });
    expect(order.userId).toBeTruthy();

    const before = {
      id: order.id,
      status: order.status,
      deliveryAddress: order.deliveryAddress,
      deliveryLat: order.deliveryLat,
      deliveryLng: order.deliveryLng,
      zoneId: order.zoneId,
    };

    const updated = await http()
      .put('/api/v1/admin/store-coverage')
      .set(auth(adminToken))
      .send({ location: { lat: 21, lng: 21 }, coverage: coverageB })
      .expect(200);
    expect(updated.body.coverage).toEqual(coverageB);

    const after = await db.order.where({ id: order.id }).first();
    expect(after).toMatchObject(before);

    const oldPoint = await http()
      .post('/api/v1/store-coverage/evaluate')
      .send({ lat: 5, lng: 5 })
      .expect(200);
    expect(oldPoint.body).toEqual({ accepted: false, position: 'EXTERIOR' });

    const newPoint = await http()
      .post('/api/v1/store-coverage/evaluate')
      .send({ lat: 25, lng: 25 })
      .expect(200);
    expect(newPoint.body).toEqual({ accepted: true, position: 'INTERIOR' });
  });
});
