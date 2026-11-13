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
 * Issue #52: pérdida de una unidad, reemplazo y recuperación tardía del original, sobre PostgreSQL real (contenedor
 * propio) y JWT reales. Todo pasa por la API pública de despacho; el stock se lee de la base de datos.
 */
describe('Pérdida, reemplazo y recuperación tardía (#52): PostgreSQL + JWT HTTP', () => {
  let app: INestApplication;
  let db: ReturnType<typeof postgres<Contract>>;
  const secret = randomUUID();
  const jwt = new JwtService({ secret });
  const ids = {
    admin: randomUUID(),
    admin2: randomUUID(),
    client: randomUUID(),
    driverUser: randomUUID(),
    zone: randomUUID(),
  };
  const token = (sub: string, role: string) => jwt.sign({ sub, role, email: 'fixture@invalid.test' });
  const api = (method: 'get' | 'post', path: string, body?: object, sub: string = ids.admin, role = 'ADMIN') =>
    request(app.getHttpServer())[method]('/api/v1' + path).auth(token(sub, role), { type: 'bearer' }).send(body);
  const intervene = (body: Record<string, unknown>, sub = ids.admin, role = 'ADMIN') =>
    api('post', '/dispatch/interventions', { requestId: randomUUID(), reason: 'Pérdida de un producto', ...body }, sub, role);
  const losses = async (orderId: string) => (await api('get', `/dispatch/orders/${orderId}/losses`).expect(200)).body;
  const stockOf = async (productId: string) => (await db.orm.public.Product.where({ id: productId }).first())!.stock;
  const movementsOf = (productId: string) => db.orm.public.ProductStockMovement.where({ productId }).all();
  const lossesIn = (orderId: string) => db.orm.public.OrderItemLoss.where({ orderId }).all();
  const auditsOf = (orderId: string) => db.orm.public.DispatchIntervention.where({ orderId }).all();
  const counts = async () => ({
    orders: (await db.orm.public.Order.all()).length,
    receipts: (await db.orm.public.PurchaseReceipt.all()).length,
    payments: (await db.orm.public.PaymentAttempt.all()).length,
  });

  /** Producto con `stock` unidades libres (las de la compra original ya están descontadas). */
  const seedProduct = (stock: number) =>
    db.orm.public.Product.create({ name: 'Ramo ' + randomUUID().slice(0, 8), price: 10, stock });
  /** Pedido con un ítem de `quantity` unidades del producto. */
  const seedOrder = async (productId: string, quantity = 1, status: 'PENDING' | 'DELIVERED' = 'PENDING') => {
    const order = await db.orm.public.Order.create({
      userId: ids.client,
      zoneId: ids.zone,
      deliveryAddress: 'Fixture street',
      status,
      deliveryLat: -1.25,
      deliveryLng: -78.62,
    });
    const item = await db.orm.public.OrderItem.create({ orderId: order.id, productId, quantity, price: 10 });
    return { order, item };
  };
  const declare = (orderId: string, orderItemId: string, extra: Record<string, unknown> = {}) =>
    intervene({ action: 'LOSS_DECLARE', orderId, orderItemId, ...extra });
  const prepare = (lossId: string, requestId = randomUUID()) =>
    api('post', '/dispatch/interventions', { requestId, reason: 'Preparar reemplazo', action: 'REPLACEMENT_PREPARE', lossId });
  const recover = (lossId: string, recoveryCondition: string, sub = ids.admin) =>
    intervene({ action: 'ORIGINAL_RECOVER', lossId, recoveryCondition }, sub);

  beforeAll(async () => {
    startOwnedContainer();
    const url = createOwnedDatabase('loss_' + randomUUID().replaceAll('-', '').slice(0, 8));
    runPrismaMigrate(url);
    process.env.JWT_SECRET = secret;
    db = postgres<Contract>({ contractJson, url });
    for (const [id, role] of [
      [ids.admin, 'ADMIN'],
      [ids.admin2, 'ADMIN'],
      [ids.client, 'CLIENT'],
      [ids.driverUser, 'DRIVER'],
    ] as const) {
      await db.orm.public.User.create({ id, role, name: role, email: id + '@fixture.invalid', password: 'not-a-real-password' });
    }
    await db.orm.public.Zone.create({ id: ids.zone, code: ids.zone, name: ids.zone, depotLat: -1.24, depotLng: -78.61 });
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

  afterAll(async () => {
    await app?.close();
    await db?.close();
    cleanupOwnedResources();
  });

  describe('pérdida con reemplazo', () => {
    it('con 2 unidades libres, el reemplazo consume 1 y deja 1; el pedido, las compras, los cobros y los comprobantes no cambian', async () => {
      const product = await seedProduct(2);
      const { order, item } = await seedOrder(product.id);
      const before = await counts();
      const res = await declare(order.id, item.id).expect(200);
      expect(res.body).toMatchObject({ action: 'LOSS_DECLARE', outcome: 'APPLIED', orderId: order.id });
      expect(res.body.result).toMatchObject({ replacement: 'PREPARED', stock: '1' });
      expect(await stockOf(product.id)).toBe(1);
      expect(await movementsOf(product.id)).toHaveLength(1);
      expect(await movementsOf(product.id)).toEqual([expect.objectContaining({ kind: 'REPLACEMENT_OUT', delta: -1, stockAfter: 1, createdById: ids.admin })]);
      expect(await counts()).toEqual(before);
      expect(await db.orm.public.Order.where({ id: order.id }).first()).toMatchObject({ status: 'PENDING', routeId: null });
      expect(await losses(order.id)).toEqual([
        expect.objectContaining({
          unitNumber: 1,
          replacement: expect.objectContaining({ state: 'PREPARED', preparedById: ids.admin }),
          original: expect.objectContaining({ state: 'LOST', condition: null }),
        }),
      ]);
    });

    it('con existencia libre 0, la pérdida no vuelve el stock positivo ni habilita la salida: el reemplazo queda pendiente', async () => {
      const product = await seedProduct(0);
      const { order, item } = await seedOrder(product.id);
      const res = await declare(order.id, item.id).expect(200);
      expect(res.body.result).toMatchObject({ replacement: 'PENDING', stock: '0' });
      expect(await stockOf(product.id)).toBe(0);
      expect(await movementsOf(product.id)).toHaveLength(0);
      const [loss] = await losses(order.id);
      expect(loss.replacement).toMatchObject({ state: 'PENDING', preparedAt: null });
    });

    it('un reemplazo pendiente se rechaza mientras no haya existencia y no deja cambios; con existencia se prepara una sola vez', async () => {
      const product = await seedProduct(0);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      const audits = (await auditsOf(order.id)).length;
      const rejected = await prepare(lossId).expect(409);
      expect(rejected.body.code).toBe('NO_FREE_STOCK');
      expect(await stockOf(product.id)).toBe(0);
      expect((await auditsOf(order.id)).length).toBe(audits);
      expect((await losses(order.id))[0].replacement.state).toBe('PENDING');

      await db.orm.public.Product.where({ id: product.id }).update({ stock: 1 });
      const ok = await prepare(lossId).expect(200);
      expect(ok.body.result).toMatchObject({ replacement: 'PREPARED', stock: '0' });
      expect(await stockOf(product.id)).toBe(0);
      expect(await movementsOf(product.id)).toHaveLength(1);
      expect((await prepare(lossId).expect(409)).body.code).toBe('REPLACEMENT_ALREADY_PREPARED');
      expect(await stockOf(product.id)).toBe(0);
    });
  });

  describe('repetición y concurrencia', () => {
    it('la misma petición repetida devuelve la misma respuesta y descuenta una sola vez', async () => {
      const product = await seedProduct(3);
      const { order, item } = await seedOrder(product.id);
      const body = { requestId: randomUUID(), reason: 'Pérdida de un producto', action: 'LOSS_DECLARE', orderId: order.id, orderItemId: item.id };
      const first = await api('post', '/dispatch/interventions', body).expect(200);
      const second = await api('post', '/dispatch/interventions', body).expect(200);
      expect(second.body).toEqual(first.body);
      expect(await stockOf(product.id)).toBe(2);
      expect(await lossesIn(order.id)).toHaveLength(1);
    });

    it('la clave repetida con otro cuerpo se rechaza sin cambios', async () => {
      const product = await seedProduct(3);
      const { order, item } = await seedOrder(product.id, 2);
      const requestId = randomUUID();
      await api('post', '/dispatch/interventions', { requestId, reason: 'Pérdida', action: 'LOSS_DECLARE', orderId: order.id, orderItemId: item.id, unitNumber: 1 }).expect(200);
      await api('post', '/dispatch/interventions', { requestId, reason: 'Pérdida', action: 'LOSS_DECLARE', orderId: order.id, orderItemId: item.id, unitNumber: 2 }).expect(409);
      expect(await stockOf(product.id)).toBe(2);
      expect(await lossesIn(order.id)).toHaveLength(1);
    });

    it('declarar otra vez la misma unidad con otra clave se rechaza y no descuenta de nuevo', async () => {
      const product = await seedProduct(3);
      const { order, item } = await seedOrder(product.id);
      await declare(order.id, item.id).expect(200);
      const again = await declare(order.id, item.id).expect(409);
      expect(again.body.code).toBe('LOSS_ALREADY_DECLARED');
      expect(await stockOf(product.id)).toBe(2);
      expect(await movementsOf(product.id)).toHaveLength(1);
    });

    it('cinco administradores declarando a la vez la misma unidad: una sola pérdida y un solo descuento', async () => {
      const product = await seedProduct(5);
      const { order, item } = await seedOrder(product.id);
      const responses = await Promise.all(
        [ids.admin, ids.admin2, ids.admin, ids.admin2, ids.admin].map((sub) =>
          api('post', '/dispatch/interventions', { requestId: randomUUID(), reason: 'Pérdida', action: 'LOSS_DECLARE', orderId: order.id, orderItemId: item.id }, sub),
        ),
      );
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await lossesIn(order.id)).toHaveLength(1);
      expect(await stockOf(product.id)).toBe(4);
      expect(await movementsOf(product.id)).toHaveLength(1);
    });

    it('con una sola unidad libre y dos pérdidas a la vez de pedidos distintos, solo una se prepara y el stock nunca es negativo', async () => {
      const product = await seedProduct(1);
      const a = await seedOrder(product.id);
      const b = await seedOrder(product.id);
      const responses = await Promise.all([declare(a.order.id, a.item.id), declare(b.order.id, b.item.id)]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const states = responses.map((r) => r.body.result.replacement).sort();
      expect(states).toEqual(['PENDING', 'PREPARED']);
      expect(await stockOf(product.id)).toBe(0);
      expect(await movementsOf(product.id)).toHaveLength(1);
    });

    it('preparar a la vez el reemplazo de la misma pérdida: un solo descuento', async () => {
      const product = await seedProduct(0);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      await db.orm.public.Product.where({ id: product.id }).update({ stock: 3 });
      const responses = await Promise.all([prepare(lossId), prepare(lossId), prepare(lossId), prepare(lossId)]);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(3);
      expect(await stockOf(product.id)).toBe(2);
      expect(await movementsOf(product.id)).toHaveLength(1);
    });

    it('una venta concurrente y un reemplazo disputan la última unidad: exactamente una se queda con ella', async () => {
      const product = await seedProduct(1);
      const { order, item } = await seedOrder(product.id);
      const [loss, sale] = await Promise.all([
        declare(order.id, item.id),
        api('post', '/orders', { zoneId: ids.zone, deliveryAddress: 'Client address', items: [{ productId: product.id, quantity: 1 }] }, ids.client, 'CLIENT'),
      ]);
      expect(loss.status).toBe(200);
      const sold = sale.status === 201;
      expect(await stockOf(product.id)).toBe(0);
      expect(loss.body.result.replacement).toBe(sold ? 'PENDING' : 'PREPARED');
      expect((await movementsOf(product.id)).length).toBe(sold ? 0 : 1);
    });
  });

  describe('recuperación tardía del original', () => {
    it('ejemplo del enunciado: 2 libres → reemplazo deja 1 → la recuperación vendible suma 1 y deja 2, sin descontar la compra otra vez', async () => {
      const product = await seedProduct(2);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      expect(await stockOf(product.id)).toBe(1);
      const res = await recover(lossId, 'SELLABLE').expect(200);
      expect(res.body.result).toMatchObject({ recovery: 'SELLABLE', stock: '2' });
      expect(await stockOf(product.id)).toBe(2);
      expect((await movementsOf(product.id)).map((m) => m.kind).sort()).toEqual(['RECOVERY_IN', 'REPLACEMENT_OUT']);
      expect(await db.orm.public.Order.where({ id: order.id }).first()).toMatchObject({ status: 'PENDING' });
    });

    it('un original vendible confirmado dos veces nunca suma una unidad extra', async () => {
      const product = await seedProduct(2);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      await recover(lossId, 'SELLABLE').expect(200);
      const again = await recover(lossId, 'SELLABLE', ids.admin2).expect(409);
      expect(again.body.code).toBe('ORIGINAL_ALREADY_RECOVERED');
      expect(await stockOf(product.id)).toBe(2);
    });

    it('un original dañado se registra sin aumentar el stock y no se puede reclasificar como vendible después', async () => {
      const product = await seedProduct(2);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      const res = await recover(lossId, 'DAMAGED').expect(200);
      expect(res.body.result).toMatchObject({ recovery: 'DAMAGED', stock: null });
      expect(await stockOf(product.id)).toBe(1);
      expect(await movementsOf(product.id)).toHaveLength(1);
      await recover(lossId, 'SELLABLE').expect(409);
      await recover(lossId, 'DAMAGED').expect(409);
      expect(await stockOf(product.id)).toBe(1);
      expect((await losses(order.id))[0].original).toMatchObject({ state: 'RECOVERED', condition: 'DAMAGED', recoveredById: ids.admin });
    });

    it('cuatro confirmaciones simultáneas de un original vendible: una sola suma', async () => {
      const product = await seedProduct(2);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      const responses = await Promise.all([recover(lossId, 'SELLABLE'), recover(lossId, 'SELLABLE', ids.admin2), recover(lossId, 'SELLABLE'), recover(lossId, 'SELLABLE', ids.admin2)]);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await stockOf(product.id)).toBe(2);
      expect((await movementsOf(product.id)).filter((m) => m.kind === 'RECOVERY_IN')).toHaveLength(1);
    });

    it('la recuperación no abre otra entrega ni modifica el pedido y el reemplazo pendiente sigue separado del original', async () => {
      const product = await seedProduct(0);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      const routes = (await db.orm.public.Route.all()).length;
      const orderBefore = await db.orm.public.Order.where({ id: order.id }).first();
      await recover(lossId, 'SELLABLE').expect(200);
      expect((await db.orm.public.Route.all()).length).toBe(routes);
      expect(await db.orm.public.Order.where({ id: order.id }).first()).toEqual(orderBefore);
      expect((await losses(order.id))[0]).toMatchObject({
        replacement: { state: 'PENDING' },
        original: { state: 'RECOVERED', condition: 'SELLABLE' },
      });
      // el original recuperado ya está en el stock libre: ahora sí se puede preparar el reemplazo
      expect(await stockOf(product.id)).toBe(1);
      await prepare(lossId).expect(200);
      expect(await stockOf(product.id)).toBe(0);
    });
  });

  describe('unidades, validaciones y permisos', () => {
    it('en un ítem con varias unidades se exige indicar cuál se perdió y cada unidad es independiente', async () => {
      const product = await seedProduct(5);
      const { order, item } = await seedOrder(product.id, 3);
      const before = await stockOf(product.id);
      await declare(order.id, item.id).expect(400);
      await declare(order.id, item.id, { unitNumber: 4 }).expect(400);
      await declare(order.id, item.id, { unitNumber: 0 }).expect(400);
      expect(await stockOf(product.id)).toBe(before);
      expect(await lossesIn(order.id)).toHaveLength(0);
      await declare(order.id, item.id, { unitNumber: 2 }).expect(200);
      await declare(order.id, item.id, { unitNumber: 3 }).expect(200);
      await declare(order.id, item.id, { unitNumber: 2 }).expect(409);
      expect((await lossesIn(order.id)).map((l) => l.unitNumber).sort()).toEqual([2, 3]);
      expect(await stockOf(product.id)).toBe(before - 2);
    });

    it('un ítem de otro pedido, un pedido entregado o un intento ajeno se rechazan sin cambios', async () => {
      const product = await seedProduct(5);
      const a = await seedOrder(product.id);
      const b = await seedOrder(product.id);
      const delivered = await seedOrder(product.id, 1, 'DELIVERED');
      await declare(a.order.id, b.item.id).expect(404);
      await declare(delivered.order.id, delivered.item.id).expect(409);
      await declare(a.order.id, a.item.id, { attemptId: randomUUID() }).expect(400);
      await declare(randomUUID(), a.item.id).expect(404);
      expect(await stockOf(product.id)).toBe(5);
      expect(await db.orm.public.OrderItemLoss.where({ productId: product.id }).all()).toHaveLength(0);
    });

    it('un ADMIN es obligatorio: CLIENT, DRIVER y anónimo se rechazan, el actor no se acepta en el cuerpo y no hay cambios', async () => {
      const product = await seedProduct(2);
      const { order, item } = await seedOrder(product.id);
      await declare(order.id, item.id, {}).expect(200);
      const fresh = await seedOrder(product.id);
      const body = { requestId: randomUUID(), reason: 'x', action: 'LOSS_DECLARE', orderId: fresh.order.id, orderItemId: fresh.item.id };
      await api('post', '/dispatch/interventions', body, ids.client, 'CLIENT').expect(403);
      await api('post', '/dispatch/interventions', body, ids.driverUser, 'DRIVER').expect(403);
      await request(app.getHttpServer()).post('/api/v1/dispatch/interventions').send(body).expect(401);
      await api('post', '/dispatch/interventions', { ...body, actorId: ids.admin2 }).expect(400);
      await api('get', `/dispatch/orders/${order.id}/losses`, undefined, ids.client, 'CLIENT').expect(403);
      expect(await stockOf(product.id)).toBe(1);
      expect(await lossesIn(fresh.order.id)).toHaveLength(0);
    });

    it('cada acción exige sus propios campos y una condición válida', async () => {
      const product = await seedProduct(2);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      await intervene({ action: 'ORIGINAL_RECOVER', lossId }).expect(400);
      await intervene({ action: 'ORIGINAL_RECOVER', lossId, recoveryCondition: 'BROKEN' }).expect(400);
      await intervene({ action: 'REPLACEMENT_PREPARE', lossId, orderId: order.id }).expect(400);
      await intervene({ action: 'LOSS_DECLARE', orderId: order.id }).expect(400);
      await recover(randomUUID(), 'SELLABLE').expect(404);
      await prepare(randomUUID()).expect(404);
    });

    it('el seguimiento de un pedido sin pérdidas está vacío y uno inexistente da 404', async () => {
      const product = await seedProduct(1);
      const { order } = await seedOrder(product.id);
      expect(await losses(order.id)).toEqual([]);
      await api('get', `/dispatch/orders/${randomUUID()}/losses`).expect(404);
    });

    it('el historial de intervenciones registra cada evento con su actor', async () => {
      const product = await seedProduct(2);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      await recover(lossId, 'SELLABLE', ids.admin2).expect(200);
      const audits = await auditsOf(order.id);
      expect(audits.map((a) => [a.action, a.actorId]).sort()).toEqual(
        [['LOSS_DECLARE', ids.admin], ['ORIGINAL_RECOVER', ids.admin2]].sort(),
      );
    });
  });

  describe('restricciones de la base de datos', () => {
    it('impiden dos pérdidas de la misma unidad, dos movimientos del mismo tipo y movimientos inválidos', async () => {
      const product = await seedProduct(5);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId;
      const dup = () =>
        db.orm.public.OrderItemLoss.create({
          orderId: order.id, orderItemId: item.id, unitNumber: 1, productId: product.id, attemptId: null,
          declaredAt: Temporal.Now.instant(), declaredById: ids.admin, declarationRequestId: randomUUID(),
          replacementPreparedAt: null, replacementPreparedById: null, replacementRequestId: null,
          recoveredAt: null, recoveredById: null, recoveryCondition: null, recoveryRequestId: null,
        });
      await expect(dup()).rejects.toThrow();
      const movement = (kind: string, delta: number, stockAfter = 4) =>
        db.orm.public.ProductStockMovement.create({ productId: product.id, lossId, kind, delta, stockAfter, createdById: ids.admin });
      await expect(movement('REPLACEMENT_OUT', -1)).rejects.toThrow(); // ya existe uno para esta pérdida
      await expect(movement('RECOVERY_IN', -1)).rejects.toThrow(); // el signo no corresponde al tipo
      await expect(movement('RECOVERY_IN', 1, -1)).rejects.toThrow(); // stock resultante negativo
      await expect(db.orm.public.Product.where({ id: product.id }).update({ stock: -1 })).rejects.toThrow();
      await expect(
        db.orm.public.OrderItemLoss.where({ id: lossId }).update({ recoveredAt: Temporal.Now.instant() }),
      ).rejects.toThrow(); // recuperación incompleta
      expect(await stockOf(product.id)).toBe(4);
    });
  });

  describe('anulación de pérdida declarada por error (LOSS_CANCEL)', () => {
    const cancelLoss = (
      lossId: string,
      extra: Record<string, unknown> = {},
      sub = ids.admin,
      role = 'ADMIN',
    ) => intervene({ action: 'LOSS_CANCEL', lossId, ...extra }, sub, role);

    it('anular una pérdida PREPARED devuelve +1 al stock con REPLACEMENT_CANCEL_IN, es idempotente y permite redeclarar la misma unidad', async () => {
      const product = await seedProduct(2);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId as string;
      expect(await stockOf(product.id)).toBe(1);

      const cancelBody = {
        requestId: randomUUID(),
        reason: 'Declaración errónea de pérdida',
        action: 'LOSS_CANCEL',
        lossId,
      };
      const first = await api('post', '/dispatch/interventions', cancelBody, ids.admin2).expect(200);
      expect(first.body).toMatchObject({ action: 'LOSS_CANCEL', outcome: 'APPLIED', actorId: ids.admin2, orderId: order.id });
      expect(first.body.result).toMatchObject({ lossId, stock: '2' });

      // Repetición idempotente con misma clave y actor devuelve exactamente lo mismo sin volver a sumar stock.
      const replay = await api('post', '/dispatch/interventions', cancelBody, ids.admin2).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(await stockOf(product.id)).toBe(2);

      // Misma clave con otro actor u otro cuerpo se rechaza; nueva clave sobre pérdida ya anulada también se rechaza.
      await api('post', '/dispatch/interventions', cancelBody, ids.admin).expect(409);
      await api('post', '/dispatch/interventions', { ...cancelBody, reason: 'Otro motivo' }, ids.admin2).expect(409);
      const again = await cancelLoss(lossId).expect(409);
      expect(again.body.code).toBe('LOSS_ALREADY_CANCELLED');

      const movements = await movementsOf(product.id);
      expect(movements.map((m) => m.kind)).toEqual(['REPLACEMENT_OUT', 'REPLACEMENT_CANCEL_IN']);
      expect(movements[1]).toMatchObject({ kind: 'REPLACEMENT_CANCEL_IN', delta: 1, stockAfter: 2, createdById: ids.admin2 });

      const [view] = await losses(order.id);
      expect(view.cancelledById).toBe(ids.admin2);
      expect(view.cancelReason).toBe('Declaración errónea de pérdida');
      expect(view.cancelledAt).toEqual(expect.any(String));

      // Índice único parcial (cancelledAt IS NULL) permite volver a declarar la pérdida real de la misma unidad.
      const redeclared = await declare(order.id, item.id).expect(200);
      expect(redeclared.body.result).toMatchObject({ replacement: 'PREPARED', stock: '1' });
      expect(await stockOf(product.id)).toBe(1);
      expect(await lossesIn(order.id)).toHaveLength(2);
    });

    it('anular una pérdida PENDING (stock = 0) no emite movimientos de inventario y conserva stock = 0', async () => {
      const product = await seedProduct(0);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId as string;
      expect(await movementsOf(product.id)).toHaveLength(0);

      const cancelled = await cancelLoss(lossId).expect(200);
      expect(cancelled.body.result).toMatchObject({ lossId, stock: null });
      expect(await stockOf(product.id)).toBe(0);
      expect(await movementsOf(product.id)).toHaveLength(0);
    });

    it('anular una pérdida reactiva requiresAdministrativeReview cuando el pedido tenía un intento fallido ya despejado', async () => {
      const product = await seedProduct(2);
      const now = Temporal.Now.instant();
      const guayaquilToday = Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate();
      const tomorrow = guayaquilToday.add({ days: 1 }).toString();
      const driverUser = await db.orm.public.User.create({
        id: randomUUID(),
        role: 'DRIVER',
        name: 'Driver Loss Cancel',
        email: randomUUID() + '@fixture.invalid',
        password: 'fixture',
      });
      const driver = await db.orm.public.Driver.create({ userId: driverUser.id, vehicle: 'Moto' });
      const order = await db.orm.public.Order.create({
        userId: ids.client,
        zoneId: ids.zone,
        deliveryAddress: 'Fixture street',
        scheduledDeliveryDate: now,
        deliveryLat: -1.25,
        deliveryLng: -78.62,
      });
      const item = await db.orm.public.OrderItem.create({ orderId: order.id, productId: product.id, quantity: 1, price: 10 });

      const route = (await api('post', '/routes', { zoneId: ids.zone, routeDate: now.toString(), orderIds: [order.id] }).expect(201)).body;
      await api('post', `/routes/${route.id}/assign`, { driverId: driver.id }).expect(200);
      await api('post', `/routes/${route.id}/start`, {}, driverUser.id, 'DRIVER').expect(200);
      const stop = (await api('get', `/routes/${route.id}`).expect(200)).body.stops[0];
      await api(
        'post',
        `/routes/${route.id}/stops/${stop.id}/failure`,
        { requestId: randomUUID(), reason: 'RECIPIENT_ABSENT', context: 'Nadie en casa' },
        driverUser.id,
        'DRIVER',
      ).expect(200);
      const attemptId = (await api('get', `/routes/${route.id}`).expect(200)).body.stops[0].attempts[0].id as string;
      await api('post', `/routes/${route.id}/complete`, {}, driverUser.id, 'DRIVER').expect(200);

      // Reprogramamos primero (limpia requiresAdministrativeReview = false) y luego declaramos la pérdida asociada al intento.
      const contact = (
        await intervene({
          action: 'CONTACT',
          orderId: order.id,
          attemptId,
          agreementConfirmed: true,
          scheduledDeliveryDate: `${tomorrow}T14:00:00-05:00`,
          deliveryWindowStart: `${tomorrow}T13:00:00-05:00`,
          deliveryWindowEnd: `${tomorrow}T16:00:00-05:00`,
        }).expect(200)
      ).body;
      await intervene({ action: 'RESCHEDULE', orderId: order.id, agreementId: contact.id }).expect(200);
      expect((await db.orm.public.Order.where({ id: order.id }).first())!.requiresAdministrativeReview).toBe(false);

      const lossId = (await declare(order.id, item.id, { attemptId }).expect(200)).body.result.lossId as string;
      await cancelLoss(lossId).expect(200);
      expect((await db.orm.public.Order.where({ id: order.id }).first())!.requiresAdministrativeReview).toBe(true);
    });

    it('rechaza 409 cuando el original ya fue recuperado, por estado del pedido, por claim activo o por retiro acordado, y la BD impide anular con recoveredAt', async () => {
      const product = await seedProduct(5);

      // 1. Original ya recuperado
      const rec = await seedOrder(product.id);
      const recLossId = (await declare(rec.order.id, rec.item.id).expect(200)).body.result.lossId as string;
      await recover(recLossId, 'DAMAGED').expect(200);
      expect((await cancelLoss(recLossId).expect(409)).body.code).toBe('LOSS_ALREADY_RECOVERED');

      // La restricción CHECK order_item_loss_cancellation_consistent impide SQL con cancelledAt + recoveredAt juntos.
      await expect(
        db.orm.public.OrderItemLoss.where({ id: recLossId }).update({
          cancelledAt: Temporal.Now.instant(),
          cancelledById: ids.admin,
          cancelReason: 'Intento directo',
          cancelRequestId: randomUUID(),
        }),
      ).rejects.toThrow();

      // 2. Pedido en IN_TRANSIT, DELIVERED y CANCELLED
      const inTransitOrder = await db.orm.public.Order.create({
        userId: ids.client,
        zoneId: ids.zone,
        deliveryAddress: 'Fixture street',
        status: 'IN_TRANSIT',
        deliveryLat: -1.25,
        deliveryLng: -78.62,
      });
      const inTransitItem = await db.orm.public.OrderItem.create({ orderId: inTransitOrder.id, productId: product.id, quantity: 1, price: 10 });
      const inTransitLossId = (await declare(inTransitOrder.id, inTransitItem.id).expect(200)).body.result.lossId as string;
      expect((await cancelLoss(inTransitLossId).expect(409)).body.code).toBe('LOSS_CANCEL_ORDER_STATE');

      const deliveredCase = await seedOrder(product.id);
      const deliveredLossId = (await declare(deliveredCase.order.id, deliveredCase.item.id).expect(200)).body.result.lossId as string;
      await db.orm.public.Order.where({ id: deliveredCase.order.id }).update({ status: 'DELIVERED' });
      expect((await cancelLoss(deliveredLossId).expect(409)).body.code).toBe('LOSS_CANCEL_ORDER_STATE');

      const cancelledCase = await seedOrder(product.id);
      const cancelledLossId = (await declare(cancelledCase.order.id, cancelledCase.item.id).expect(200)).body.result.lossId as string;
      await request(app.getHttpServer())
        .patch(`/api/v1/orders/${cancelledCase.order.id}/status`)
        .auth(token(ids.admin, 'ADMIN'), { type: 'bearer' })
        .send({ status: 'CANCELLED' })
        .expect(200);
      expect((await cancelLoss(cancelledLossId).expect(409)).body.code).toBe('LOSS_CANCEL_ORDER_STATE');

      // 3. Pedido con OrderClaim activo (ruta DRAFT)
      const now = Temporal.Now.instant();
      const claimedOrder = await db.orm.public.Order.create({
        userId: ids.client,
        zoneId: ids.zone,
        deliveryAddress: 'Fixture street',
        scheduledDeliveryDate: now,
        deliveryLat: -1.25,
        deliveryLng: -78.62,
      });
      const claimedItem = await db.orm.public.OrderItem.create({ orderId: claimedOrder.id, productId: product.id, quantity: 1, price: 10 });
      const claimedLossId = (await declare(claimedOrder.id, claimedItem.id).expect(200)).body.result.lossId as string;
      await api('post', '/routes', { zoneId: ids.zone, routeDate: now.toString(), orderIds: [claimedOrder.id] }).expect(201);
      expect((await cancelLoss(claimedLossId).expect(409)).body.code).toBe('LOSS_CANCEL_ACTIVE_CLAIM');

      // 4. Pedido con OrderPickup (#50)
      const pickupCase = await seedOrder(product.id);
      const pickupLossId = (await declare(pickupCase.order.id, pickupCase.item.id).expect(200)).body.result.lossId as string;
      await intervene({ action: 'PICKUP_AGREE', orderId: pickupCase.order.id }).expect(200);
      expect((await cancelLoss(pickupLossId).expect(409)).body.code).toBe('LOSS_CANCEL_PICKUP_EXISTS');
    });

    it('anulaciones concurrentes de una pérdida PREPARED: solo una aplica +1 al stock y las demás devuelven 409', async () => {
      const product = await seedProduct(3);
      const { order, item } = await seedOrder(product.id);
      const lossId = (await declare(order.id, item.id).expect(200)).body.result.lossId as string;
      expect(await stockOf(product.id)).toBe(2);

      const responses = await Promise.all([
        cancelLoss(lossId, {}, ids.admin),
        cancelLoss(lossId, {}, ids.admin2),
        cancelLoss(lossId, {}, ids.admin),
        cancelLoss(lossId, {}, ids.admin2),
      ]);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(3);
      expect(await stockOf(product.id)).toBe(3);
      expect((await movementsOf(product.id)).filter((m) => m.kind === 'REPLACEMENT_CANCEL_IN')).toHaveLength(1);
    });
  });
});
