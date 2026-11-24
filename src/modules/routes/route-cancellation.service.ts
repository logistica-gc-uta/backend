import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { businessDay, nowInstant } from '../../common/temporal.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { DispatchInterventionDto } from './dto/dispatch-intervention.dto.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { canTransitionRoute, RouteStatus } from './route-lifecycle.policy.js';
import type { RealtimeChange } from '../realtime/realtime.contract.js';

type Transaction = Parameters<
  Parameters<PrismaService['client']['transaction']>[0]
>[0];
type AuditRow = NonNullable<
  Awaited<
    ReturnType<
      PrismaService['client']['orm']['public']['DispatchIntervention']['first']
    >
  >
>;

export type CancellationAudit = (
  routeId: string | null,
  result: Record<string, unknown>,
  orderId: string | null,
) => Promise<AuditRow>;

@Injectable()
export class RouteCancellationService {
  constructor(private readonly availability: RouteAvailabilityService) {}

  private conflict(code: string, message: string): ConflictException {
    return new ConflictException({
      statusCode: 409,
      message,
      error: 'Conflict',
      code,
    });
  }

  async cancel(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
    createAudit: CancellationAudit,
  ): Promise<AuditRow> {
    const db = tx.orm.public;
    const initial = await db.Route.where({ id: dto.routeId! }).first();
    if (!initial) throw new NotFoundException('Route not found');

    // Lock order matches RouteExecutionService.start and assignment: Driver -> Route -> sorted Orders.
    let lockedDriver: Awaited<ReturnType<typeof db.Driver.first>> = null;
    if (initial.driverId) {
      lockedDriver = await db.Driver.where({ id: initial.driverId }).update({
        id: initial.driverId,
      });
      if (!lockedDriver) {
        throw this.conflict(
          'ROUTE_COHERENCE_INVALID',
          'Assigned driver profile not found',
        );
      }
    }

    const route = await db.Route.where({ id: initial.id }).update({
      id: initial.id,
    });
    if (!route) throw new NotFoundException('Route not found');
    if (route.driverId !== initial.driverId) {
      throw this.conflict(
        'ROUTE_DRIVER_CHANGED',
        'Route driver changed; refresh decision',
      );
    }

    if (route.status === RouteStatus.CANCELLED) {
      throw this.conflict(
        'ROUTE_ALREADY_CANCELLED',
        'Route is already cancelled',
      );
    }
    if (route.status === RouteStatus.DRAFT) {
      throw this.conflict(
        'ROUTE_NOT_CANCELLABLE',
        'Only assigned routes before start can be cancelled; use RELEASE_DRAFT for unassigned drafts',
      );
    }
    if (
      route.status === RouteStatus.IN_PROGRESS ||
      route.status === RouteStatus.COMPLETED ||
      route.status === RouteStatus.INTERRUPTED
    ) {
      throw this.conflict(
        'ROUTE_ALREADY_STARTED',
        'Only assigned routes before start can be cancelled',
      );
    }
    if (
      !canTransitionRoute(
        route.status as RouteStatus | null,
        RouteStatus.CANCELLED,
      )
    ) {
      throw this.conflict(
        'ROUTE_NOT_CANCELLABLE',
        'Only assigned routes before start can be cancelled',
      );
    }
    if (!route.driverId || !lockedDriver) {
      throw this.conflict(
        'ROUTE_COHERENCE_INVALID',
        'Assigned route requires a valid driver association',
      );
    }
    if (
      route.startedAt ||
      route.startedById ||
      route.completedAt ||
      route.completedById ||
      route.returnedAt ||
      route.returnedById ||
      route.cancelledAt ||
      route.cancelledById ||
      route.cancelReason
    ) {
      throw this.conflict(
        'ROUTE_COHERENCE_INVALID',
        'Route already has incompatible lifecycle event evidence',
      );
    }
    if (
      db.RouteEmergency &&
      (await db.RouteEmergency.where({ routeId: route.id }).first())
    ) {
      throw this.conflict(
        'ROUTE_COHERENCE_INVALID',
        'Route has an emergency record and cannot be cancelled',
      );
    }

    const activeReservations = await db.DriverReservation.where({
      routeId: route.id,
      releasedAt: null,
    }).all();
    const reservation = activeReservations[0];
    if (
      activeReservations.length !== 1 ||
      !reservation ||
      reservation.driverId !== route.driverId ||
      !reservation.reservedAt
    ) {
      throw this.conflict(
        'ROUTE_COHERENCE_INVALID',
        'Matching active verified driver reservation required',
      );
    }

    const stops = (await db.RouteStop.where({ routeId: route.id }).all()).sort(
      (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id),
    );
    if (
      stops.length < 1 ||
      stops.some(
        (stop, index) =>
          stop.isLegacy ||
          stop.sequence !== index + 1 ||
          stop.outcome !== 'PENDING',
      )
    ) {
      throw this.conflict(
        'ROUTE_COHERENCE_INVALID',
        'At least one verified pending ordered stop required',
      );
    }
    if (db.DeliveryAttempt) {
      for (const stop of stops) {
        const attempts = await db.DeliveryAttempt.where({
          stopId: stop.id,
        }).all();
        if (attempts.length > 0) {
          throw this.conflict(
            'ROUTE_COHERENCE_INVALID',
            'Route with delivery attempts cannot be cancelled',
          );
        }
      }
    }

    const activeClaims = await db.OrderClaim.where({
      routeId: route.id,
      releasedAt: null,
    }).all();
    const stopOrderSet = new Set(stops.map((stop) => stop.orderId));
    if (
      stopOrderSet.size !== stops.length ||
      activeClaims.length !== stops.length ||
      activeClaims.some(
        (claim) => !claim.claimedAt || !stopOrderSet.has(claim.orderId),
      ) ||
      new Set(activeClaims.map((claim) => claim.orderId)).size !== stops.length
    ) {
      throw this.conflict(
        'ROUTE_COHERENCE_INVALID',
        'Matching active order claims required',
      );
    }

    const sortedOrderIds = [...stopOrderSet].sort();
    for (const orderId of sortedOrderIds) {
      const order = await db.Order.where({ id: orderId }).update({
        id: orderId,
      });
      if (
        !order ||
        order.routeId !== route.id ||
        order.status !== 'ASSIGNED' ||
        order.requiresAdministrativeReview
      ) {
        throw this.conflict(
          'ROUTE_COHERENCE_INVALID',
          'All route stops must reference assigned orders without administrative review',
        );
      }
    }

    const pointedOrders = await db.Order.where({ routeId: route.id }).all();
    if (
      pointedOrders.length !== sortedOrderIds.length ||
      pointedOrders.some((order) => !stopOrderSet.has(order.id))
    ) {
      throw this.conflict(
        'ROUTE_COHERENCE_INVALID',
        'Route has incoherent order pointers',
      );
    }

    const cancelledAt = nowInstant();
    const trimmedReason = dto.reason.trim();

    // Persist audit before status/claim/reservation writes so PostgreSQL guards verify same-tx authority.
    const audit = await createAudit(
      route.id,
      {
        routeId: route.id,
        driverId: route.driverId,
        orderIds: sortedOrderIds,
        cancelledAt: cancelledAt.toString(),
        releasedOrderCount: sortedOrderIds.length,
        driverReleased: true,
      },
      null,
    );

    const cancelledRoute = await db.Route.where({
      id: route.id,
      status: 'ASSIGNED',
      driverId: route.driverId,
      startedAt: null,
      completedAt: null,
      returnedAt: null,
      cancelledAt: null,
    }).update({
      status: 'CANCELLED',
      cancelledAt,
      cancelledById: actorId,
      cancelReason: trimmedReason,
    });
    if (!cancelledRoute) {
      throw this.conflict(
        'ROUTE_CONCURRENT_TRANSITION',
        'Route changed during cancellation',
      );
    }

    // Preserve RouteStop rows as historical evidence; release active claims at cancelledAt.
    const sortedClaims = [...activeClaims].sort((a, b) =>
      a.orderId.localeCompare(b.orderId),
    );
    for (const claim of sortedClaims) {
      const releasedClaim = await db.OrderClaim.where({
        id: claim.id,
        routeId: route.id,
        releasedAt: null,
      }).update({ releasedAt: cancelledAt });
      if (!releasedClaim) {
        throw this.conflict(
          'ROUTE_CONCURRENT_TRANSITION',
          'Order claim changed during cancellation',
        );
      }
    }

    // Restore orders to plannable PENDING without commercial cancellation.
    for (const orderId of sortedOrderIds) {
      const restored = await db.Order.where({
        id: orderId,
        routeId: route.id,
        status: 'ASSIGNED',
        requiresAdministrativeReview: false,
      }).update({
        status: 'PENDING',
        routeId: null,
        stopOrder: null,
      });
      if (!restored) {
        throw this.conflict(
          'ROUTE_CONCURRENT_TRANSITION',
          'Order changed during route cancellation',
        );
      }
    }

    const releasedReservation = await db.DriverReservation.where({
      id: reservation.id,
      driverId: route.driverId,
      routeId: route.id,
      releasedAt: null,
    }).update({ releasedAt: cancelledAt });
    if (!releasedReservation) {
      throw this.conflict(
        'ROUTE_CONCURRENT_TRANSITION',
        'Driver reservation changed during cancellation',
      );
    }

    await this.availability.recomputeProjection(
      lockedDriver.id,
      lockedDriver.userId,
      tx,
    );
    const effectiveAvailability = db.DriverAbsence
      ? await this.availability.effective(
          lockedDriver.id,
          tx,
          businessDay(cancelledAt),
        )
      : await this.availability.effective(lockedDriver.id, tx);

    changes.push({
      type: 'route.updated',
      routeId: route.id,
      status: RouteStatus.CANCELLED,
    });
    for (const orderId of sortedOrderIds) {
      changes.push({
        type: 'order.status.updated',
        orderId,
        status: 'PENDING',
        requiresAdministrativeReview: false,
      });
    }
    changes.push({
      type: 'driver.availability.updated',
      driverId: lockedDriver.id,
      available: effectiveAvailability.isAvailable,
    });

    return audit;
  }
}
