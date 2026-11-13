import { DispatchLossService } from './dispatch-loss.service.js';
import type { DispatchInterventionDto } from './dto/dispatch-intervention.dto.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { RealtimeChange } from '../realtime/realtime.contract.js';

type Row = Record<string, any>;
type Rows = Record<string, Row[]>;

const instant = Temporal.Instant.from('2026-11-13T15:00:00Z');

/** Base en memoria con la parte del ORM que usa el servicio (where/first/all/update/create). */
function harness(seed: Partial<Rows> = {}, products: Row[] = []) {
  const rows: Rows = {
    Order: [],
    OrderItem: [],
    OrderItemLoss: [],
    ProductStockMovement: [],
    DeliveryAttempt: [],
    RouteStop: [],
    Route: [],
    RouteEmergency: [],
    RouteUnitRecovery: [],
    OrderClaim: [],
    OrderPickup: [],
    DispatchIntervention: [],
    ...seed,
    Product: products,
  };
  let next = 0;
  const models = Object.fromEntries(
    Object.keys(rows).map((name) => {
      const query = (filter: Row = {}) => {
        const matching = () => rows[name]!.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        return {
          first: async () => matching()[0] ?? null,
          all: async () => matching(),
          update: async (change: Row) => {
            const row = matching()[0];
            return row ? Object.assign(row, change) : null;
          },
        };
      };
      return [
        name,
        {
          where: query,
          create: async (value: Row) => {
            const row = { id: `${name}-${++next}`, createdAt: instant, ...value };
            rows[name]!.push(row);
            return row;
          },
        },
      ];
    }),
  );
  const tx = {
    orm: { public: models },
    // lockInventoryProduct: el plan lleva el id del producto bloqueado
    query: async (plan: { productId: string }) => {
      const p = rows.Product!.find((r) => r.id === plan.productId);
      return p ? [{ id: p.id, name: p.name, price: 1, stock: p.stock }] : [];
    },
  };
  const prisma = {
    client: {
      orm: { public: models },
      raw: {
        sql: (_s: TemplateStringsArray, productId: string) => ({
          returnsRow: () => ({ build: () => ({ productId }) }),
        }),
      },
    },
  } as unknown as PrismaService;
  const service = new DispatchLossService(prisma);
  const audits: Row[] = [];
  const audit = async (routeId: string | null, result: Record<string, string | null>, orderId: string | null) => {
    const row = { id: `audit-${audits.length + 1}`, routeId, result, orderId };
    audits.push(row);
    return row as never;
  };
  const dto = (body: Partial<DispatchInterventionDto>) =>
    ({ requestId: `req-${++next}`, reason: 'x', ...body }) as DispatchInterventionDto;
  const run = (body: Partial<DispatchInterventionDto>, actor = 'admin') => {
    const changes: RealtimeChange[] = [];
    return service.handle(tx as never, dto(body), actor, changes, audit).then((row) => ({ row, changes }));
  };
  return { rows, service, tx, run, audits };
}

const base = (stock: number, quantity = 1, status = 'PENDING') =>
  harness(
    {
      Order: [{ id: 'order', status }],
      OrderItem: [{ id: 'item', orderId: 'order', productId: 'product', quantity }],
    },
    [{ id: 'product', name: 'Ramo', stock }],
  );

