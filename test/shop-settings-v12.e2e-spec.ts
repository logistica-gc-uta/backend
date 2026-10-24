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

describe('Shop Settings v1.2 HTTP contract & DB verification (owned PostgreSQL fixture)', () => {
  let app: INestApplication;
  let db: any;
  let adminToken: string;
  let clientToken: string;
  let driverToken: string;
  let adminUserId: string;
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);
  let dbUrl: string;

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

  let ownedContainerId: string | null = null;

  beforeAll(async () => {
    const receipt = startOwnedContainer();
    ownedContainerId = receipt.containerId;
    console.log(`[TEST-CONTAINER-RECEIPT] containerId=${receipt.containerId}`);
    dbUrl = createOwnedDatabase(`shop_settings_${dbSuffix}`);
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
      if (role === 'CLIENT') clientToken = token;
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

  describe('GET /api/v1/shop/settings (Public)', () => {
    it('returns 200 with the exact public projection without leaking updatedById or createdAt', async () => {
      const res = await http().get('/api/v1/shop/settings').expect(200);

      expect(res.body).toEqual({
        version: 1,
        currency: 'USD',
        shipping: {
          status: 'FREE_INCLUDED',
          amountCents: 0,
          includedInPrices: true,
        },
        tax: {
          mode: 'SIMULATED',
          enabled: true,
          rateBps: 1500,
          ratePercent: 15,
        },
        limits: {
          maxUnitsPerSkuPerOrder: 10,
        },
        deliverySchedule: {
          timeZone: 'America/Guayaquil',
          startTime: '07:00',
          endTime: '17:00',
          boundariesInclusive: true,
        },
        updatedAt: expect.any(String),
      });

      expect(res.body.updatedById).toBeUndefined();
      expect(res.body.createdAt).toBeUndefined();
    });
  });

  describe('GET /api/v1/admin/shop-settings (Admin)', () => {
    it('rejects anonymous access with 401 UNAUTHENTICATED', async () => {
      const res = await http().get('/api/v1/admin/shop-settings').expect(401);
      expectErrorEnvelope(res.body, 'UNAUTHENTICATED');
    });

    it('rejects CLIENT role with 403 FORBIDDEN', async () => {
      const res = await http()
        .get('/api/v1/admin/shop-settings')
        .set(auth(clientToken))
        .expect(403);
      expectErrorEnvelope(res.body, 'FORBIDDEN');
    });

    it('rejects DRIVER role with 403 FORBIDDEN', async () => {
      const res = await http()
        .get('/api/v1/admin/shop-settings')
        .set(auth(driverToken))
        .expect(403);
      expectErrorEnvelope(res.body, 'FORBIDDEN');
    });

    it('returns 200 for ADMIN with audit fields updatedById and createdAt', async () => {
      const res = await http()
        .get('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .expect(200);

      expect(res.body).toEqual({
        version: 1,
        currency: 'USD',
        shipping: {
          status: 'FREE_INCLUDED',
          amountCents: 0,
          includedInPrices: true,
        },
        tax: {
          mode: 'SIMULATED',
          enabled: true,
          rateBps: 1500,
          ratePercent: 15,
        },
        limits: {
          maxUnitsPerSkuPerOrder: 10,
        },
        deliverySchedule: {
          timeZone: 'America/Guayaquil',
          startTime: '07:00',
          endTime: '17:00',
          boundariesInclusive: true,
        },
        updatedAt: expect.any(String),
        updatedById: null,
        createdAt: expect.any(String),
      });
    });
  });

  describe('PATCH /api/v1/admin/shop-settings (Admin CAS update)', () => {
    it('rejects anonymous, client and driver roles', async () => {
      const anon = await http()
        .patch('/api/v1/admin/shop-settings')
        .send({ expectedVersion: 1, tax: { rateBps: 1000 } })
        .expect(401);
      expectErrorEnvelope(anon.body, 'UNAUTHENTICATED');

      const client = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(clientToken))
        .send({ expectedVersion: 1, tax: { rateBps: 1000 } })
        .expect(403);
      expectErrorEnvelope(client.body, 'FORBIDDEN');

      const driver = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(driverToken))
        .send({ expectedVersion: 1, tax: { rateBps: 1000 } })
        .expect(403);
      expectErrorEnvelope(driver.body, 'FORBIDDEN');
    });

    it('rejects patch with unknown/uneditable fields such as shipping or timeZone', async () => {
      const res = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ expectedVersion: 1, shipping: { amountCents: 500 } })
        .expect(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');

      const resTz = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ expectedVersion: 1, deliverySchedule: { timeZone: 'UTC' } })
        .expect(400);
      expectErrorEnvelope(resTz.body, 'VALIDATION_ERROR');
    });

    it('rejects patch with empty changes / only expectedVersion', async () => {
      const res = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ expectedVersion: 1 })
        .expect(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it('rejects patch with null values for required fields (null != absent)', async () => {
      const res = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ expectedVersion: 1, tax: { rateBps: null } })
        .expect(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    });

    it.each([
      ['(a) tax:null + valid limits change', { tax: null, limits: { maxUnitsPerSkuPerOrder: 20 } }],
      ['(b) limits:null + valid tax change', { limits: null, tax: { rateBps: 1200 } }],
      ['(c) deliverySchedule:null + valid tax change', { deliverySchedule: null, tax: { rateBps: 1200 } }],
      ['(d) tax.enabled:null + rateBps change', { tax: { enabled: null, rateBps: 1200 } }],
      ['(e) deliverySchedule.startTime:null + valid endTime change', { deliverySchedule: { startTime: null, endTime: '16:00' } }],
      ['(f) endTime:null + valid startTime change', { deliverySchedule: { startTime: '08:00', endTime: null } }],
    ])('rejects explicitly supplied null payload: %s with 400 VALIDATION_ERROR without altering projection or audit', async (_label, payload) => {
      const pubBefore = await http().get('/api/v1/shop/settings').expect(200);
      const adminBefore = await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200);
      const auditBefore = await db.client.orm.public.ShopSettingsAudit.all();

      const res = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ ...payload, expectedVersion: adminBefore.body.version });

      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');

      const pubAfter = await http().get('/api/v1/shop/settings').expect(200);
      const adminAfter = await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200);
      const auditAfter = await db.client.orm.public.ShopSettingsAudit.all();

      expect(pubAfter.body).toEqual(pubBefore.body);
      expect(adminAfter.body).toEqual(adminBefore.body);
      expect(auditAfter.length).toBe(auditBefore.length);
    });

    it.each([
      ['empty tax object', { tax: {} }],
      ['empty limits object', { limits: {} }],
      ['empty deliverySchedule object', { deliverySchedule: {} }],
    ])('rejects empty nested patch %s with 400 VALIDATION_ERROR without altering projection or audit', async (_label, payload) => {
      const pubBefore = await http().get('/api/v1/shop/settings').expect(200);
      const adminBefore = await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200);
      const auditBefore = await db.client.orm.public.ShopSettingsAudit.all();

      const res = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ ...payload, expectedVersion: adminBefore.body.version })
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');

      const pubAfter = await http().get('/api/v1/shop/settings').expect(200);
      const adminAfter = await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200);
      const auditAfter = await db.client.orm.public.ShopSettingsAudit.all();

      expect(pubAfter.body).toEqual(pubBefore.body);
      expect(adminAfter.body).toEqual(adminBefore.body);
      expect(auditAfter.length).toBe(auditBefore.length);
    });

    it('rejects equal-time delivery schedule (startTime == endTime) with 400 VALIDATION_ERROR without altering projection or audit', async () => {
      const pubBefore = await http().get('/api/v1/shop/settings').expect(200);
      const adminBefore = await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200);
      const auditBefore = await db.client.orm.public.ShopSettingsAudit.all();

      const res = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: adminBefore.body.version,
          deliverySchedule: { startTime: '12:00', endTime: '12:00' },
        })
        .expect(400);

      expectErrorEnvelope(res.body, 'VALIDATION_ERROR');

      const pubAfter = await http().get('/api/v1/shop/settings').expect(200);
      const adminAfter = await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200);
      const auditAfter = await db.client.orm.public.ShopSettingsAudit.all();

      expect(pubAfter.body).toEqual(pubBefore.body);
      expect(adminAfter.body).toEqual(adminBefore.body);
      expect(auditAfter.length).toBe(auditBefore.length);
    });

    it('rejects out of bounds tax.rateBps (< 0 or > 10000)', async () => {
      const neg = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ expectedVersion: 1, tax: { rateBps: -1 } })
        .expect(400);
      expectErrorEnvelope(neg.body, 'VALIDATION_ERROR');

      const high = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ expectedVersion: 1, tax: { rateBps: 10001 } })
        .expect(400);
      expectErrorEnvelope(high.body, 'VALIDATION_ERROR');
    });

    it('rejects out of bounds limits.maxUnitsPerSkuPerOrder (< 1 or > 100)', async () => {
      const low = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ expectedVersion: 1, limits: { maxUnitsPerSkuPerOrder: 0 } })
        .expect(400);
      expectErrorEnvelope(low.body, 'VALIDATION_ERROR');

      const high = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({ expectedVersion: 1, limits: { maxUnitsPerSkuPerOrder: 101 } })
        .expect(400);
      expectErrorEnvelope(high.body, 'VALIDATION_ERROR');
    });

    it('rejects delivery schedule with startTime >= endTime or invalid format', async () => {
      const invalid = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: 1,
          deliverySchedule: { startTime: '18:00', endTime: '09:00' },
        })
        .expect(400);
      expectErrorEnvelope(invalid.body, 'VALIDATION_ERROR');

      const badFormat = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: 1,
          deliverySchedule: { startTime: '25:99' },
        })
        .expect(400);
      expectErrorEnvelope(badFormat.body, 'VALIDATION_ERROR');
    });

    it('rejects stale expectedVersion with 409 SETTINGS_VERSION_CONFLICT without modifying state or audit', async () => {
      const res = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: 99,
          tax: { rateBps: 1200 },
        })
        .expect(409);

      expectErrorEnvelope(res.body, 'SETTINGS_VERSION_CONFLICT');

      // Verify DB version and audit unchanged
      const current = await db.client.orm.public.ShopBusinessSettings.first();
      expect(current.version).toBe(1);
      const auditCount = await db.client.orm.public.ShopSettingsAudit.all();
      expect(auditCount.length).toBe(0);
    });

    it('applies valid partial update, increments version, updates updatedById, and records audit in same transaction', async () => {
      const res = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: 1,
          tax: { rateBps: 1200 },
          limits: { maxUnitsPerSkuPerOrder: 15 },
        })
        .expect(200);

      expect(res.body.version).toBe(2);
      expect(res.body.tax.rateBps).toBe(1200);
      expect(res.body.tax.ratePercent).toBe(12);
      expect(res.body.limits.maxUnitsPerSkuPerOrder).toBe(15);
      expect(res.body.updatedById).toBe(adminUserId);

      // Verify public endpoint reflects new values
      const pub = await http().get('/api/v1/shop/settings').expect(200);
      expect(pub.body.version).toBe(2);
      expect(pub.body.tax.rateBps).toBe(1200);
      expect(pub.body.limits.maxUnitsPerSkuPerOrder).toBe(15);

      // Verify DB audit record persisted
      const audits = await db.client.orm.public.ShopSettingsAudit.all();
      expect(audits.length).toBe(1);
      expect(audits[0].expectedVersion).toBe(1);
      expect(audits[0].newVersion).toBe(2);
      expect(audits[0].actorId).toBe(adminUserId);
      expect(audits[0].changedFields).toHaveProperty('tax');
      expect(audits[0].changedFields).toHaveProperty('limits');
    });

    it('validates partial schedule updates against existing DB schedule boundaries', async () => {
      // Current schedule is 07:00 to 17:00.
      // Setting startTime to 18:00 without endTime must fail because 18:00 >= 17:00!
      const failPartial = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: 2,
          deliverySchedule: { startTime: '18:00' },
        })
        .expect(400);
      expectErrorEnvelope(failPartial.body, 'VALIDATION_ERROR');

      // Setting startTime to 08:00 should succeed
      const successPartial = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: 2,
          deliverySchedule: { startTime: '08:00' },
        })
        .expect(200);
      expect(successPartial.body.version).toBe(3);
      expect(successPartial.body.deliverySchedule.startTime).toBe('08:00');
      expect(successPartial.body.deliverySchedule.endTime).toBe('17:00');
    });

    it('handles concurrent patches with the same expectedVersion: exactly one succeeds and the other gets 409', async () => {
      const currentVersion = (await http().get('/api/v1/shop/settings')).body.version;

      const p1 = http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: currentVersion,
          tax: { rateBps: 800 },
        });

      const p2 = http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send({
          expectedVersion: currentVersion,
          tax: { rateBps: 900 },
        });

      const [r1, r2] = await Promise.all([p1, p2]);

      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const conflictRes = r1.status === 409 ? r1 : r2;
      expectErrorEnvelope(conflictRes.body, 'SETTINGS_VERSION_CONFLICT');
    });

    it.each([
      ['tax.rateBps lower bound 0', (v: number) => ({ expectedVersion: v, tax: { rateBps: 0 } }), (res: any) => {
        expect(res.body.tax.rateBps).toBe(0);
        expect(res.body.tax.ratePercent).toBe(0);
      }],
      ['tax.rateBps upper bound 10000', (v: number) => ({ expectedVersion: v, tax: { rateBps: 10000 } }), (res: any) => {
        expect(res.body.tax.rateBps).toBe(10000);
        expect(res.body.tax.ratePercent).toBe(100);
      }],
      ['limits.maxUnits lower bound 1', (v: number) => ({ expectedVersion: v, limits: { maxUnitsPerSkuPerOrder: 1 } }), (res: any) => {
        expect(res.body.limits.maxUnitsPerSkuPerOrder).toBe(1);
      }],
      ['limits.maxUnits upper bound 100', (v: number) => ({ expectedVersion: v, limits: { maxUnitsPerSkuPerOrder: 100 } }), (res: any) => {
        expect(res.body.limits.maxUnitsPerSkuPerOrder).toBe(100);
      }],
      ['schedule full-day boundary 00:00 < 23:59', (v: number) => ({ expectedVersion: v, deliverySchedule: { startTime: '00:00', endTime: '23:59' } }), (res: any) => {
        expect(res.body.deliverySchedule.startTime).toBe('00:00');
        expect(res.body.deliverySchedule.endTime).toBe('23:59');
      }],
    ])('accepts S4 boundary: %s', async (_label, makePayload, assertions) => {
      const adminBefore = await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200);
      const currentVersion = adminBefore.body.version;

      const res = await http()
        .patch('/api/v1/admin/shop-settings')
        .set(auth(adminToken))
        .send(makePayload(currentVersion))
        .expect(200);

      expect(res.body.version).toBe(currentVersion + 1);
      assertions(res);
    });

    it('rolls back settings update on late audit-write failure in same transaction', async () => {
      const { ShopSettingsService } = await import('../src/modules/shop/settings/shop-settings.service.js');
      const adminBefore = await http().get('/api/v1/admin/shop-settings').set(auth(adminToken)).expect(200);
      const currentVersion = adminBefore.body.version;
      const auditCountBefore = (await db.client.orm.public.ShopSettingsAudit.all()).length;

      const failingService = new ShopSettingsService({
        client: {
          raw: (db.client as any).raw,
          orm: (db.client as any).orm,
          transaction: (fn: any) =>
            (db.client as any).transaction(async (tx: any) => {
              const wrappedTx = new Proxy(tx, {
                get(target, prop, receiver) {
                  if (prop === 'orm') {
                    return new Proxy(target.orm, {
                      get(ormTarget, ormProp, ormReceiver) {
                        if (ormProp === 'public') {
                          return new Proxy(ormTarget.public, {
                            get(pubTarget, pubProp, pubReceiver) {
                              if (pubProp === 'ShopSettingsAudit') {
                                return new Proxy(pubTarget.ShopSettingsAudit, {
                                  get(auditTarget, auditProp, auditReceiver) {
                                    if (auditProp === 'create') {
                                      return async () => {
                                        throw new Error('injected late audit-write failure');
                                      };
                                    }
                                    return Reflect.get(auditTarget, auditProp, auditReceiver);
                                  },
                                });
                              }
                              return Reflect.get(pubTarget, pubProp, pubReceiver);
                            },
                          });
                        }
                        return Reflect.get(ormTarget, ormProp, ormReceiver);
                      },
                    });
                  }
                  return Reflect.get(target, prop, receiver);
                },
              });
              return fn(wrappedTx);
            }),
        },
      } as any);

      await expect(
        failingService.patchAdminSettings(adminUserId, {
          expectedVersion: currentVersion,
          tax: { rateBps: 2500 },
        }),
      ).rejects.toThrow('injected late audit-write failure');

      // Assert DB state and audit count are completely rolled back
      const currentAfter = await db.client.orm.public.ShopBusinessSettings.first();
      expect(currentAfter.version).toBe(currentVersion);
      expect(currentAfter.taxRateBps).toBe(adminBefore.body.tax.rateBps);
      const auditCountAfter = (await db.client.orm.public.ShopSettingsAudit.all()).length;
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  describe('Legacy compatibility preserved', () => {
    it('public categories endpoint continues to respond normally', async () => {
      const res = await http().get('/api/v1/shop/categories').expect(200);
      expect(res.body).toHaveProperty('items');
      expect(Array.isArray(res.body.items)).toBe(true);
    });
  });
});
