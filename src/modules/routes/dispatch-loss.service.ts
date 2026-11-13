import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { nowInstant } from '../../common/temporal.util.js';
import { lockInventoryProduct, MAX_INVENTORY_QUANTITY } from '../orders/order-inventory.util.js';
import type { DispatchInterventionDto } from './dto/dispatch-intervention.dto.js';
import { OrderItemLossDto } from './dto/order-item-loss.dto.js';
import type { RealtimeChange } from '../realtime/realtime.contract.js';

type Transaction = Parameters<Parameters<PrismaService['client']['transaction']>[0]>[0];
type Loss = NonNullable<
  Awaited<ReturnType<PrismaService['client']['orm']['public']['OrderItemLoss']['first']>>
>;
type AuditRow = NonNullable<
  Awaited<ReturnType<PrismaService['client']['orm']['public']['DispatchIntervention']['first']>>
>;
export type LossAudit = (
  routeId: string | null,
  result: Record<string, string | null>,
  orderId: string | null,
) => Promise<AuditRow>;

/**
 * Pérdida, reemplazo y recuperación tardía de una unidad de un pedido (#52).
 *
 * - LOSS_DECLARE: el ADMIN declara la pérdida de UNA unidad de un ítem. Con existencia libre se consume una unidad para
 *   el reemplazo en la misma transacción (reemplazo PREPARED); sin ella queda PENDING y no se simula nada.
 * - REPLACEMENT_PREPARE: cuando ya hay existencia libre, prepara el reemplazo de una pérdida PENDING.
 * - ORIGINAL_RECOVER: el original reaparece; solo si el ADMIN lo comprueba SELLABLE suma una unidad, una sola vez.
 *
 * Ninguna acción crea otra compra, cobro, comprobante ni entrega, y ninguna modifica el pedido: la entrega del
 * reemplazo se gestiona con las intervenciones de despacho que ya existen (CONTACT / RESCHEDULE / PICKUP_*). El
 * historial de existencias (`ProductStockMovement`) es único por (pérdida, tipo), así que repetición o concurrencia
 * nunca descuentan ni suman dos veces. El producto se bloquea con el mismo `FOR UPDATE` que las ventas.
 */
export class DispatchLossService {
  constructor(private readonly prisma: PrismaService) {}

  private conflict(code: string, message: string): ConflictException {
    return new ConflictException({ statusCode: 409, message, error: 'Conflict', code });
  }

  async handle(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    audit: LossAudit,
  ): Promise<AuditRow> {
    if (dto.action === 'LOSS_DECLARE') return this.declare(tx, dto, actorId, changes, audit);
    if (dto.action === 'REPLACEMENT_PREPARE') return this.prepare(tx, dto, actorId, changes, audit);
    return this.recover(tx, dto, actorId, changes, audit);
  }

  /** Bloquea el pedido de la pérdida (serializa administradores concurrentes) y relee la pérdida ya bloqueada. */
  private async lockLoss(tx: Transaction, lossId: string): Promise<Loss> {
    const db = tx.orm.public;
    const found = await db.OrderItemLoss.where({ id: lossId }).first();
    if (!found) throw new NotFoundException('Loss not found');
    if (!(await db.Order.where({ id: found.orderId }).update({ id: found.orderId })))
      throw new NotFoundException('Order not found');
    const loss = await db.OrderItemLoss.where({ id: lossId }).first();
    if (!loss) throw new NotFoundException('Loss not found');
    return loss;
  }

  /** Descuenta (-1) o suma (+1) una unidad con el producto bloqueado y deja el movimiento en el historial. */
  private async move(
    tx: Transaction,
    loss: Loss,
    kind: 'REPLACEMENT_OUT' | 'RECOVERY_IN',
    actorId: string,
  ) {
    const db = tx.orm.public;
    const product = await lockInventoryProduct(tx, this.prisma.client.raw, loss.productId);
    const delta = kind === 'REPLACEMENT_OUT' ? -1 : 1;
    const after = product.stock + delta;
    if (after < 0) throw this.conflict('NO_FREE_STOCK', 'No hay existencia libre para preparar el reemplazo');
    if (after > MAX_INVENTORY_QUANTITY)
      throw new ConflictException('Product quantity exceeds supported inventory range');
    await db.ProductStockMovement.create({
      productId: loss.productId,
      lossId: loss.id,
      kind,
      delta,
      stockAfter: after,
      createdById: actorId,
    });
    await db.Product.where({ id: loss.productId }).update({ stock: after, updatedAt: nowInstant() });
    return after;
  }

  private async declare(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    audit: LossAudit,
  ) {
    const db = tx.orm.public;
    const order = await db.Order.where({ id: dto.orderId! }).update({ id: dto.orderId! });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'DELIVERED' || order.status === 'CANCELLED')
      throw new ConflictException('Commercially resolved order cannot declare a loss');
    const item = await db.OrderItem.where({ id: dto.orderItemId! }).first();
    if (!item || item.orderId !== order.id) throw new NotFoundException('Order item not found');
    const unitNumber = dto.unitNumber ?? (item.quantity === 1 ? 1 : undefined);
    if (unitNumber === undefined)
      throw new BadRequestException('unitNumber is required for an item with several units');
    if (unitNumber > item.quantity)
      throw new BadRequestException('unitNumber exceeds the quantity of the order item');
    if (dto.attemptId) {
      const attempt = await db.DeliveryAttempt.where({ id: dto.attemptId }).first();
      const stop = attempt ? await db.RouteStop.where({ id: attempt.stopId }).first() : null;
      if (!attempt || !stop || stop.orderId !== order.id)
        throw new BadRequestException('The delivery attempt does not belong to this order');
    }
    if (await db.OrderItemLoss.where({ orderItemId: item.id, unitNumber }).first())
      throw this.conflict('LOSS_ALREADY_DECLARED', 'Esa unidad ya tiene una pérdida declarada');