describe('DispatchLossService (#52)', () => {
  describe('LOSS_DECLARE', () => {
    it('con existencia libre prepara el reemplazo, descuenta una unidad y deja un movimiento', async () => {
      const h = base(2);
      const { row, changes } = await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      expect(row).toMatchObject({ orderId: 'order', result: { replacement: 'PREPARED', stock: '1' } });
      expect(h.rows.Product![0]!.stock).toBe(1);
      expect(h.rows.ProductStockMovement).toEqual([
        expect.objectContaining({ kind: 'REPLACEMENT_OUT', delta: -1, stockAfter: 1, createdById: 'admin' }),
      ]);
      expect(h.rows.OrderItemLoss![0]).toMatchObject({ unitNumber: 1, replacementPreparedById: 'admin', recoveredAt: null });
      expect(changes).toEqual([{ type: 'dispatch.incident.updated', orderId: 'order', action: 'LOSS_DECLARE' }]);
    });

    it('sin existencia libre deja el reemplazo pendiente y no toca el stock', async () => {
      const h = base(0);
      const { row } = await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      expect(row).toMatchObject({ result: { replacement: 'PENDING', stock: '0' } });
      expect(h.rows.Product![0]!.stock).toBe(0);
      expect(h.rows.ProductStockMovement).toHaveLength(0);
      expect(h.rows.OrderItemLoss![0]).toMatchObject({ replacementPreparedAt: null });
    });

    it('en un ítem de varias unidades exige indicar la unidad y valida su rango', async () => {
      const h = base(5, 3);
      await expect(h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' })).rejects.toThrow('unitNumber is required');
      await expect(h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', unitNumber: 4 })).rejects.toThrow('exceeds');
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', unitNumber: 3 });
      expect(h.rows.OrderItemLoss![0]).toMatchObject({ unitNumber: 3 });
    });

    it('rechaza la misma unidad declarada dos veces con un código tipado y no vuelve a descontar', async () => {
      const h = base(5);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      await expect(h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'LOSS_ALREADY_DECLARED' }),
      });
      expect(h.rows.Product![0]!.stock).toBe(4);
    });

    it('rechaza pedido inexistente, entregado o cancelado, ítem ajeno e intento de otro pedido', async () => {
      const h = base(5);
      await expect(h.run({ action: 'LOSS_DECLARE', orderId: 'nope', orderItemId: 'item' })).rejects.toThrow('Order not found');
      await expect(h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'other' })).rejects.toThrow('Order item not found');
      h.rows.OrderItem!.push({ id: 'foreign', orderId: 'else', productId: 'product', quantity: 1 });
      await expect(h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'foreign' })).rejects.toThrow('Order item not found');
      await expect(h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', attemptId: 'nope' })).rejects.toThrow('does not belong');
      h.rows.DeliveryAttempt!.push({ id: 'attempt', stopId: 'stop' });
      h.rows.RouteStop!.push({ id: 'stop', orderId: 'else' });
      await expect(h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', attemptId: 'attempt' })).rejects.toThrow('does not belong');
      for (const status of ['DELIVERED', 'CANCELLED']) {
        h.rows.Order![0]!.status = status;
        await expect(h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' })).rejects.toThrow('cannot declare a loss');
      }
      expect(h.rows.OrderItemLoss).toHaveLength(0);
      expect(h.rows.Product![0]!.stock).toBe(5);
    });

    it('enlaza el intento fallido del mismo pedido', async () => {
      const h = base(1);
      h.rows.DeliveryAttempt!.push({ id: 'attempt', stopId: 'stop' });
      h.rows.RouteStop!.push({ id: 'stop', orderId: 'order' });
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', attemptId: 'attempt' });
      expect(h.rows.OrderItemLoss![0]).toMatchObject({ attemptId: 'attempt' });
    });

    it('soporta attemptId en ruta COMPLETED o INTERRUPTED con intento FAILED y rechaza rutas activas o intentos exitosos', async () => {
      const h = base(2);
      h.rows.Route!.push({ id: 'route-int', status: 'INTERRUPTED' });
      h.rows.RouteStop!.push({ id: 'stop-int', routeId: 'route-int', orderId: 'order' });
      h.rows.DeliveryAttempt!.push({ id: 'att-fail', stopId: 'stop-int', outcome: 'FAILED' });
      h.rows.DeliveryAttempt!.push({ id: 'att-ok', stopId: 'stop-int', outcome: 'SUCCESSFUL' });

      await expect(
        h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', attemptId: 'att-ok' }),
      ).rejects.toThrow('FAILED');

      h.rows.Route![0]!.status = 'IN_PROGRESS';
      await expect(
        h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', attemptId: 'att-fail' }),
      ).rejects.toThrow('COMPLETED or INTERRUPTED');

      h.rows.Route![0]!.status = 'INTERRUPTED';
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', attemptId: 'att-fail' });
      expect(h.rows.OrderItemLoss![0]).toMatchObject({ attemptId: 'att-fail' });
    });

    it('soporta LOSS_DECLARE con emergencyId (#51) y rechaza si la unidad ya fue recuperada (UNIT_ALREADY_RECOVERED) o sin custodia válida', async () => {
      const h = base(2, 2);
      h.rows.RouteEmergency!.push({ id: 'em-1', routeId: 'r-1' });
      h.rows.RouteUnitRecovery!.push(
        {
          id: 'rec-1',
          emergencyId: 'em-1',
          orderId: 'order',
          orderItemId: 'item',
          unitNumber: 1,
          recoveredAt: null,
        },
        {
          id: 'rec-2',
          emergencyId: 'em-1',
          orderId: 'order',
          orderItemId: 'item',
          unitNumber: 2,
          recoveredAt: instant,
        },
      );

      await expect(
        h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', unitNumber: 1, emergencyId: 'missing-em' }),
      ).rejects.toThrow();
      await expect(
        h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', unitNumber: 2, emergencyId: 'em-1' }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'UNIT_ALREADY_RECOVERED' }) });
      await expect(
        h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', unitNumber: 2 }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'UNIT_ALREADY_RECOVERED' }) });

      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', unitNumber: 1, emergencyId: 'em-1' });
      expect(h.rows.OrderItemLoss![0]).toMatchObject({ unitNumber: 1, cancelledAt: null });
    });

    it('permite volver a declarar pérdida de la misma unidad si la anterior fue anulada (cancelledAt != null)', async () => {
      const h = base(2);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      const firstId = h.rows.OrderItemLoss![0]!.id;
      await h.run({ action: 'LOSS_CANCEL', lossId: firstId });

      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      expect(h.rows.OrderItemLoss).toHaveLength(2);
      expect(h.rows.OrderItemLoss![0]!.cancelledAt).not.toBeNull();
      expect(h.rows.OrderItemLoss![1]!.cancelledAt).toBeNull();
    });
  });

  describe('REPLACEMENT_PREPARE', () => {
    it('prepara el reemplazo pendiente cuando ya hay existencia y no permite repetirlo', async () => {
      const h = base(0);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      const lossId = h.rows.OrderItemLoss![0]!.id;
      await expect(h.run({ action: 'REPLACEMENT_PREPARE', lossId })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'NO_FREE_STOCK' }),
      });
      expect(h.rows.ProductStockMovement).toHaveLength(0);
      expect(h.rows.OrderItemLoss![0]!.replacementPreparedAt).toBeNull();
      h.rows.Product![0]!.stock = 1;
      const { row } = await h.run({ action: 'REPLACEMENT_PREPARE', lossId });
      expect(row).toMatchObject({ orderId: 'order', result: { replacement: 'PREPARED', stock: '0' } });
      await expect(h.run({ action: 'REPLACEMENT_PREPARE', lossId })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'REPLACEMENT_ALREADY_PREPARED' }),
      });
      expect(h.rows.Product![0]!.stock).toBe(0);
    });

    it('rechaza una pérdida inexistente o cuyo pedido ya no existe', async () => {
      const h = base(1);
      await expect(h.run({ action: 'REPLACEMENT_PREPARE', lossId: 'nope' })).rejects.toThrow('Loss not found');
      h.rows.OrderItemLoss!.push({ id: 'orphan', orderId: 'gone', productId: 'product', unitNumber: 1 });
      await expect(h.run({ action: 'REPLACEMENT_PREPARE', lossId: 'orphan' })).rejects.toThrow('Order not found');
    });
  });

  describe('ORIGINAL_RECOVER', () => {
    it('un original vendible suma una unidad una sola vez', async () => {
      const h = base(2);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      const lossId = h.rows.OrderItemLoss![0]!.id;
      const { row } = await h.run({ action: 'ORIGINAL_RECOVER', lossId, recoveryCondition: 'SELLABLE' });
      expect(row).toMatchObject({ result: { recovery: 'SELLABLE', stock: '2' } });
      expect(h.rows.Product![0]!.stock).toBe(2);
      await expect(h.run({ action: 'ORIGINAL_RECOVER', lossId, recoveryCondition: 'SELLABLE' })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ORIGINAL_ALREADY_RECOVERED' }),
      });
      expect(h.rows.Product![0]!.stock).toBe(2);
      expect(h.rows.ProductStockMovement!.map((m) => m.kind)).toEqual(['REPLACEMENT_OUT', 'RECOVERY_IN']);
    });

    it('un original dañado se registra sin aumentar el stock', async () => {
      const h = base(2);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      const lossId = h.rows.OrderItemLoss![0]!.id;
      const { row } = await h.run({ action: 'ORIGINAL_RECOVER', lossId, recoveryCondition: 'DAMAGED' });
      expect(row).toMatchObject({ result: { recovery: 'DAMAGED', stock: null } });
      expect(h.rows.Product![0]!.stock).toBe(1);
      expect(h.rows.ProductStockMovement).toHaveLength(1);
      expect(h.rows.OrderItemLoss![0]).toMatchObject({ recoveryCondition: 'DAMAGED', recoveredById: 'admin' });
    });

    it('no suma por encima del máximo soportado del inventario', async () => {
      const h = base(0);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      h.rows.Product![0]!.stock = 2147483647;
      await expect(
        h.run({ action: 'ORIGINAL_RECOVER', lossId: h.rows.OrderItemLoss![0]!.id, recoveryCondition: 'SELLABLE' }),
      ).rejects.toThrow('inventory range');
    });

    it('un producto desaparecido del inventario se rechaza', async () => {
      const h = base(1);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      h.rows.Product!.length = 0;
      await expect(
        h.run({ action: 'ORIGINAL_RECOVER', lossId: h.rows.OrderItemLoss![0]!.id, recoveryCondition: 'SELLABLE' }),
      ).rejects.toThrow('no encontrado');
    });
  });

  describe('list', () => {
    it('separa el original del reemplazo e incluye los movimientos ordenados', async () => {
      const h = base(3, 2);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', unitNumber: 2 });
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', unitNumber: 1 });
      await h.run({ action: 'ORIGINAL_RECOVER', lossId: h.rows.OrderItemLoss![1]!.id, recoveryCondition: 'SELLABLE' });
      const list = await h.service.list('order');
      expect(list.map((l) => l.unitNumber)).toEqual([1, 2]);
      expect(list[0]).toMatchObject({
        replacement: { state: 'PREPARED', preparedById: 'admin' },
        original: { state: 'RECOVERED', condition: 'SELLABLE', recoveredById: 'admin' },
      });
      expect(list[0]!.movements.map((m) => [m.kind, m.delta])).toEqual([['REPLACEMENT_OUT', -1], ['RECOVERY_IN', 1]]);
      expect(list[1]).toMatchObject({ original: { state: 'LOST', condition: null, recoveredAt: null } });
    });

    it('un pedido inexistente da 404', async () => {
      await expect(base(1).service.list('nope')).rejects.toThrow('Order not found');
    });

    it('un pedido sin pérdidas devuelve una lista vacía', async () => {
      expect(await base(1).service.list('order')).toEqual([]);
    });

    it('incluye metadatos de anulación y movimientos REPLACEMENT_CANCEL_IN en list()', async () => {
      const h = base(2);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      const lossId = h.rows.OrderItemLoss![0]!.id;
      await h.run({ action: 'LOSS_CANCEL', lossId, reason: 'Apareció antes de despachar' }, 'admin-cancel');
      const items = await h.service.list('order');
      expect(items[0]).toMatchObject({
        id: lossId,
        cancelledById: 'admin-cancel',
        cancelReason: 'Apareció antes de despachar',
      });
      expect(items[0]!.cancelledAt).toBeTruthy();
      expect(items[0]!.movements.map((m) => [m.kind, m.delta, m.stockAfter])).toEqual([
        ['REPLACEMENT_OUT', -1, 1],
        ['REPLACEMENT_CANCEL_IN', 1, 2],
      ]);
    });
  });

  describe('LOSS_CANCEL (#51/#52)', () => {
    it('si el reemplazo estaba PREPARED, devuelve +1 al stock con movimiento REPLACEMENT_CANCEL_IN y audita', async () => {
      const h = base(2);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      const lossId = h.rows.OrderItemLoss![0]!.id;
      expect(h.rows.Product![0]!.stock).toBe(1);

      const { row, changes } = await h.run({
        action: 'LOSS_CANCEL',
        lossId,
        reason: 'Declaración errónea',
      });
      expect(row).toMatchObject({ orderId: 'order', result: { lossId, stock: '2' } });
      expect(h.rows.Product![0]!.stock).toBe(2);
      expect(h.rows.ProductStockMovement![1]).toMatchObject({
        lossId,
        kind: 'REPLACEMENT_CANCEL_IN',
        delta: 1,
        stockAfter: 2,
        createdById: 'admin',
      });
      expect(h.rows.OrderItemLoss![0]).toMatchObject({
        cancelledById: 'admin',
        cancelReason: 'Declaración errónea',
      });
      expect(changes).toContainEqual({
        type: 'dispatch.incident.updated',
        orderId: 'order',
        action: 'LOSS_CANCEL',
        requiresAdministrativeReview: false,
      });
    });

    it('si el reemplazo estaba PENDING, anula sin emitir movimiento ni modificar stock', async () => {
      const h = base(0);
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      const lossId = h.rows.OrderItemLoss![0]!.id;

      const { row } = await h.run({ action: 'LOSS_CANCEL', lossId });
      expect(row).toMatchObject({ orderId: 'order', result: { lossId, stock: null } });
      expect(h.rows.Product![0]!.stock).toBe(0);
      expect(h.rows.ProductStockMovement).toHaveLength(0);
      expect(h.rows.OrderItemLoss![0]!.cancelledAt).toBeTruthy();
    });

    it('reactiva requiresAdministrativeReview cuando existe RouteUnitRecovery sin resolver y emite order.status.updated', async () => {
      const h = base(2);
      h.rows.Order![0]!.requiresAdministrativeReview = false;
      h.rows.RouteEmergency!.push({ id: 'em-1', routeId: 'r-1' });
      h.rows.RouteUnitRecovery!.push({
        id: 'rec-1',
        emergencyId: 'em-1',
        orderId: 'order',
        orderItemId: 'item',
        unitNumber: 1,
        recoveredAt: null,
      });
      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item', emergencyId: 'em-1' });
      const lossId = h.rows.OrderItemLoss![0]!.id;

      const { changes } = await h.run({ action: 'LOSS_CANCEL', lossId });
      expect(h.rows.Order![0]!.requiresAdministrativeReview).toBe(true);
      expect(changes).toEqual([
        {
          type: 'order.status.updated',
          orderId: 'order',
          status: 'PENDING',
          requiresAdministrativeReview: true,
        },
        {
          type: 'dispatch.incident.updated',
          orderId: 'order',
          action: 'LOSS_CANCEL',
          requiresAdministrativeReview: true,
        },
      ]);
    });

    it('rechaza 404 si la pérdida no existe, 409 si ya fue anulada, recuperada, por estado de pedido, claim activo o pickup', async () => {
      const h = base(3);
      await expect(h.run({ action: 'LOSS_CANCEL', lossId: 'missing' })).rejects.toThrow('Loss not found');

      await h.run({ action: 'LOSS_DECLARE', orderId: 'order', orderItemId: 'item' });
      const lossId = h.rows.OrderItemLoss![0]!.id;

      for (const status of ['IN_TRANSIT', 'DELIVERED', 'CANCELLED']) {
        h.rows.Order![0]!.status = status;
        await expect(h.run({ action: 'LOSS_CANCEL', lossId })).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'LOSS_CANCEL_ORDER_STATE' }),
        });
      }
      h.rows.Order![0]!.status = 'PENDING';

      h.rows.OrderClaim!.push({ id: 'c1', orderId: 'order', releasedAt: null });
      await expect(h.run({ action: 'LOSS_CANCEL', lossId })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'LOSS_CANCEL_ACTIVE_CLAIM' }),
      });
      h.rows.OrderClaim = [];

      h.rows.OrderPickup!.push({ id: 'p1', orderId: 'order', confirmedAt: null });
      await expect(h.run({ action: 'LOSS_CANCEL', lossId })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'LOSS_CANCEL_PICKUP_EXISTS' }),
      });
      h.rows.OrderPickup = [];

      h.rows.OrderItemLoss![0]!.recoveredAt = instant;
      await expect(h.run({ action: 'LOSS_CANCEL', lossId })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'LOSS_ALREADY_RECOVERED' }),
      });
      h.rows.OrderItemLoss![0]!.recoveredAt = null;

      await h.run({ action: 'LOSS_CANCEL', lossId });
      await expect(h.run({ action: 'LOSS_CANCEL', lossId })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'LOSS_ALREADY_CANCELLED' }),
      });
      await expect(h.run({ action: 'REPLACEMENT_PREPARE', lossId })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'LOSS_ALREADY_CANCELLED' }),
      });
      await expect(
        h.run({ action: 'ORIGINAL_RECOVER', lossId, recoveryCondition: 'SELLABLE' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'LOSS_ALREADY_CANCELLED' }),
      });
    });
  });
});
