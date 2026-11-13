import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { businessDay, nowInstant } from '../../common/temporal.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import type { DispatchInterventionDto } from './dto/dispatch-intervention.dto.js';
import {
  RouteEmergencyCountsDto,
  RouteEmergencyDetailDto,
  RouteEmergencySummaryDto,
  RouteEmergencyUnitDto,
  type RouteEmergencyUnitStatus,
} from './dto/route-emergency.dto.js';
import type { RealtimeChange } from '../realtime/realtime.contract.js';

type Transaction = Parameters<Parameters<PrismaService['client']['transaction']>[0]>[0];
type AuditRow = NonNullable<
  Awaited<ReturnType<PrismaService['client']['orm']['public']['DispatchIntervention']['first']>>
>;
type RouteEmergencyRow = NonNullable<
  Awaited<ReturnType<PrismaService['client']['orm']['public']['RouteEmergency']['first']>>
>;
type RouteRow = NonNullable<
  Awaited<ReturnType<PrismaService['client']['orm']['public']['Route']['first']>>
>;
type RouteUnitRecoveryRow = NonNullable<
  Awaited<ReturnType<PrismaService['client']['orm']['public']['RouteUnitRecovery']['first']>>
>;
type OrderItemLossRow = NonNullable<
  Awaited<ReturnType<PrismaService['client']['orm']['public']['OrderItemLoss']['first']>>
>;

export type EmergencyAudit = (
  routeId: string | null,
  result: Record<string, unknown>,
  orderId: string | null,
) => Promise<AuditRow>;

