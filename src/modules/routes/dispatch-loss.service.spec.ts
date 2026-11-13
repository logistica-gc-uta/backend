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
  });
});
