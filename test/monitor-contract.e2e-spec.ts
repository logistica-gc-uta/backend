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

jest.setTimeout(180_000);
const events = ['order.status.updated', 'route.updated', 'dispatch.incident.updated', 'driver.availability.updated'] as const;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 150));
const PRIVATE_REASON = 'Motivo privado de la cancelación que no debe salir por el socket';
const PRIVATE_ADDRESS = 'Dirección privada del cliente';

/**
 * #85: contrato de Seguimiento. Comprueba, sobre PostgreSQL real, REST real y Socket.IO real, que el flujo administrativo
 * (cancelación, emergencia e incidentes) se puede representar con los identificadores y eventos publicados: eventos solo después
 * de persistir, sin motivos ni datos de contacto, identificadores estables entre eventos y REST, resincronización tras una
 * reconexión y destinatarios autorizados.
 */
describe('Contrato de Seguimiento (#85): REST y Socket.IO sobre PostgreSQL real', () => {
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  let base: string;
  const oldSecret = process.env.JWT_SECRET;
  const oldOrigins = process.env.REALTIME_ALLOWED_ORIGINS;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const sockets: Socket[] = [];
  let ids: Record<string, string>;
  let productId: string;
  const token = (sub: string, role = 'ADMIN') => jwt.sign({ sub, role }, { expiresIn: '1h' });
  const api = (method: 'get' | 'post' | 'patch', path: string, body?: object, sub?: string, role = 'ADMIN') =>
    request(app.getHttpServer())[method]('/api/v1' + path).auth(token(sub ?? ids.admin!, role), { type: 'bearer' }).send(body);
  const capture = (socket: Socket) => {
    const packets: { event: string; payload: any }[] = [];
    for (const event of events) socket.on(event, (payload) => packets.push({ event, payload }));
    return packets;
  };
  const connect = async (value: string) => {
    const socket = io(base + '/realtime', {
      autoConnect: false, forceNew: true, reconnection: false, transports: ['websocket'],
      auth: { token: value }, extraHeaders: { Origin: 'https://fixture.example' },
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
  const order = async () => {
    const created = await db.orm.public.Order.create({
      userId: ids.client!, zoneId: ids.zone!, deliveryAddress: PRIVATE_ADDRESS,
      scheduledDeliveryDate: Temporal.Now.instant(), deliveryLat: -1.25, deliveryLng: -78.62,
    });
    await db.orm.public.OrderItem.create({ orderId: created.id, productId, quantity: 1, price: 10, unitPriceCents: 1000n });
    return created;
  };
  const route = async (orders: { id: string }[]) => {
    const response = await api('post', '/routes', { zoneId: ids.zone, routeDate: Temporal.Now.instant().toString(), orderIds: orders.map((o) => o.id) }).expect(201);
    await api('post', `/routes/${response.body.id}/assign`, { driverId: ids.driver }).expect(200);
    return response.body.id as string;
  };
  const start = (id: string) => api('post', `/routes/${id}/start`, {}, ids.driverUser, 'DRIVER').expect(200);
  const intervene = (body: object, sub?: string, role = 'ADMIN') =>
    api('post', '/dispatch/interventions', { requestId: randomUUID(), reason: PRIVATE_REASON, ...body }, sub, role);
  const adminOrder = async (id: string) => (await api('get', `/orders/${id}`).expect(200)).body;
  const incidentPackets = (packets: { event: string; payload: any }[], action: string) =>
    packets.filter((p) => p.event === 'dispatch.incident.updated' && p.payload.data.action === action);
  const expectNoPrivateData = (packets: { event: string; payload: any }[]) => {
    for (const { payload } of packets) {
      expect(Object.keys(payload).sort()).toEqual(['data', 'eventId', 'occurredAt', 'version']);
      expect(JSON.stringify(payload)).not.toMatch(/privad|fixture\.invalid|private-fixture-credential|\+593|@/i);
      for (const value of Object.values(payload.data)) expect(typeof value === 'string' || typeof value === 'boolean').toBe(true);
    }
  };

  beforeAll(async () => {
    startOwnedContainer();
    const url = createOwnedDatabase('monitor_' + randomUUID().replaceAll('-', '').slice(0, 8));
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    process.env.REALTIME_ALLOWED_ORIGINS = 'https://fixture.example';
    db = postgres<Contract>({ contractJson, url });
    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue({
      client: db, orm: db.orm, sql: db.sql, user: db.orm.public.User, driver: db.orm.public.Driver,
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
    productId = randomUUID();
    await db.orm.public.Product.create({ id: productId, name: 'Producto', description: 'Producto de prueba', price: 10, priceCents: 1000n, sku: 'MON-' + productId.slice(0, 8), stock: 50 });
  });
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.disconnect(); await pause(); });
  afterAll(async () => {
    await app?.close(); await db?.close(); cleanupOwnedResources();
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
    if (oldOrigins === undefined) delete process.env.REALTIME_ALLOWED_ORIGINS; else process.env.REALTIME_ALLOWED_ORIGINS = oldOrigins;
  });

  describe('cancelación de una ruta asignada', () => {
    it('ADMIN distingue la ruta cancelada y los avisos llegan después de persistir, sin motivo ni datos de contacto', async () => {
      const a = await order(); const b = await order(); const r = await route([a, b]);
      const admin = await connect(token(ids.admin!)); const driver = await connect(token(ids.driverUser!, 'DRIVER')); const owner = await connect(token(ids.client!, 'CLIENT'));
      await listen(admin, 'route', r); await listen(admin, 'order', a.id); await listen(admin, 'incidents');
      await listen(driver, 'route', r); await listen(owner, 'order', a.id);
      const [adminP, driverP, ownerP] = [capture(admin), capture(driver), capture(owner)];

      await intervene({ action: 'CANCEL_ROUTE', routeId: r }).expect(200); await pause();

      // El estado persistido ya es el cancelado cuando llegan los avisos.
      const detail = (await api('get', `/routes/${r}`).expect(200)).body;
      expect(detail).toMatchObject({ id: r, status: 'CANCELLED', driverId: ids.driver, cancelledById: ids.admin, cancelReason: PRIVATE_REASON });
      expect(detail.cancelledAt).toEqual(expect.any(String));
      expect(detail.orders.map((o: any) => o.id).sort()).toEqual([a.id, b.id].sort());
      expect(detail.stops.map((s: any) => s.orderId).sort()).toEqual([a.id, b.id].sort());
      const listed = (await api('get', '/routes').expect(200)).body.find((x: any) => x.id === r);
      expect(listed).toMatchObject({ status: 'CANCELLED', cancelledById: ids.admin });

      const routeEvents = adminP.filter((p) => p.event === 'route.updated');
      expect(routeEvents.map((p) => p.payload.data)).toEqual([{ routeId: r, status: 'CANCELLED' }]);
      expect(adminP.filter((p) => p.event === 'order.status.updated' && p.payload.data.orderId === a.id).map((p) => p.payload.data))
        .toEqual([{ orderId: a.id, status: 'PENDING', requiresAdministrativeReview: false }]);
      // Una cancelación previa a la salida no es un incidente: no se publica dispatch.incident.updated (decisión documentada).
      expect(adminP.some((p) => p.event === 'dispatch.incident.updated')).toBe(false);
      expect(driverP.filter((p) => p.event === 'route.updated').map((p) => p.payload.data)).toEqual([{ routeId: r, status: 'CANCELLED' }]);
      expect(ownerP.map((p) => p.event)).toEqual(['order.status.updated']);
      expectNoPrivateData([...adminP, ...driverP, ...ownerP]);

      // El pedido liberado vuelve a PENDING sin ruta; la relación histórica sigue en la ruta cancelada.
      expect(await adminOrder(a.id)).toMatchObject({ status: 'PENDING', routeId: null });
    });

    it('un reenvío exacto no republica y la lectura del repartidor no cambia', async () => {
      const a = await order(); const r = await route([a]);
      const admin = await connect(token(ids.admin!)); await listen(admin, 'route', r);
      const packets = capture(admin);
      const requestId = randomUUID();
      await intervene({ action: 'CANCEL_ROUTE', routeId: r, requestId }).expect(200); await pause();
      const count = packets.length;
      await intervene({ action: 'CANCEL_ROUTE', routeId: r, requestId }).expect(200); await pause();
      expect(packets).toHaveLength(count);
      const mine = (await api('get', '/drivers/me/routes', undefined, ids.driverUser, 'DRIVER').expect(200)).body;
      expect(JSON.stringify(mine)).not.toContain(r);
    });

    it('una cancelación rechazada no publica nada ni cambia la ruta', async () => {
      const a = await order(); const r = await route([a]); await start(r);
      const admin = await connect(token(ids.admin!)); await listen(admin, 'route', r); await listen(admin, 'incidents');
      const packets = capture(admin);
      await intervene({ action: 'CANCEL_ROUTE', routeId: r }).expect(409); await pause();
      expect(packets).toEqual([]);
      expect((await api('get', `/routes/${r}`).expect(200)).body.status).toBe('IN_PROGRESS');
    });
  });

  describe('emergencia e incidentes: identificadores estables entre eventos y REST', () => {
    it('los eventos de emergencia llevan routeId y emergencyId que coinciden con los de la API REST', async () => {
      const a = await order(); const b = await order(); const r = await route([a, b]); await start(r);
      const admin = await connect(token(ids.admin!)); await listen(admin, 'incidents');
      const adminRoute = await connect(token(ids.admin!)); await listen(adminRoute, 'route', r);
      const packets = capture(admin); const routePackets = capture(adminRoute);

      const declared = (await intervene({ action: 'EMERGENCY_DECLARE', routeId: r }).expect(200)).body;
      const emergencyId = declared.result.emergencyId as string;
      await pause();

      // Evento: hint mínimo con los identificadores para enlazar ruta, emergencia (y pedido) sin pedir todo.
      expect(incidentPackets(packets, 'EMERGENCY_DECLARE').map((p) => p.payload.data)).toEqual([{ routeId: r, emergencyId, action: 'EMERGENCY_DECLARE' }]);
      expect(routePackets.filter((p) => p.event === 'route.updated').map((p) => p.payload.data)).toEqual([{ routeId: r, status: 'INTERRUPTED' }]);

      // REST: los mismos identificadores resuelven las relaciones ruta, emergencia, pedido e incidente.
      const emergencies = (await api('get', '/dispatch/emergencies').expect(200)).body;
      expect(emergencies.find((e: any) => e.id === emergencyId)).toMatchObject({ routeId: r, closedAt: null });
      const detail = (await api('get', `/dispatch/routes/${r}/emergency`).expect(200)).body;
      expect(detail).toMatchObject({ id: emergencyId, routeId: r });
      expect(detail.units.map((u: any) => u.orderId).sort()).toEqual([a.id, b.id].sort());
      expect(detail.units.every((u: any) => u.emergencyId === emergencyId && u.routeId === r)).toBe(true);
      const inbox = (await api('get', '/dispatch/inbox').expect(200)).body;
      expect(inbox.interruptedRoutes.find((x: any) => x.routeId === r)).toMatchObject({ emergencyId });
      for (const o of [a, b]) {
        const incident = inbox.incidents.find((i: any) => i.orderId === o.id);
        expect(incident).toMatchObject({ ownership: 'EMERGENCY_CUSTODY', emergencyId });
        expect(incident.emergency).toMatchObject({ emergencyId, routeId: r });
      }
      expect((await api('get', `/routes/${r}`).expect(200)).body.status).toBe('INTERRUPTED');
      expectNoPrivateData([...packets, ...routePackets]);
    });

    it('recuperar una unidad y cerrar la emergencia publican hints con orderId, routeId y emergencyId', async () => {
      const a = await order(); const r = await route([a]); await start(r);
      const admin = await connect(token(ids.admin!)); await listen(admin, 'incidents');
      const packets = capture(admin);
      const emergencyId = (await intervene({ action: 'EMERGENCY_DECLARE', routeId: r }).expect(200)).body.result.emergencyId as string;
      const unit = (await api('get', `/dispatch/routes/${r}/emergency`).expect(200)).body.units[0];
      await intervene({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unit.id }).expect(200); await pause();
      await intervene({ action: 'EMERGENCY_CLOSE', routeId: r }).expect(200); await pause();

      expect(incidentPackets(packets, 'UNIT_RECOVERY_CONFIRM').map((p) => p.payload.data))
        .toEqual([{ orderId: a.id, routeId: r, emergencyId, action: 'UNIT_RECOVERY_CONFIRM', requiresAdministrativeReview: true }]);
      expect(incidentPackets(packets, 'EMERGENCY_CLOSE').map((p) => p.payload.data)).toEqual([{ routeId: r, emergencyId, action: 'EMERGENCY_CLOSE' }]);
      // La emergencia cerrada sigue consultable por REST con su fecha de cierre.
      expect((await api('get', `/dispatch/routes/${r}/emergency`).expect(200)).body).toMatchObject({ id: emergencyId, routeId: r, closedAt: expect.any(String) });
      expectNoPrivateData(packets);
    });

    it('un caso que ya no existe se distingue explícitamente: ruta inexistente y ruta sin emergencia tienen códigos distintos', async () => {
      const a = await order(); const r = await route([a]);
      const missing = await api('get', `/dispatch/routes/${randomUUID()}/emergency`).expect(404);
      expect(missing.body.code).toBe('ROUTE_NOT_FOUND');
      const without = await api('get', `/dispatch/routes/${r}/emergency`).expect(404);
      expect(without.body.code).toBe('ROUTE_EMERGENCY_NOT_FOUND');
      await api('get', `/routes/${randomUUID()}`).expect(404);
    });

    it('un incidente de entrega fallida se enlaza por orderId y routeId y se resuelve al reprogramar: desaparece de la bandeja', async () => {
      const failed = await order(); const ok = await order(); const r = await route([failed, ok]); await start(r);
      const admin = await connect(token(ids.admin!)); await listen(admin, 'incidents');
      const packets = capture(admin);
      const stop = (await api('get', `/routes/${r}`).expect(200)).body.stops.find((s: any) => s.orderId === failed.id);
      await api('post', `/routes/${r}/stops/${stop.id}/failure`, { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Nadie abrió' }, ids.driverUser, 'DRIVER').expect(200); await pause();
      const inbox = (await api('get', '/dispatch/inbox').expect(200)).body;
      const incident = inbox.incidents.find((i: any) => i.orderId === failed.id);
      expect(incident).toMatchObject({ orderId: failed.id, routeId: r, emergencyId: null, ownership: 'FAILED_DELIVERY' });
      expect(packets.some((p) => p.event === 'dispatch.incident.updated' && p.payload.data.orderId === failed.id && p.payload.data.routeId === r)).toBe(true);
      expectNoPrivateData(packets);
    });
  });

  describe('reconexión y destinatarios autorizados', () => {
    it('tras una reconexión, el ADMIN resincroniza con REST (lista de rutas, bandeja y emergencias) sin reenvío de eventos', async () => {
      const a = await order(); const r = await route([a]);
      const first = await connect(token(ids.admin!)); await listen(first, 'route', r); await listen(first, 'incidents');
      const old = capture(first); first.disconnect(); await pause();

      await intervene({ action: 'CANCEL_ROUTE', routeId: r }).expect(200);
      const b = await order(); const r2 = await route([b]); await start(r2);
      await intervene({ action: 'EMERGENCY_DECLARE', routeId: r2 }).expect(200); await pause();
      expect(old).toEqual([]);

      const second = await connect(token(ids.admin!)); await listen(second, 'route', r); await listen(second, 'route', r2); await listen(second, 'incidents');
      const fresh = capture(second); await pause();
      expect(fresh).toEqual([]);
      const routes = (await api('get', '/routes').expect(200)).body;
      expect(routes.find((x: any) => x.id === r).status).toBe('CANCELLED');
      expect(routes.find((x: any) => x.id === r2).status).toBe('INTERRUPTED');
      expect((await api('get', '/dispatch/emergencies').expect(200)).body.some((e: any) => e.routeId === r2)).toBe(true);
      expect((await api('get', '/dispatch/inbox').expect(200)).body.interruptedRoutes.some((x: any) => x.routeId === r2)).toBe(true);
    });

    it('CLIENT y DRIVER ajenos no reciben incidentes ni cancelaciones, y la lectura REST sigue restringida a ADMIN', async () => {
      const a = await order(); const r = await route([a]);
      const outsider = await connect(token(ids.foreignDriverUser!, 'DRIVER')); const stranger = await connect(token(ids.other!, 'CLIENT'));
      for (const socket of [outsider, stranger]) {
        expect(await subscribe(socket, 'incidents')).toMatchObject({ ok: false });
        expect(await subscribe(socket, 'route', r)).toMatchObject({ ok: false });
        expect(await subscribe(socket, 'order', a.id)).toMatchObject({ ok: false });
      }
      const packets = [capture(outsider), capture(stranger)];
      await intervene({ action: 'CANCEL_ROUTE', routeId: r }).expect(200); await pause();
      expect(packets).toEqual([[], []]);
      for (const [sub, role] of [[ids.client!, 'CLIENT'], [ids.driverUser!, 'DRIVER']] as const) {
        await api('get', `/routes/${r}`, undefined, sub, role).expect(403);
        await api('get', '/dispatch/inbox', undefined, sub, role).expect(403);
        await api('get', '/dispatch/emergencies', undefined, sub, role).expect(403);
        await api('get', `/dispatch/routes/${r}/emergency`, undefined, sub, role).expect(403);
      }
    });

    it('el CLIENT dueño y el repartidor asignado reciben solo los avisos de su recurso', async () => {
      const a = await order(); const r = await route([a]); await start(r);
      const owner = await connect(token(ids.client!, 'CLIENT')); const driver = await connect(token(ids.driverUser!, 'DRIVER'));
      await listen(owner, 'order', a.id); await listen(driver, 'route', r);
      const [ownerP, driverP] = [capture(owner), capture(driver)];
      await intervene({ action: 'EMERGENCY_DECLARE', routeId: r }).expect(200); await pause();
      expect(ownerP.every((p) => p.event === 'order.status.updated')).toBe(true);
      expect(driverP.every((p) => p.event === 'route.updated')).toBe(true);
      expect([...ownerP, ...driverP].some((p) => p.event === 'dispatch.incident.updated')).toBe(false);
      expectNoPrivateData([...ownerP, ...driverP]);
    });
  });
});
