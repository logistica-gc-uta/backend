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
    if (dto.action === 'LOSS_CANCEL') return this.cancel(tx, dto, actorId, changes, audit);
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
    kind: 'REPLACEMENT_OUT' | 'RECOVERY_IN' | 'REPLACEMENT_CANCEL_IN',
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
      if (attempt.outcome && attempt.outcome !== 'FAILED')
        throw this.conflict('INVALID_LOSS_ATTEMPT', 'Only a FAILED delivery attempt can authorize a loss');
      const route = stop.routeId && db.Route ? await db.Route.where({ id: stop.routeId }).first() : null;
      if (route && !['COMPLETED', 'INTERRUPTED'].includes(route.status ?? ''))
        throw this.conflict('INVALID_LOSS_ROUTE_STATUS', 'Route must be COMPLETED or INTERRUPTED to declare a loss');
    }
    if (dto.emergencyId) {
      const emergency = db.RouteEmergency ? await db.RouteEmergency.where({ id: dto.emergencyId }).first() : null;
      const recovery =
        emergency && db.RouteUnitRecovery
          ? await db.RouteUnitRecovery.where({
              emergencyId: emergency.id,
              orderId: order.id,
              orderItemId: item.id,
              unitNumber,
            }).first()
          : null;
      if (!emergency || !recovery)
        throw this.conflict(
          'EMERGENCY_RECOVERY_NOT_FOUND',
          'No matching emergency unit recovery authorizes this loss',
        );
      if (recovery.recoveredAt != null)
        throw this.conflict(
          'UNIT_ALREADY_RECOVERED',
          'Unit was already confirmed as recovered in the route emergency',
        );
    }
    if (db.RouteUnitRecovery) {
      const unitRecoveries = await db.RouteUnitRecovery.where({
        orderItemId: item.id,
        unitNumber,
      }).all();
      if (unitRecoveries.some((unit) => unit.recoveredAt != null))
        throw this.conflict(
          'UNIT_ALREADY_RECOVERED',
          'Unit was already confirmed as recovered in the route emergency',
        );
    }
    if (await db.OrderItemLoss.where({ orderItemId: item.id, unitNumber, cancelledAt: null }).first())
      throw this.conflict('LOSS_ALREADY_DECLARED', 'Esa unidad ya tiene una pérdida declarada');

    // Lock Product FOR UPDATE before inserting OrderItemLoss (whose FK takes FOR KEY SHARE on Product)
    // so concurrent LOSS_DECLARE requests on distinct orders serialize cleanly instead of deadlocking (40P01).
    const product = await lockInventoryProduct(tx, this.prisma.client.raw, item.productId);

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
      cancelledAt: null,
      cancelledById: null,
      cancelReason: null,
      cancelRequestId: null,
    });
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
    if (loss.cancelledAt != null)
      throw this.conflict('LOSS_ALREADY_CANCELLED', 'Cannot prepare replacement for a cancelled loss');
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
    if (loss.cancelledAt != null)
      throw this.conflict('LOSS_ALREADY_CANCELLED', 'Cannot recover original for a cancelled loss');
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

  private async hasFailedAttempt(tx: Transaction, orderId: string): Promise<boolean> {
    const db = tx.orm.public;
    const stops = await db.RouteStop.where({ orderId, outcome: 'FAILED' }).all();
    for (const stop of stops) {
      if (await db.DeliveryAttempt.where({ stopId: stop.id, outcome: 'FAILED' }).first()) {
        return true;
      }
    }
    return false;
  }

  private async cancel(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    audit: LossAudit,
  ) {
    const db = tx.orm.public;
    const loss = await this.lockLoss(tx, dto.lossId!);
    const order = await db.Order.where({ id: loss.orderId }).first();
    if (!order) throw new NotFoundException('Order not found');
    if (loss.cancelledAt != null)
      throw this.conflict('LOSS_ALREADY_CANCELLED', 'Order item loss is already cancelled');
    if (loss.recoveredAt != null)
      throw this.conflict(
        'LOSS_ALREADY_RECOVERED',
        'Cannot cancel a loss whose original unit has already been recovered',
      );
    if (
      order.status === 'IN_TRANSIT' ||
      order.status === 'DELIVERED' ||
      order.status === 'CANCELLED'
    )
      throw this.conflict(
        'LOSS_CANCEL_ORDER_STATE',
        'Cannot cancel loss in the current order status',
      );
    if (
      db.OrderClaim &&
      (await db.OrderClaim.where({ orderId: order.id, releasedAt: null }).first())
    )
      throw this.conflict(
        'LOSS_CANCEL_ACTIVE_CLAIM',
        'Cannot cancel loss while the order has an active route claim',
      );
    if (db.OrderPickup && (await db.OrderPickup.where({ orderId: order.id }).first()))
      throw this.conflict(
        'LOSS_CANCEL_PICKUP_EXISTS',
        'Cannot cancel loss because an agreed store pickup exists for this order',
      );

    let stock: string | null = null;
    if (loss.replacementPreparedAt != null) {
      stock = String(await this.move(tx, loss, 'REPLACEMENT_CANCEL_IN', actorId));
    }

    const cancelledAt = nowInstant();
    await db.OrderItemLoss.where({ id: loss.id, cancelledAt: null }).update({
      cancelledAt,
      cancelledById: actorId,
      cancelReason: dto.reason.trim(),
      cancelRequestId: dto.requestId,
    });

    const unitRecoveries = db.RouteUnitRecovery
      ? await db.RouteUnitRecovery.where({ orderId: order.id }).all()
      : [];
    const activeLosses = await db.OrderItemLoss.where({
      orderId: order.id,
      cancelledAt: null,
    }).all();
    const hasUnresolvedRecovery = unitRecoveries.some((unit) => {
      if (unit.recoveredAt != null) return false;
      return !activeLosses.some(
        (active) =>
          active.orderItemId === unit.orderItemId &&
          active.unitNumber === unit.unitNumber &&
          active.replacementPreparedAt != null,
      );
    });
    const hadClearedAttempt =
      !order.requiresAdministrativeReview &&
      (loss.attemptId != null || (await this.hasFailedAttempt(tx, order.id)));
    const nextReview =
      Boolean(order.requiresAdministrativeReview) ||
      hasUnresolvedRecovery ||
      hadClearedAttempt;
    const reviewFlagChanged = nextReview && !order.requiresAdministrativeReview;
    if (reviewFlagChanged) {
      await db.Order.where({ id: order.id }).update({
        requiresAdministrativeReview: true,
      });
      changes.push({
        type: 'order.status.updated',
        orderId: order.id,
        status: order.status,
        requiresAdministrativeReview: true,
      });
    }

    const row = await audit(null, { lossId: loss.id, stock }, order.id);
    changes.push({
      type: 'dispatch.incident.updated',
      orderId: order.id,
      action: 'LOSS_CANCEL',
      requiresAdministrativeReview: nextReview,
    });
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
        cancelledAt: loss.cancelledAt?.toString() ?? null,
        cancelledById: loss.cancelledById ?? null,
        cancelReason: loss.cancelReason ?? null,
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
          kind: m.kind as 'REPLACEMENT_OUT' | 'RECOVERY_IN' | 'REPLACEMENT_CANCEL_IN',
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
