import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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
 * Issue #50: retiro en tienda acordado, sobre PostgreSQL real (contenedor propio) y JWT reales.
 * Todo el flujo pasa por la API pública: entrega fallida del repartidor → gestión del ADMIN (acuerdo o rechazo del
 * retiro) → confirmación del retiro físico → seguimiento que ve el cliente.
 */
describe('Retiro en tienda acordado (#50): PostgreSQL + JWT HTTP', () => {
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const ids = {
    admin: randomUUID(),
    admin2: randomUUID(),
    client: randomUUID(),
    otherClient: randomUUID(),
    driverUser: randomUUID(),
    driver: randomUUID(),
    zone: randomUUID(),
  };
  const token = (sub: string, role: string) => jwt.sign({ sub, role, email: 'fixture@invalid.test' });
  const api = (method: 'get' | 'post', path: string, body?: object, sub = ids.admin, role = 'ADMIN') =>
    request(app.getHttpServer())[method]('/api/v1' + path).auth(token(sub, role), { type: 'bearer' }).send(body);
  const asDriver = (path: string, body: object = {}) => api('post', path, body, ids.driverUser, 'DRIVER');
  const intervene = (body: Record<string, unknown>, sub = ids.admin, role = 'ADMIN') =>
    api('post', '/dispatch/interventions', { requestId: randomUUID(), reason: 'Gestión de retiro en tienda', ...body }, sub, role);
  const tracking = async (orderId: string, sub = ids.client) =>
    (await api('get', `/shop/orders/${orderId}`, undefined, sub, 'CLIENT').expect(200)).body;
  const listed = async (orderId: string) => {
    const res = await api('get', '/shop/orders?pageSize=50', undefined, ids.client, 'CLIENT').expect(200);
    return res.body.items.find((item: any) => item.id === orderId);
  };
  const inboxIncident = async (orderId: string) =>
    (await api('get', '/dispatch/inbox').expect(200)).body.incidents.find((i: any) => i.orderId === orderId);
  const count = async (model: 'Route' | 'OrderPickup' | 'PurchaseReceipt' | 'PaymentAttempt') => (await db.orm.public[model].all()).length;
  const pickupsOf = (orderId: string) => db.orm.public.OrderPickup.where({ orderId }).all();
  const today = () => Temporal.Now.instant();

  const seedOrder = async () =>
    db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      deliveryAddress: 'Fixture street',
      scheduledDeliveryDate: today(),
      deliveryLat: -1.25,
      deliveryLng: -78.62,
    });
  const makeRoute = async (count = 1) => {
    const orders = [];
    for (let i = 0; i < count; i++) orders.push(await seedOrder());
    const route = (await api('post', '/routes', { zoneId: ids.zone, routeDate: today().toString(), orderIds: orders.map((o) => o.id) }).expect(201)).body;
    return { route, orders };
  };
  const assign = (routeId: string) => api('post', `/routes/${routeId}/assign`, { driverId: ids.driver });
  /** Ruta con un pedido cuya entrega falla y termina: el pedido queda pendiente de gestión del ADMIN. */
  const failedDelivery = async () => {
    const { route, orders } = await makeRoute(1);
    await assign(route.id).expect(200);
    await asDriver(`/routes/${route.id}/start`).expect(200);
    const stop = (await api('get', `/routes/${route.id}`).expect(200)).body.stops[0];
    await asDriver(`/routes/${route.id}/stops/${stop.id}/failure`, { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Sin contexto adicional' }).expect(200);
    const attemptId = (await api('get', `/routes/${route.id}`).expect(200)).body.stops[0].attempts[0].id;
    return { route, orderId: orders[0]!.id, attemptId, stopId: stop.id };
  };

  beforeAll(async () => {
    startOwnedContainer();
    const url = createOwnedDatabase('pickup_' + randomUUID().replaceAll('-', '').slice(0, 8));
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    db = postgres<Contract>({ contractJson, url });
    for (const [id, role] of [
      [ids.admin, 'ADMIN'],
      [ids.admin2, 'ADMIN'],
      [ids.client, 'CLIENT'],
      [ids.otherClient, 'CLIENT'],
    ] as const) {
      await db.orm.public.User.create({ id, role, name: role, email: id + '@fixture.invalid', password: 'not-a-real-password' });
    }
    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const prisma = {
      client: db, orm: db.orm, sql: db.sql,
      user: db.orm.public.User, driver: db.orm.public.Driver, zone: db.orm.public.Zone, order: db.orm.public.Order,
      orderItem: db.orm.public.OrderItem, product: db.orm.public.Product, route: db.orm.public.Route,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(prisma).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  beforeEach(async () => {
    ids.zone = randomUUID();
    ids.driver = randomUUID();
    ids.driverUser = randomUUID();
    await db.orm.public.User.create({ id: ids.driverUser, role: 'DRIVER', name: 'Driver', email: ids.driverUser + '@fixture.invalid', password: 'fixture' });
    await db.orm.public.Driver.create({ id: ids.driver, userId: ids.driverUser, vehicle: 'fixture' });
    await db.orm.public.Zone.create({ id: ids.zone, code: ids.zone, name: ids.zone, depotLat: -1.24, depotLng: -78.61 });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    cleanupOwnedResources();
  });

  describe('entrega fallida → pendiente de gestión → retiro', () => {
    it('tras la entrega fallida el pedido espera una gestión del ADMIN: el cliente lo ve pendiente de gestión y no hay retiro', async () => {
      const { orderId } = await failedDelivery();
      expect(await tracking(orderId)).toMatchObject({ pendingManagement: true, pickup: null, status: 'ASSIGNED' });
      expect(await listed(orderId)).toMatchObject({ pendingManagement: true, pickup: null });
      expect((await inboxIncident(orderId)).pickup).toBeNull();
    });

    it('si el cliente no acepta el retiro: no se entrega, no se crea ruta, sigue pendiente de gestión y admite otra alternativa', async () => {
      const { route, orderId, attemptId } = await failedDelivery();
      const routes = await count('Route');

      const declined = (await intervene({ action: 'PICKUP_DECLINE', orderId, attemptId }).expect(200)).body;

      expect(declined).toMatchObject({ action: 'PICKUP_DECLINE', outcome: 'APPLIED', actorId: ids.admin, orderId });
      expect(await pickupsOf(orderId)).toHaveLength(0);
      expect(await count('Route')).toBe(routes); // el rechazo no crea una ruta
      expect(await tracking(orderId)).toMatchObject({ pendingManagement: true, pickup: null, status: 'ASSIGNED' });
      // Otra alternativa acordada después: con la ruta ya terminada, ahora sí acepta el retiro.
      await asDriver(`/routes/${route.id}/complete`).expect(200);
      await intervene({ action: 'PICKUP_AGREE', orderId, attemptId }).expect(200);
      expect(await pickupsOf(orderId)).toHaveLength(1);
    });

    it('acordar el retiro deja el pedido pendiente de retiro sin otra ruta y sin entregarlo; el planificador lo ignora', async () => {
      const { route, orderId, attemptId } = await failedDelivery();
      await asDriver(`/routes/${route.id}/complete`).expect(200);
      const routes = await count('Route');

      const agreed = (await intervene({ action: 'PICKUP_AGREE', orderId, attemptId }).expect(200)).body;

      expect(agreed).toMatchObject({ action: 'PICKUP_AGREE', outcome: 'APPLIED', actorId: ids.admin });
      expect(await count('Route')).toBe(routes);
      const order = (await api('get', `/orders/${orderId}`).expect(200)).body;
      expect(order.status).toBe('PENDING'); // el acuerdo no es una entrega
      expect(order.pickup).toMatchObject({ state: 'PENDING_PICKUP', pickedUpAt: null });
      expect(order.pickup.agreedAt).toEqual(expect.any(String));
      const adminListBefore = (await api('get', '/orders?pageSize=50').expect(200)).body.items.find((o: any) => o.id === orderId);
      expect(adminListBefore?.pickup).toMatchObject({ state: 'PENDING_PICKUP', pickedUpAt: null });
      const view = await tracking(orderId);
      expect(view).toMatchObject({ pendingManagement: false, status: 'PENDING', pickup: { state: 'PENDING_PICKUP', pickedUpAt: null } });
      expect(view.pickup.agreedAt).toEqual(expect.any(String));
      expect(view.timeline.map((t: any) => t.code)).toEqual(expect.arrayContaining(['PICKUP_AGREED']));
      expect(view.timeline.find((t: any) => t.code === 'PICKUP_AGREED').label).toBe('Pendiente de retiro en tienda');
      expect(view.timeline.map((t: any) => t.code)).not.toContain('PICKED_UP');
      expect((await inboxIncident(orderId)).pickup).toMatchObject({ state: 'PENDING_PICKUP', pickedUpAt: null });
      // No se vuelve a planificar ni a reservar: sigue excluido de las propuestas de ruta y no se puede armar una ruta con él.
      const proposals = (await api('get', `/route-proposals?date=${today().toZonedDateTimeISO('America/Guayaquil').toPlainDate()}`).expect(200)).body;
      expect(proposals.excluded.find((e: any) => e.orderId === orderId)?.reasons).toContain('ADMINISTRATIVE_REVIEW_REQUIRED');
      expect(proposals.proposals.flatMap((p: any) => p.orderIds)).not.toContain(orderId);
      const attempt = await api('post', '/routes', { zoneId: ids.zone, routeDate: today().toString(), orderIds: [orderId] });
      expect(attempt.status).not.toBe(201);
      expect(await count('Route')).toBe(routes);
    });

    it('el acuerdo y el retiro son dos eventos: solo la confirmación entrega el pedido, con actor y momento, y queda indicado el retiro', async () => {
      const { route, orderId, attemptId } = await failedDelivery();
      await asDriver(`/routes/${route.id}/complete`).expect(200);
      await intervene({ action: 'PICKUP_AGREE', orderId, attemptId }).expect(200);
      expect((await api('get', `/orders/${orderId}`).expect(200)).body.status).not.toBe('DELIVERED');

      const body = { action: 'PICKUP_CONFIRM', orderId, requestId: randomUUID() };
      const confirmed = (await intervene(body, ids.admin2).expect(200)).body;

      expect(confirmed).toMatchObject({ action: 'PICKUP_CONFIRM', outcome: 'APPLIED', actorId: ids.admin2 });
      const deliveredOrder = (await api('get', `/orders/${orderId}`).expect(200)).body;
      expect(deliveredOrder.status).toBe('DELIVERED');
      expect(deliveredOrder.pickup).toMatchObject({ state: 'PICKED_UP' });
      expect(deliveredOrder.pickup.pickedUpAt).toEqual(expect.any(String));
      const adminListAfter = (await api('get', '/orders?pageSize=50').expect(200)).body.items.find((o: any) => o.id === orderId);
      expect(adminListAfter?.pickup).toMatchObject({ state: 'PICKED_UP' });
      const pickup = await db.orm.public.OrderPickup.where({ orderId }).first();
      expect(pickup).toMatchObject({ agreedById: ids.admin, confirmedById: ids.admin2 });
      expect(pickup!.confirmedAt).toBeTruthy();
      const view = await tracking(orderId);
      expect(view).toMatchObject({ status: 'DELIVERED', pendingManagement: false, pickup: { state: 'PICKED_UP' } });
      expect(view.pickup.pickedUpAt).toEqual(expect.any(String));
      expect(view.timeline.map((t: any) => t.code)).toEqual(expect.arrayContaining(['PICKUP_AGREED', 'PICKED_UP']));
      expect(view.timeline.find((t: any) => t.code === 'PICKED_UP').label).toBe('Entregado: retirado en tienda');
      expect((await inboxIncident(orderId))?.pickup ?? null).toBeNull(); // un pedido entregado deja la bandeja de incidencias

      // Doble confirmación: el reintento con la misma clave es el mismo evento; una clave nueva ya no tiene nada que confirmar.
      expect((await intervene(body, ids.admin2).expect(200)).body).toEqual(confirmed);
      await intervene({ action: 'PICKUP_CONFIRM', orderId }).expect(409);
      expect((await api('get', '/dispatch/audit').expect(200)).body.filter((a: any) => a.action === 'PICKUP_CONFIRM')).toHaveLength(1);
    });

    it('no se confirma un retiro que no se acordó ni se acuerda dos veces; un pedido sin fallo no admite attemptId', async () => {
      const { route, orderId, attemptId } = await failedDelivery();
      await intervene({ action: 'PICKUP_CONFIRM', orderId }).expect(409);
      await intervene({ action: 'PICKUP_AGREE', orderId }).expect(409); // falta el último intento fallido
      await intervene({ action: 'PICKUP_AGREE', orderId, attemptId: randomUUID() }).expect(409);
      await asDriver(`/routes/${route.id}/complete`).expect(200);
      await intervene({ action: 'PICKUP_AGREE', orderId, attemptId }).expect(200);
      await intervene({ action: 'PICKUP_AGREE', orderId, attemptId }).expect(409);
      await intervene({ action: 'PICKUP_DECLINE', orderId, attemptId }).expect(409);
      expect(await pickupsOf(orderId)).toHaveLength(1);

      const fresh = await seedOrder();
      await intervene({ action: 'PICKUP_AGREE', orderId: fresh.id, attemptId: randomUUID() }).expect(409);
      expect(await pickupsOf(fresh.id)).toHaveLength(0);
    });

    it('una ruta ya iniciada no pierde paradas: con la entrega fallida pero la ruta aún en curso el acuerdo se rechaza sin cambios', async () => {
      const { route, orderId, attemptId } = await failedDelivery(); // la ruta sigue en curso
      const stopsBefore = (await api('get', `/routes/${route.id}`).expect(200)).body.stops;
      const audits = (await api('get', '/dispatch/audit').expect(200)).body.length;

      await intervene({ action: 'PICKUP_AGREE', orderId, attemptId }).expect(409);

      expect(await pickupsOf(orderId)).toHaveLength(0);
      expect((await api('get', `/routes/${route.id}`).expect(200)).body.stops).toEqual(stopsBefore);
      expect((await api('get', '/dispatch/audit').expect(200)).body).toHaveLength(audits);
      expect((await db.orm.public.Order.where({ id: orderId }).first())!.requiresAdministrativeReview).toBe(true);
    });
  });

  describe('pedidos con reservas operativas', () => {
    it('en una ruta DRAFT, el pedido suelta su reserva y su parada y los demás pedidos de la ruta no cambian', async () => {
      const { route, orders } = await makeRoute(2);
      const [target, other] = [orders[0]!.id, orders[1]!.id];

      await intervene({ action: 'PICKUP_AGREE', orderId: target }).expect(200);

      const stops = (await api('get', `/routes/${route.id}`).expect(200)).body.stops;
      expect(stops.map((s: any) => s.orderId)).toEqual([other]);
      const claims = await db.orm.public.OrderClaim.where({ routeId: route.id }).all();
      expect(claims.find((c) => c.orderId === target)!.releasedAt).not.toBeNull();
      expect(claims.find((c) => c.orderId === other)!.releasedAt).toBeNull();
      expect(await tracking(target)).toMatchObject({ pickup: { state: 'PENDING_PICKUP' } });
      expect(await db.orm.public.OrderPickup.where({ orderId: other }).first()).toBeNull();
    });

    it('en una ruta ASSIGNED aún no iniciada ocurre lo mismo y el repartidor conserva su reserva por los demás pedidos', async () => {
      const { route, orders } = await makeRoute(2);
      await assign(route.id).expect(200);

      await intervene({ action: 'PICKUP_AGREE', orderId: orders[0]!.id }).expect(200);

      const stops = (await api('get', `/routes/${route.id}`).expect(200)).body.stops;
      expect(stops.map((s: any) => s.orderId)).toEqual([orders[1]!.id]);
      expect((await db.orm.public.Route.where({ id: route.id }).first())!.status).toBe('ASSIGNED');
      expect(await db.orm.public.DriverReservation.where({ routeId: route.id, releasedAt: null }).all()).toHaveLength(1);
      expect((await api('get', `/orders/${orders[0]!.id}`).expect(200)).body).toMatchObject({ status: 'PENDING', routeId: null });
    });

    it('no vacía una ruta reservada: con una sola parada se rechaza y la ruta y la reserva quedan intactas', async () => {
      const { route, orders } = await makeRoute(1);
      await assign(route.id).expect(200);
      const before = (await api('get', `/routes/${route.id}`).expect(200)).body;

      await intervene({ action: 'PICKUP_AGREE', orderId: orders[0]!.id }).expect(409);

      expect((await api('get', `/routes/${route.id}`).expect(200)).body).toEqual(before);
      expect(await pickupsOf(orders[0]!.id)).toHaveLength(0);
    });

    it('en una ruta ya iniciada se rechaza y no se borra ninguna parada', async () => {
      const { route, orders } = await makeRoute(2);
      await assign(route.id).expect(200);
      await asDriver(`/routes/${route.id}/start`).expect(200);
      const before = (await api('get', `/routes/${route.id}`).expect(200)).body;

      await intervene({ action: 'PICKUP_AGREE', orderId: orders[0]!.id }).expect(409);

      expect((await api('get', `/routes/${route.id}`).expect(200)).body).toEqual(before);
      expect(await pickupsOf(orders[0]!.id)).toHaveLength(0);
    });
  });

  describe('dinero, inventario y permisos', () => {
    it('ni el acuerdo ni el retiro reponen stock, emiten reembolsos ni crean compras o comprobantes', async () => {
      const product = await db.orm.public.Product.create({ name: 'Regalo de prueba', price: 10, stock: 5 });
      const { route, orders } = await makeRoute(2);
      await db.orm.public.OrderItem.create({ orderId: orders[0]!.id, productId: product.id, quantity: 2, price: 10 });
      const receipts = await count('PurchaseReceipt');
      const payments = await count('PaymentAttempt');

      await intervene({ action: 'PICKUP_AGREE', orderId: orders[0]!.id }).expect(200);
      await intervene({ action: 'PICKUP_CONFIRM', orderId: orders[0]!.id }).expect(200);

      expect((await db.orm.public.Product.where({ id: product.id }).first())!.stock).toBe(5);
      expect(await count('PurchaseReceipt')).toBe(receipts);
      expect(await count('PaymentAttempt')).toBe(payments);
      expect((await db.orm.public.OrderItem.where({ orderId: orders[0]!.id }).all())).toHaveLength(1); // la compra se conserva
      expect(route.id).toBeTruthy();
    });

    it('solo un ADMIN gestiona el retiro; un CLIENT, un DRIVER o un token falsificado se rechazan sin cambios', async () => {
      const { orders } = await makeRoute(2);
      const orderId = orders[0]!.id;
      await intervene({ action: 'PICKUP_AGREE', orderId }, ids.client, 'CLIENT').expect(403);
      await intervene({ action: 'PICKUP_AGREE', orderId }, ids.driverUser, 'DRIVER').expect(403);
      await request(app.getHttpServer()).post('/api/v1/dispatch/interventions').send({ requestId: randomUUID(), reason: 'x', action: 'PICKUP_AGREE', orderId }).expect(401);
      await intervene({ action: 'PICKUP_AGREE', orderId, actorId: ids.admin }).expect(400); // el actor sale del JWT, nunca del cuerpo
      await intervene({ action: 'PICKUP_CONFIRM', orderId, attemptId: randomUUID() }).expect(400); // campos exactos de la acción
      expect(await pickupsOf(orderId)).toHaveLength(0);
    });

    it('el cliente ve solo el seguimiento de sus pedidos: otro cliente no ve el retiro ajeno', async () => {
      const { orders } = await makeRoute(2);
      const orderId = orders[0]!.id;
      await intervene({ action: 'PICKUP_AGREE', orderId }).expect(200);
      expect(await tracking(orderId)).toMatchObject({ pickup: { state: 'PENDING_PICKUP' } });
      await api('get', `/shop/orders/${orderId}`, undefined, ids.otherClient, 'CLIENT').expect(404);
      const other = await api('get', '/shop/orders?pageSize=50', undefined, ids.otherClient, 'CLIENT').expect(200);
      expect(other.body.items).toEqual([]);
    });

    it('la base de datos impide un retiro con una confirmación incompleta y más de un retiro por pedido', async () => {
      const { orders } = await makeRoute(2);
      const orderId = orders[0]!.id;
      await intervene({ action: 'PICKUP_AGREE', orderId }).expect(200);
      await expect(db.orm.public.OrderPickup.where({ orderId }).update({ confirmedAt: today() })).rejects.toThrow(); // faltan quién y la clave
      await expect(
        db.orm.public.OrderPickup.create({ orderId, agreedAt: today(), agreedById: ids.admin, agreementRequestId: randomUUID() }),
      ).rejects.toThrow(); // un solo retiro por pedido
      expect((await db.orm.public.OrderPickup.where({ orderId }).first())!.confirmedAt).toBeNull();
    });

    it('el historial de intervenciones registra cada evento de retiro con su actor', async () => {
      const { orders } = await makeRoute(2);
      const orderId = orders[0]!.id;
      await intervene({ action: 'PICKUP_DECLINE', orderId }).expect(200);
      await intervene({ action: 'PICKUP_AGREE', orderId }).expect(200);
      await intervene({ action: 'PICKUP_CONFIRM', orderId }, ids.admin2).expect(200);
      const audit = (await api('get', '/dispatch/audit').expect(200)).body.filter((a: any) => a.orderId === orderId);
      expect(audit.map((a: any) => [a.action, a.actorId]).sort()).toEqual(
        [['PICKUP_AGREE', ids.admin], ['PICKUP_CONFIRM', ids.admin2], ['PICKUP_DECLINE', ids.admin]].sort(),
      );
    });
  });
});
