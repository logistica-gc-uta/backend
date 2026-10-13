import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from '../src/prisma/contract.d';
import contractJson from '../src/prisma/contract.json' with { type: 'json' };
import { startOwnedContainer, createOwnedDatabase, runPrismaMigrate, cleanupOwnedResources } from './geolocation-migration.fixtures.js';

jest.setTimeout(120_000);
const events = ['order.status.updated', 'route.updated', 'dispatch.incident.updated', 'driver.availability.updated'] as const;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 120));

describe('Issue13: real PostgreSQL, Socket.IO JWT rooms and REST resynchronization', () => {
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let base: string;
  let failCommit = false;
  const oldSecret = process.env.JWT_SECRET;
  const oldOrigins = process.env.REALTIME_ALLOWED_ORIGINS;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const sockets: Socket[] = [];
  let ids: Record<string, string>;
  const token = (sub: string, role = 'ADMIN') => jwt.sign({ sub, role }, { expiresIn: '1h' });
  const api = (method: 'get' | 'post' | 'patch', path: string, body?: object, sub?: string, role = 'ADMIN') =>
    request(app.getHttpServer())[method]('/api/v1' + path).auth(token(sub ?? ids.admin!, role), { type: 'bearer' }).send(body);
  const capture = (socket: Socket) => {
    const packets: { event: string; payload: any }[] = [];
    for (const event of events) socket.on(event, (payload) => packets.push({ event, payload }));
    return packets;
  };
  const connect = async (value?: string, origin: string | null = 'https://fixture.example') => {
    const socket = io(base + '/realtime', {
      autoConnect: false, forceNew: true, reconnection: false, transports: ['websocket'],
      auth: value ? { token: value } : {},
      ...(origin ? { extraHeaders: { Origin: origin } } : {}),
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket connection timeout')), 3000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
      socket.connect();
    });
    return socket;
  };
  const subscribe = (socket: Socket, resource: string, id?: string) => new Promise<any>((resolve, reject) => {
    socket.timeout(3000).emit('resource.subscribe', { resource, ...(id ? { id } : {}) }, (error: Error | null, ack: any) => error ? reject(error) : resolve(ack));
  });
  const listen = async (socket: Socket, resource: string, id?: string) => expect(await subscribe(socket, resource, id)).toMatchObject({ ok: true });
  const order = async () => db.orm.public.Order.create({
    userId: ids.client!, zoneId: ids.zone!, deliveryAddress: 'Private fixture address',
    scheduledDeliveryDate: Temporal.Now.instant(), deliveryLat: -1.25, deliveryLng: -78.62,
  });
  const route = async (orders: { id: string }[]) => {
    const response = await api('post', '/routes', { zoneId: ids.zone, routeDate: Temporal.Now.instant().toString(), orderIds: orders.map((o) => o.id) }).expect(201);
    await api('post', `/routes/${response.body.id}/assign`, { driverId: ids.driver }).expect(200);
    return response.body.id as string;
  };
  const start = (id: string) => api('post', `/routes/${id}/start`, {}, ids.driverUser, 'DRIVER').expect(200);
  const status = (id: string, value: string) => api('patch', `/orders/${id}/status`, { status: value }, ids.driverUser, 'DRIVER');
  const readOrder = async (id: string, sub = ids.client!) => (await api('get', `/orders/${id}`, undefined, sub, 'CLIENT').expect(200)).body;
  const intervene = (body: object) => api('post', '/dispatch/interventions', { requestId: randomUUID(), reason: 'Private conversation must never reach socket', ...body });
  const assertPacket = (packet: any, id: string) => {
    expect(Object.keys(packet).sort()).toEqual(['data', 'eventId', 'occurredAt', 'version']);
    expect(packet.version).toBe(1);
    expect(packet.eventId).toMatch(/^[a-f0-9-]{36}$/);
    expect(Number.isNaN(Date.parse(packet.occurredAt))).toBe(false);
    expect(packet.data.orderId ?? packet.data.routeId ?? packet.data.driverId).toBe(id);
    const allowed = ['orderId', 'routeId', 'driverId', 'status', 'requiresAdministrativeReview', 'action', 'available'];
    expect(Object.keys(packet.data).every((key) => allowed.includes(key))).toBe(true);
    expect(JSON.stringify(packet.data)).not.toMatch(/Private fixture address|Private conversation|private-fixture-credential|fixture\.invalid/i);
  };

  beforeAll(async () => {
    startOwnedContainer();
    const url = createOwnedDatabase('realtime_' + randomUUID().replaceAll('-', '').slice(0, 8));
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    process.env.REALTIME_ALLOWED_ORIGINS = 'https://fixture.example';
    db = postgres<Contract>({ contractJson, url });
    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const transaction = async (fn: any) => db.transaction(async (tx) => {
      const result = await fn(tx);
      if (failCommit) { failCommit = false; throw new Error('Injected owned-fixture commit rejection'); }
      return result;
    });
    const client = new Proxy(db, { get(target, key) { return key === 'transaction' ? transaction : Reflect.get(target, key); } });
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue({
      client, orm: db.orm, sql: db.sql, user: db.orm.public.User, driver: db.orm.public.Driver,
      zone: db.orm.public.Zone, order: db.orm.public.Order, orderItem: db.orm.public.OrderItem,
      product: db.orm.public.Product, route: db.orm.public.Route,
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  beforeEach(async () => {
    ids = Object.fromEntries(['admin', 'client', 'other', 'driverUser', 'driver', 'foreignDriverUser', 'foreignDriver', 'zone'].map((name) => [name, randomUUID()]));
    for (const [key, role] of [['admin', 'ADMIN'], ['client', 'CLIENT'], ['other', 'CLIENT'], ['driverUser', 'DRIVER'], ['foreignDriverUser', 'DRIVER']] as const)
      await db.orm.public.User.create({ id: ids[key]!, role, name: key, email: ids[key] + '@fixture.invalid', password: 'private-fixture-credential' });
    for (const [key, user] of [['driver', 'driverUser'], ['foreignDriver', 'foreignDriverUser']] as const)
      await db.orm.public.Driver.create({ id: ids[key]!, userId: ids[user]!, vehicle: 'fixture' });
    await db.orm.public.Zone.create({ id: ids.zone!, code: ids.zone!, name: ids.zone!, depotLat: -1.24, depotLng: -78.61 });
  });
  afterEach(async () => { failCommit = false; for (const socket of sockets.splice(0)) socket.disconnect(); await pause(); });
  afterAll(async () => {
    await app?.close(); await db?.close(); cleanupOwnedResources();
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
    if (oldOrigins === undefined) delete process.env.REALTIME_ALLOWED_ORIGINS; else process.env.REALTIME_ALLOWED_ORIGINS = oldOrigins;
  });

  // Independent public probes retained from the S2/S5/S8 verification.
  it('rejects expired and wrong-key JWTs before connecting', async () => {
    const expired = jwt.sign({ sub: ids.admin!, role: 'ADMIN' }, { expiresIn: -60 });
    const wrongSignature = new JwtService({ secret: randomUUID() }).sign(
      { sub: ids.admin!, role: 'ADMIN' }, { expiresIn: '1h' },
    );
    for (const candidate of [expired, wrongSignature]) {
      await expect(connect(candidate)).rejects.toThrow();
      expect(sockets.at(-1)!.connected).toBe(false);
    }
    await pause();
    expect(sockets.every((socket) => !socket.connected)).toBe(true);
  });

  it('publishes the minimal route projection after public assignment commits', async () => {
    const target = await order();
    const created = await api('post', '/routes', {
      zoneId: ids.zone, routeDate: Temporal.Now.instant().toString(), orderIds: [target.id],
    }).expect(201);
    const routeId = created.body.id as string;
    const socket = await connect(token(ids.admin!));
    expect(await subscribe(socket, 'route', routeId)).toEqual({ ok: true });
    const received = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('route.updated packet timeout')), 3000);
      socket.once('route.updated', (payload) => { clearTimeout(timer); resolve(payload); });
    });
    await api('post', `/routes/${routeId}/assign`, { driverId: ids.driver }).expect(200);
    const persisted = (await api('get', `/routes/${routeId}`).expect(200)).body;
    expect(persisted.status).toBe('ASSIGNED');
    const packet = await received;
    assertPacket(packet, routeId);
    expect(packet.data).toEqual({ routeId, status: persisted.status });
  });

  it('publishes versioned delivery only after persisted success to authorized order recipients', async () => {
    const target = await order(); const r = await route([target]); await start(r);
    const owner = await connect(token(ids.client!, 'CLIENT'));
    const driver = await connect(token(ids.driverUser!, 'DRIVER'));
    const admin = await connect(token(ids.admin!));
    for (const socket of [owner, driver, admin]) await listen(socket, 'order', target.id);
    const packets = [owner, driver, admin].map(capture);
    await status(target.id, 'IN_TRANSIT').expect(200); await pause();
    const before = packets.map((p) => p.length);
    await status(target.id, 'DELIVERED').expect(200); await pause();
    const persisted = await readOrder(target.id);
    expect(persisted.status).toBe('DELIVERED');
    packets.forEach((p, i) => {
      const fresh = p.slice(before[i]);
      expect(fresh.filter((e) => e.event === 'order.status.updated')).toHaveLength(1);
      const event = fresh.find((e) => e.event === 'order.status.updated')!;
      assertPacket(event.payload, target.id); expect(event.payload.data.status).toBe(persisted.status);
    });
  });

  it('publishes nothing on real transaction rollback or rejected transition and preserves public state/counters', async () => {
    const target = await order(); const r = await route([target]); await start(r);
    const owner = await connect(token(ids.client!, 'CLIENT')); await listen(owner, 'order', target.id);
    const admin = await connect(token(ids.admin!)); await listen(admin, 'incidents');
    const packets = [capture(owner), capture(admin)];
    const before = await readOrder(target.id);
    const auditBefore = (await api('get', '/dispatch/audit').expect(200)).body;
    failCommit = true;
    await status(target.id, 'IN_TRANSIT').expect(500); await pause();
    expect(await readOrder(target.id)).toEqual(before);
    expect((await api('get', '/dispatch/audit').expect(200)).body).toEqual(auditBefore);
    packets.forEach((p) => expect(p).toEqual([]));
    await status(target.id, 'DELIVERED').expect(400); await pause();
    expect(await readOrder(target.id)).toEqual(before);
    packets.forEach((p) => expect(p).toEqual([]));
  });

  it('denies missing/invalid JWT, token-role spoofing, foreign resources and websocket Origin', async () => {
    await expect(connect()).rejects.toThrow();
    await expect(connect('invalid')).rejects.toThrow();
    await expect(connect(token(ids.admin!), 'https://untrusted.invalid')).rejects.toThrow();
    const target = await order(); const r = await route([target]);
    const foreign = await connect(token(ids.other!, 'ADMIN'));
    const packets = capture(foreign);
    expect(await subscribe(foreign, 'order', target.id)).toMatchObject({ ok: false });
    expect(await subscribe(foreign, 'route', r)).toMatchObject({ ok: false });
    expect(await subscribe(foreign, 'incidents')).toMatchObject({ ok: false });
    expect(await subscribe(foreign, 'driver', ids.driver)).toMatchObject({ ok: false });
    const driver = await connect(token(ids.foreignDriverUser!, 'DRIVER'), null);
    expect(await subscribe(driver, 'route', r)).toMatchObject({ ok: false });
    expect(await subscribe(driver, 'order', target.id)).toMatchObject({ ok: false });
    const client = await connect(token(ids.client!, 'CLIENT'));
    expect(await subscribe(client, 'route', r)).toMatchObject({ ok: false });
    expect(await subscribe(client, 'order', 'not-uuid')).toMatchObject({ ok: false });
    await start(r); await status(target.id, 'IN_TRANSIT').expect(200); await pause();
    expect(packets).toEqual([]);
    await api('get', `/orders/${target.id}`, undefined, ids.other, 'CLIENT').expect(403);
  });

  it('reconnects and resynchronizes the latest authoritative REST state instead of replaying missed events', async () => {
    const target = await order(); const r = await route([target]); await start(r);
    const first = await connect(token(ids.client!, 'CLIENT')); await listen(first, 'order', target.id);
    const oldPackets = capture(first); first.disconnect(); await pause();
    await status(target.id, 'IN_TRANSIT').expect(200); await status(target.id, 'DELIVERED').expect(200); await pause();
    expect(oldPackets).toEqual([]);
    const second = await connect(token(ids.client!, 'CLIENT')); await listen(second, 'order', target.id);
    const packets = capture(second); await pause(); expect(packets).toEqual([]);
    expect((await readOrder(target.id)).status).toBe('DELIVERED');
  });

  it('isolates failed-attempt and CONTACT/RESCHEDULE hints to ADMIN without conversation leakage', async () => {
    const failed = await order(); const delivered = await order(); const r = await route([failed, delivered]); await start(r);
    const owner = await connect(token(ids.client!, 'CLIENT')); await listen(owner, 'order', failed.id);
    const admin = await connect(token(ids.admin!)); await listen(admin, 'incidents');
    const ownerPackets = capture(owner); const adminPackets = capture(admin);
    const history = (await api('get', `/routes/${r}`).expect(200)).body;
    const stop = history.stops.find((s: any) => s.orderId === failed.id);
    await api('post', `/routes/${r}/stops/${stop.id}/failure`, { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Private conversation must remain private' }, ids.driverUser, 'DRIVER').expect(200); await pause();
    const ownerView = await readOrder(failed.id);
    expect(ownerView).not.toHaveProperty('requiresAdministrativeReview');
    const inbox = (await api('get', '/dispatch/inbox').expect(200)).body;
    const incident = inbox.incidents.find((i: any) => i.orderId === failed.id);
    expect(incident).toBeDefined();
    expect(incident.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ failureReason: 'RECIPIENT_ABSENT' })]));
    expect(adminPackets.some((p) => p.event === 'dispatch.incident.updated')).toBe(true);
    expect(ownerPackets.some((p) => p.event === 'dispatch.incident.updated')).toBe(false);
    await status(delivered.id, 'IN_TRANSIT').expect(200); await status(delivered.id, 'DELIVERED').expect(200);
    await api('post', `/routes/${r}/complete`, {}, ids.driverUser, 'DRIVER').expect(200);
    const future = Temporal.Now.zonedDateTimeISO('America/Guayaquil').add({ days: 1 }).with({ hour: 12, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }).toInstant();
    const contact = (await intervene({ action: 'CONTACT', orderId: failed.id, attemptId: incident.attempts[0].id, agreementConfirmed: true, scheduledDeliveryDate: future.toString(), deliveryWindowStart: future.subtract({ minutes: 10 }).toString(), deliveryWindowEnd: future.add({ minutes: 10 }).toString() }).expect(200)).body;
    await pause();
    await intervene({ action: 'RESCHEDULE', orderId: failed.id, agreementId: contact.id }).expect(200); await pause();
    expect((await readOrder(failed.id)).status).toBe('PENDING');
    expect(adminPackets.some((p) => p.payload.data.action === 'CONTACT')).toBe(true);
    expect(adminPackets.some((p) => p.payload.data.action === 'RESCHEDULE')).toBe(true);
    for (const p of [...ownerPackets, ...adminPackets]) assertPacket(p.payload, failed.id);
    expect(ownerPackets.every((p) => p.event === 'order.status.updated')).toBe(true);
  });

  it('does not announce driver availability at completion, only after confirmed depot return', async () => {
    const target = await order(); const r = await route([target]); await start(r);
    const driver = await connect(token(ids.driverUser!, 'DRIVER')); await listen(driver, 'driver', ids.driver);
    const admin = await connect(token(ids.admin!)); await listen(admin, 'driver', ids.driver);
    const packets = [capture(driver), capture(admin)];
    await status(target.id, 'IN_TRANSIT').expect(200); await status(target.id, 'DELIVERED').expect(200);
    await api('post', `/routes/${r}/complete`, {}, ids.driverUser, 'DRIVER').expect(200); await pause();
    expect(packets).toEqual([[], []]);
    await api('post', `/routes/${r}/return`, {}, ids.driverUser, 'DRIVER').expect(200); await pause();
    for (const p of packets) {
      expect(p.filter((e) => e.event === 'driver.availability.updated')).toHaveLength(1);
      const event = p.find((e) => e.event === 'driver.availability.updated')!;
      assertPacket(event.payload, ids.driver!); expect(event.payload.data.available).toBe(true);
    }
    const count = packets.map((p) => p.length);
    await api('post', `/routes/${r}/return`, {}, ids.driverUser, 'DRIVER').expect(200); await pause();
    expect(packets.map((p) => p.length)).toEqual(count);
  });

  it('revalidates assignments and database roles before sending to stale joined rooms', async () => {
    const target = await order(); const r = await route([target]);
    const driver = await connect(token(ids.driverUser!, 'DRIVER')); await listen(driver, 'route', r); await listen(driver, 'order', target.id);
    const packets = capture(driver);
    await intervene({ action: 'REASSIGN_DRIVER', routeId: r, driverId: ids.foreignDriver }).expect(200); await pause();
    expect(packets).toEqual([]);
    const admin = await connect(token(ids.admin!)); await listen(admin, 'incidents');
    const privatePackets = capture(admin);
    await db.orm.public.User.where({ id: ids.admin! }).update({ role: 'CLIENT' });
    await startWithOtherDriver();
    await pause(); expect(privatePackets).toEqual([]);
    async function startWithOtherDriver() {
      await api('post', `/routes/${r}/start`, {}, ids.foreignDriverUser, 'DRIVER').expect(200);
      await api('patch', `/orders/${target.id}/status`, { status: 'IN_TRANSIT' }, ids.foreignDriverUser, 'DRIVER').expect(200);
    }
  });
});