@Injectable()
export class DispatchEmergencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: RouteAvailabilityService,
  ) {}

  private conflict(code: string, message: string): ConflictException {
    return new ConflictException({ statusCode: 409, message, error: 'Conflict', code });
  }

  async handle(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    createAudit: EmergencyAudit,
  ): Promise<AuditRow> {
    if (dto.action === 'EMERGENCY_DECLARE') {
      return this.declareEmergency(tx, dto, actorId, changes, createAudit);
    }
    if (dto.action === 'UNIT_RECOVERY_CONFIRM') {
      return this.confirmUnitRecovery(tx, dto, actorId, changes, createAudit);
    }
    if (dto.action === 'EMERGENCY_CLOSE') {
      return this.closeEmergency(tx, dto, actorId, changes, createAudit);
    }
    if (dto.action === 'EMERGENCY_DRIVER_RELEASE') {
      return this.releaseDriver(tx, dto, actorId, changes, createAudit);
    }
    return this.requeueOrder(tx, dto, actorId, changes, createAudit);
  }

  async declareEmergency(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    createAudit: EmergencyAudit,
  ): Promise<AuditRow> {
    const db = tx.orm.public;
    const initialRoute = await db.Route.where({ id: dto.routeId! }).first();
    if (!initialRoute) throw new NotFoundException('Route not found');
    if (initialRoute.driverId) {
      await db.Driver.where({ id: initialRoute.driverId }).update({ id: initialRoute.driverId });
    }
    const route = await db.Route.where({ id: initialRoute.id }).update({ id: initialRoute.id });
    if (!route) throw new NotFoundException('Route not found');
    const existingEmergency = await db.RouteEmergency.where({ routeId: route.id }).first();
    if (existingEmergency) {
      throw this.conflict('EMERGENCY_ALREADY_DECLARED', 'Route already has a declared emergency');
    }
    if (
      route.status !== 'IN_PROGRESS' ||
      !route.startedAt ||
      !route.startedById ||
      !route.driverId
    ) {
      throw new ConflictException('Active IN_PROGRESS route with assigned driver required');
    }
    if (route.completedAt || route.completedById || route.returnedAt || route.returnedById) {
      throw new ConflictException('Route already completed or returned');
    }
    const reservation = await db.DriverReservation.where({
      routeId: route.id,
      driverId: route.driverId,
      releasedAt: null,
    }).first();
    if (!reservation?.reservedAt) {
      throw new ConflictException('Matching active driver reservation required');
    }

    const stops = (await db.RouteStop.where({ routeId: route.id }).all()).sort(
      (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id),
    );
    const completedStops = stops.filter(
      (s) => s.outcome === 'SUCCESSFUL' || s.outcome === 'FAILED',
    );
    const pendingStops = stops.filter((s) => !s.outcome || s.outcome === 'PENDING');

    const pendingOrderIds = [...new Set(pendingStops.map((s) => s.orderId))].sort();
    for (const orderId of pendingOrderIds) {
      if (!(await db.Order.where({ id: orderId }).update({ id: orderId }))) {
        throw new NotFoundException('Order not found');
      }
    }

    const pendingItemsByStop = new Map<
      string,
      Array<{ id: string; productId: string; quantity: number }>
    >();
    let unitRecoveryCount = 0;
    for (const stop of pendingStops) {
      const items = (await db.OrderItem.where({ orderId: stop.orderId }).all()).sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      pendingItemsByStop.set(stop.id, items);
      for (const item of items) {
        unitRecoveryCount += item.quantity;
      }
    }

    const declaredAt = nowInstant();
    const interrupted = await db.Route.where({
      id: route.id,
      status: 'IN_PROGRESS',
    }).update({ status: 'INTERRUPTED' });
    if (!interrupted) {
      throw new ConflictException('Route changed during emergency declaration');
    }

    const emergency = await db.RouteEmergency.create({
      routeId: route.id,
      reason: dto.reason.trim(),
      declaredAt,
      declaredById: actorId,
      declarationRequestId: dto.requestId,
      closedAt: null,
      closedById: null,
      closeReason: null,
      closeRequestId: null,
    });

    const detachedOrderIds = pendingStops.map((s) => s.orderId);
    const preservedCompletedStopIds = completedStops.map((s) => s.id);

    // Audit and RouteEmergency must exist in this transaction before OrderClaim release so
    // PostgreSQL t1e_claim_history_guard accepts the emergency claim release at declaredAt.
    const audit = await createAudit(
      route.id,
      {
        emergencyId: emergency.id,
        routeId: route.id,
        detachedOrderIds,
        unitRecoveryCount,
        preservedCompletedStopIds,
      },
      null,
    );

    const activeClaims = await db.OrderClaim.where({
      routeId: route.id,
      releasedAt: null,
    }).all();
    for (const claim of activeClaims) {
      await db.OrderClaim.where({ id: claim.id, releasedAt: null }).update({
        releasedAt: declaredAt,
      });
    }

    for (const stop of pendingStops) {
      const detached = await db.Order.where({ id: stop.orderId }).update({
        status: 'PENDING',
        routeId: null,
        stopOrder: null,
        requiresAdministrativeReview: true,
      });
      if (!detached) {
        throw new ConflictException('Order changed during emergency declaration');
      }
      const items = pendingItemsByStop.get(stop.id) ?? [];
      for (const item of items) {
        for (let unitNumber = 1; unitNumber <= item.quantity; unitNumber++) {
          await db.RouteUnitRecovery.create({
            emergencyId: emergency.id,
            routeId: route.id,
            stopId: stop.id,
            orderId: stop.orderId,
            orderItemId: item.id,
            unitNumber,
            productId: item.productId,
            recoveredAt: null,
            recoveredById: null,
            recoveryRequestId: null,
          });
        }
      }
    }

    changes.push({ type: 'route.updated', routeId: route.id, status: 'INTERRUPTED' });
    for (const orderId of detachedOrderIds) {
      changes.push({
        type: 'order.status.updated',
        orderId,
        status: 'PENDING',
        requiresAdministrativeReview: true,
      });
    }
    changes.push({
      type: 'dispatch.incident.updated',
      routeId: route.id,
      action: 'EMERGENCY_DECLARE',
    });

    return audit;
  }

  async confirmUnitRecovery(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    createAudit: EmergencyAudit,
  ): Promise<AuditRow> {
    const db = tx.orm.public;
    const found = await db.RouteUnitRecovery.where({ id: dto.recoveryId! }).first();
    if (!found) throw new NotFoundException('Route unit recovery not found');

    const order = await db.Order.where({ id: found.orderId }).update({ id: found.orderId });
    if (!order) throw new NotFoundException('Order not found');

    const recovery = await db.RouteUnitRecovery.where({ id: found.id }).first();
    if (!recovery) throw new NotFoundException('Route unit recovery not found');
    if (recovery.recoveredAt != null) {
      throw this.conflict('UNIT_ALREADY_RECOVERED', 'Unit recovery already confirmed');
    }

    const activeLoss = await db.OrderItemLoss.where({
      orderItemId: recovery.orderItemId,
      unitNumber: recovery.unitNumber,
      cancelledAt: null,
    }).first();
    if (activeLoss) {
      throw this.conflict(
        'UNIT_HAS_ACTIVE_LOSS',
        'Unit already has an active declared loss and cannot be confirmed recovered',
      );
    }

    const recoveredAt = nowInstant();
    const updated = await db.RouteUnitRecovery.where({
      id: recovery.id,
      recoveredAt: null,
    }).update({
      recoveredAt,
      recoveredById: actorId,
      recoveryRequestId: dto.requestId,
    });
    if (!updated) {
      throw new ConflictException('Unit recovery changed concurrently');
    }

    const orderAllUnitsResolved = await this.isOrderRecoveryResolved(tx, recovery.orderId);
    const audit = await createAudit(
      recovery.routeId,
      {
        recoveryId: recovery.id,
        emergencyId: recovery.emergencyId,
        routeId: recovery.routeId,
        orderId: recovery.orderId,
        orderItemId: recovery.orderItemId,
        unitNumber: recovery.unitNumber,
        recoveredAt: recoveredAt.toString(),
        orderAllUnitsResolved,
      },
      recovery.orderId,
    );

    changes.push({
      type: 'dispatch.incident.updated',
      orderId: recovery.orderId,
      action: 'UNIT_RECOVERY_CONFIRM',
      requiresAdministrativeReview: order.requiresAdministrativeReview,
    });

    return audit;
  }

  async closeEmergency(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    createAudit: EmergencyAudit,
  ): Promise<AuditRow> {
    const db = tx.orm.public;
    const route = await db.Route.where({ id: dto.routeId! }).update({ id: dto.routeId! });
    if (!route) throw new NotFoundException('Route not found');

    const emergency = await db.RouteEmergency.where({ routeId: route.id }).update({
      routeId: route.id,
    });
    if (!emergency) throw new NotFoundException('Route emergency not found');
    if (emergency.closedAt != null) {
      throw this.conflict('EMERGENCY_ALREADY_CLOSED', 'Route emergency is already closed');
    }

    const closedAt = nowInstant();
    const closed = await db.RouteEmergency.where({
      id: emergency.id,
      closedAt: null,
    }).update({
      closedAt,
      closedById: actorId,
      closeReason: dto.reason.trim(),
      closeRequestId: dto.requestId,
    });
    if (!closed) {
      throw new ConflictException('Route emergency changed concurrently');
    }

    const audit = await createAudit(
      route.id,
      {
        emergencyId: emergency.id,
        routeId: route.id,
        closedAt: closedAt.toString(),
      },
      null,
    );

    changes.push({
      type: 'dispatch.incident.updated',
      routeId: route.id,
      action: 'EMERGENCY_CLOSE',
    });

    return audit;
  }

  async releaseDriver(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    createAudit: EmergencyAudit,
  ): Promise<AuditRow> {
    const db = tx.orm.public;
    const initialRoute = await db.Route.where({ id: dto.routeId! }).first();
    if (!initialRoute) throw new NotFoundException('Route not found');
    if (
      initialRoute.status !== 'INTERRUPTED' ||
      !initialRoute.startedAt ||
      !initialRoute.startedById ||
      !initialRoute.driverId
    ) {
      throw new ConflictException('Genuine started INTERRUPTED route with assigned driver required');
    }

    const driver = await db.Driver.where({ id: initialRoute.driverId }).update({
      id: initialRoute.driverId,
    });
    if (!driver) throw new NotFoundException('Driver not found');

    const route = await db.Route.where({ id: initialRoute.id }).update({ id: initialRoute.id });
    if (!route) throw new NotFoundException('Route not found');
    if (
      route.status !== 'INTERRUPTED' ||
      !route.startedAt ||
      !route.startedById ||
      route.driverId !== driver.id
    ) {
      throw new ConflictException('Route changed before driver release');
    }
    if (route.returnedAt != null || route.returnedById != null) {
      throw this.conflict('DRIVER_ALREADY_RELEASED', 'Driver return or release already recorded');
    }

    const reservation = await db.DriverReservation.where({
      routeId: route.id,
      driverId: driver.id,
      releasedAt: null,
    }).first();
    if (!reservation?.reservedAt) {
      throw new ConflictException('Matching active driver reservation required');
    }

    const returnedAt = nowInstant();
    // Route.returnedAt must be written before DriverReservation.releasedAt for t1e_reservation_history_guard.
    const returned = await db.Route.where({
      id: route.id,
      status: 'INTERRUPTED',
      returnedAt: null,
      returnedById: null,
    }).update({
      returnedAt,
      returnedById: actorId,
    });
    if (!returned) {
      throw new ConflictException('Concurrent driver return or release conflict');
    }

    const released = await db.DriverReservation.where({
      id: reservation.id,
      releasedAt: null,
    }).update({ releasedAt: returnedAt });
    if (!released) {
      throw new ConflictException('Driver reservation changed during release');
    }

    const availability = await this.availability.recomputeProjection(driver.id, driver.userId, tx);
    const today = await this.availability.effective(driver.id, tx, businessDay(returnedAt));

    const audit = await createAudit(
      route.id,
      {
        routeId: route.id,
        driverId: driver.id,
        reservationId: reservation.id,
        returnedAt: returnedAt.toString(),
        driverAvailable: availability.isAvailable,
      },
      null,
    );

    changes.push(
      {
        type: 'route.updated',
        routeId: route.id,
        status: 'INTERRUPTED',
      },
      {
        type: 'driver.availability.updated',
        driverId: driver.id,
        available: today.isAvailable,
      },
      {
        type: 'dispatch.incident.updated',
        routeId: route.id,
        action: 'EMERGENCY_DRIVER_RELEASE',
      },
    );

    return audit;
  }

  async requeueOrder(
    tx: Transaction,
    dto: DispatchInterventionDto,
    _actorId: string,
    changes: RealtimeChange[],
    createAudit: EmergencyAudit,
  ): Promise<AuditRow> {
    const db = tx.orm.public;
    const order = await db.Order.where({ id: dto.orderId! }).update({ id: dto.orderId! });
    if (!order) throw new NotFoundException('Order not found');

    const emergency = await db.RouteEmergency.where({ id: dto.emergencyId! }).first();
    if (!emergency) throw new NotFoundException('Route emergency not found');

    if (
      order.status !== 'PENDING' ||
      !order.requiresAdministrativeReview ||
      order.routeId !== null
    ) {
      throw new ConflictException(
        'Order must be PENDING with administrative review and detached from routes to requeue',
      );
    }

    const activeClaim = await db.OrderClaim.where({
      orderId: order.id,
      releasedAt: null,
    }).first();
    if (activeClaim) {
      throw new ConflictException('Order still has an active route claim');
    }

    const pickup = await db.OrderPickup.where({ orderId: order.id }).first();
    if (pickup) {
      throw new ConflictException('Order with an agreed store pickup cannot be requeued');
    }

    const emergencyUnits = await db.RouteUnitRecovery.where({
      emergencyId: emergency.id,
      orderId: order.id,
    }).all();
    if (emergencyUnits.length === 0) {
      throw new ConflictException('Order does not belong to the specified route emergency');
    }

    const stops = await db.RouteStop.where({ orderId: order.id }).all();
    for (const stop of stops) {
      const failedAttempts = await db.DeliveryAttempt.where({
        stopId: stop.id,
        outcome: 'FAILED',
      }).all();
      if (
        failedAttempts.some(
          (attempt) =>
            Temporal.Instant.compare(attempt.recordedAt, emergency.declaredAt) >= 0,
        )
      ) {
        throw new ConflictException(
          'Order has a failed delivery attempt at or after the emergency declaration',
        );
      }
    }

    if (!(await this.isOrderRecoveryResolved(tx, order.id))) {
      throw this.conflict(
        'RECOVERY_PENDING',
        'Order has unrecovered units or pending replacements that must be resolved before requeue',
      );
    }

    // Audit must be created before Order.requiresAdministrativeReview becomes false for dispatch_review_resolution_guard.
    const audit = await createAudit(
      emergency.routeId,
      {
        emergencyId: emergency.id,
        routeId: emergency.routeId,
        orderId: order.id,
      },
      order.id,
    );

    const requeued = await db.Order.where({
      id: order.id,
      status: 'PENDING',
      requiresAdministrativeReview: true,
      routeId: null,
    }).update({
      requiresAdministrativeReview: false,
      stopOrder: null,
      routeId: null,
    });
    if (!requeued) {
      throw new ConflictException('Order changed during emergency requeue');
    }

    changes.push(
      {
        type: 'order.status.updated',
        orderId: order.id,
        status: 'PENDING',
        requiresAdministrativeReview: false,
      },
      {
        type: 'dispatch.incident.updated',
        orderId: order.id,
        action: 'EMERGENCY_REQUEUE',
        requiresAdministrativeReview: false,
      },
    );

    return audit;
  }

  async isOrderRecoveryResolved(
    tx: Pick<Transaction, 'orm'>,
    orderId: string,
  ): Promise<boolean> {
    const db = tx.orm.public;
    const units = db.RouteUnitRecovery
      ? await db.RouteUnitRecovery.where({ orderId }).all()
      : [];
    if (units.length === 0) return true;
    const activeLosses = db.OrderItemLoss
      ? await db.OrderItemLoss.where({
          orderId,
          cancelledAt: null,
        }).all()
      : [];
    return units.every((unit) => {
      if (unit.recoveredAt !== null) return true;
      return activeLosses.some(
        (loss) =>
          loss.orderItemId === unit.orderItemId &&
          loss.unitNumber === unit.unitNumber &&
          loss.replacementPreparedAt !== null,
      );
    });
  }

  async listEmergencies(): Promise<RouteEmergencySummaryDto[]> {
    const db = this.prisma.client.orm.public;
    const emergencies = (await db.RouteEmergency.all()).sort(
      (a, b) => Temporal.Instant.compare(b.declaredAt, a.declaredAt) || b.id.localeCompare(a.id),
    );
    const summaries: RouteEmergencySummaryDto[] = [];
    for (const emergency of emergencies) {
      const route = await db.Route.where({ id: emergency.routeId }).first();
      const detail = await this.buildEmergencyDetail(emergency, route);
      summaries.push({
        id: detail.id,
        routeId: detail.routeId,
        reason: detail.reason,
        declaredAt: detail.declaredAt,
        declaredById: detail.declaredById,
        closedAt: detail.closedAt,
        closedById: detail.closedById,
        closeReason: detail.closeReason,
        driverId: detail.driverId,
        returnedAt: detail.returnedAt,
        returnedById: detail.returnedById,
        counts: detail.counts,
        pendingUnits: detail.pendingUnits,
      });
    }
    return summaries;
  }

  async emergencyDetail(routeId: string): Promise<RouteEmergencyDetailDto> {
    const db = this.prisma.client.orm.public;
    const route = await db.Route.where({ id: routeId }).first();
    if (!route) throw new NotFoundException('Route not found');
    const emergency = await db.RouteEmergency.where({ routeId }).first();
    if (!emergency) throw new NotFoundException('Route emergency not found');
    return this.buildEmergencyDetail(emergency, route);
  }

  private async buildEmergencyDetail(
    emergency: RouteEmergencyRow,
    route: RouteRow | null,
  ): Promise<RouteEmergencyDetailDto> {
    const db = this.prisma.client.orm.public;
    const rawUnits = await db.RouteUnitRecovery.where({ emergencyId: emergency.id }).all();
    const sortedUnits = [...rawUnits].sort(
      (a, b) =>
        a.orderId.localeCompare(b.orderId) ||
        a.orderItemId.localeCompare(b.orderItemId) ||
        a.unitNumber - b.unitNumber,
    );

    const activeLossesByOrder = new Map<string, OrderItemLossRow[]>();
    for (const orderId of new Set(sortedUnits.map((u) => u.orderId))) {
      activeLossesByOrder.set(
        orderId,
        await db.OrderItemLoss.where({ orderId, cancelledAt: null }).all(),
      );
    }

    const units: RouteEmergencyUnitDto[] = sortedUnits.map((unit) => {
      const activeLoss = (activeLossesByOrder.get(unit.orderId) ?? []).find(
        (loss) =>
          loss.orderItemId === unit.orderItemId && loss.unitNumber === unit.unitNumber,
      );
      return this.projectUnit(unit, activeLoss);
    });

    const counts: RouteEmergencyCountsDto = {
      totalUnits: units.length,
      recoveredUnits: units.filter((u) => u.recoveredAt !== null).length,
      lostPreparedUnits: units.filter(
        (u) => u.recoveredAt === null && u.lossId !== null && u.replacementPreparedAt !== null,
      ).length,
      lostPendingUnits: units.filter(
        (u) => u.recoveredAt === null && u.lossId !== null && u.replacementPreparedAt === null,
      ).length,
      pendingUnits: units.filter((u) => u.recoveredAt === null && u.lossId === null).length,
    };

    return {
      id: emergency.id,
      routeId: emergency.routeId,
      reason: emergency.reason,
      declaredAt: emergency.declaredAt.toString(),
      declaredById: emergency.declaredById,
      closedAt: emergency.closedAt?.toString() ?? null,
      closedById: emergency.closedById ?? null,
      closeReason: emergency.closeReason ?? null,
      driverId: route?.driverId ?? null,
      returnedAt: route?.returnedAt?.toString() ?? null,
      returnedById: route?.returnedById ?? null,
      counts,
      pendingUnits: units.filter((u) => !u.resolved),
      units,
    };
  }

  private projectUnit(
    unit: RouteUnitRecoveryRow,
    activeLoss?: OrderItemLossRow,
  ): RouteEmergencyUnitDto {
    const recoveredAt = unit.recoveredAt?.toString() ?? null;
    const lossId = activeLoss?.id ?? null;
    const replacementPreparedAt = activeLoss?.replacementPreparedAt?.toString() ?? null;
    const lossRecoveredAt = activeLoss?.recoveredAt?.toString() ?? null;
    const resolved = Boolean(recoveredAt || replacementPreparedAt);
    const status: RouteEmergencyUnitStatus = recoveredAt
      ? 'RECOVERED'
      : activeLoss
        ? replacementPreparedAt
          ? 'LOST_PREPARED'
          : 'LOST_PENDING'
        : 'PENDING';

    return {
      id: unit.id,
      emergencyId: unit.emergencyId,
      routeId: unit.routeId,
      stopId: unit.stopId,
      orderId: unit.orderId,
      orderItemId: unit.orderItemId,
      unitNumber: unit.unitNumber,
      productId: unit.productId,
      status,
      resolved,
      recoveredAt,
      recoveredById: unit.recoveredById ?? null,
      lossId,
      replacementPreparedAt,
      lossRecoveredAt,
    };
  }
}