    // Compra, cobro y comprobante no se tocan: la pérdida solo registra la unidad y el reemplazo consume existencia libre.
    const created = await db.OrderItemLoss.create({
      orderId: order.id,
      orderItemId: item.id,
      unitNumber,
      productId: item.productId,
      attemptId: dto.attemptId ?? null,
      declaredAt: nowInstant(),
      declaredById: actorId,
      declarationRequestId: dto.requestId,
      replacementPreparedAt: null,
      replacementPreparedById: null,
      replacementRequestId: null,
      recoveredAt: null,
      recoveredById: null,
      recoveryCondition: null,
      recoveryRequestId: null,
    });
    const product = await lockInventoryProduct(tx, this.prisma.client.raw, item.productId);
    let stock = product.stock;
    let replacement = 'PENDING';
    if (product.stock >= 1) {
      stock = await this.move(tx, created, 'REPLACEMENT_OUT', actorId);
      await db.OrderItemLoss.where({ id: created.id }).update({
        replacementPreparedAt: nowInstant(),
        replacementPreparedById: actorId,
        replacementRequestId: dto.requestId,
      });
      replacement = 'PREPARED';
    }
    const row = await audit(null, { lossId: created.id, replacement, stock: String(stock) }, order.id);
    changes.push({ type: 'dispatch.incident.updated', orderId: order.id, action: 'LOSS_DECLARE' });
    return row;
  }

  private async prepare(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    audit: LossAudit,
  ) {
    const db = tx.orm.public;
    const loss = await this.lockLoss(tx, dto.lossId!);
    if (loss.replacementPreparedAt)
      throw this.conflict('REPLACEMENT_ALREADY_PREPARED', 'El reemplazo de esta pérdida ya está preparado');
    // Sin existencia libre se rechaza y no se escribe nada: nunca se simula un reemplazo preparado.
    const stock = await this.move(tx, loss, 'REPLACEMENT_OUT', actorId);
    await db.OrderItemLoss.where({ id: loss.id }).update({
      replacementPreparedAt: nowInstant(),
      replacementPreparedById: actorId,
      replacementRequestId: dto.requestId,
    });
    const row = await audit(null, { lossId: loss.id, replacement: 'PREPARED', stock: String(stock) }, loss.orderId);
    changes.push({ type: 'dispatch.incident.updated', orderId: loss.orderId, action: 'REPLACEMENT_PREPARE' });
    return row;
  }

  private async recover(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    audit: LossAudit,
  ) {
    const db = tx.orm.public;
    const loss = await this.lockLoss(tx, dto.lossId!);
    if (loss.recoveredAt)
      throw this.conflict('ORIGINAL_ALREADY_RECOVERED', 'El original de esta pérdida ya fue registrado como recuperado');
    const condition = dto.recoveryCondition!;
    // Solo un original vendible comprobado suma una unidad, una sola vez; uno dañado se registra sin tocar el stock.
    let stock: string | null = null;
    if (condition === 'SELLABLE') stock = String(await this.move(tx, loss, 'RECOVERY_IN', actorId));
    await db.OrderItemLoss.where({ id: loss.id }).update({
      recoveredAt: nowInstant(),
      recoveredById: actorId,
      recoveryCondition: condition,
      recoveryRequestId: dto.requestId,
    });
    const row = await audit(null, { lossId: loss.id, recovery: condition, stock }, loss.orderId);
    changes.push({ type: 'dispatch.incident.updated', orderId: loss.orderId, action: 'ORIGINAL_RECOVER' });
    return row;
  }

  /**
   * Seguimiento ADMIN de las pérdidas de un pedido (#52): el original (declaración y recuperación) y su reemplazo van
   * separados, con los movimientos de existencias de cada uno. Solo lectura.
   */
  async list(orderId: string): Promise<OrderItemLossDto[]> {
    const db = this.prisma.client.orm.public;
    if (!(await db.Order.where({ id: orderId }).first())) throw new NotFoundException('Order not found');
    const losses = await db.OrderItemLoss.where({ orderId }).all();
    losses.sort((a, b) => a.orderItemId.localeCompare(b.orderItemId) || a.unitNumber - b.unitNumber);
    const rows: OrderItemLossDto[] = [];
    for (const loss of losses) {
      const movements = await db.ProductStockMovement.where({ lossId: loss.id }).all();
      movements.sort((a, b) => Temporal.Instant.compare(a.createdAt, b.createdAt));
      rows.push({
        id: loss.id,
        orderId: loss.orderId,
        orderItemId: loss.orderItemId,
        unitNumber: loss.unitNumber,
        productId: loss.productId,
        attemptId: loss.attemptId,
        declaredAt: loss.declaredAt.toString(),
        declaredById: loss.declaredById,
        replacement: {
          state: loss.replacementPreparedAt ? 'PREPARED' : 'PENDING',
          preparedAt: loss.replacementPreparedAt?.toString() ?? null,
          preparedById: loss.replacementPreparedById,
        },
        original: {
          state: loss.recoveredAt ? 'RECOVERED' : 'LOST',
          condition: (loss.recoveryCondition as 'SELLABLE' | 'DAMAGED' | null) ?? null,
          recoveredAt: loss.recoveredAt?.toString() ?? null,
          recoveredById: loss.recoveredById,
        },
        movements: movements.map((m) => ({
          kind: m.kind as 'REPLACEMENT_OUT' | 'RECOVERY_IN',
          delta: m.delta,
          stockAfter: m.stockAfter,
          createdAt: m.createdAt.toString(),
          createdById: m.createdById,
        })),
      });
    }
    return rows;
  }
}
