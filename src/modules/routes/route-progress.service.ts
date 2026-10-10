import { isDeepStrictEqual } from 'node:util';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { nowInstant } from '../../common/temporal.util.js';
import { OrderStatus } from '../orders/dto/update-order-status.dto.js';
import { validateOrderTransition } from '../orders/order-status.policy.js';
import {
  FailedVisitReason,
  RecordFailedVisitDto,
} from './dto/record-failed-visit.dto.js';
import {
  canCompleteRoute,
  RouteStatus,
  VisitOutcome,
} from './route-lifecycle.policy.js';

type Transaction = Parameters<
  Parameters<PrismaService['client']['transaction']>[0]
>[0];

@Injectable()
export class RouteProgressService {
  constructor(private readonly prisma: PrismaService) {}

  private async lock(tx: Transaction, routeId: string, actorId: string) {
    const driver = await tx.orm.public.Driver.where({
      userId: actorId,
    }).first();
    if (!driver) throw new ForbiddenException('Driver profile required');
    const locked = await tx.orm.public.Driver.where({
      id: driver.id,
      userId: actorId,
    }).update({ userId: actorId });
    if (!locked)
      throw new ForbiddenException('Driver profile ownership changed');
    const lockedRoute = await tx.orm.public.Route.where({
      id: routeId,
      driverId: driver.id,
    }).update({ driverId: driver.id });
    const route = await tx.orm.public.Route.where({ id: routeId }).first();
    if (!route) throw new NotFoundException('Route not found');
    if (route.driverId !== driver.id)
      throw new ForbiddenException('No tiene permisos para modificar pedidos de otra ruta');
    if (!lockedRoute)
      throw new ConflictException(
        'Route ownership changed before lock acquisition',
      );
    return { route, driver };
  }

  private async active(
    tx: Transaction,
    route: Awaited<ReturnType<RouteProgressService['lock']>>['route'],
  ) {
    if (
      route.status !== 'IN_PROGRESS' ||
      !route.startedAt ||
      !route.startedById ||
      route.completedAt ||
      route.returnedAt
    )
      throw new ConflictException('Verified route in progress required');
    const reservation = await tx.orm.public.DriverReservation.where({
      routeId: route.id,
      driverId: route.driverId!,
      releasedAt: null,
    }).first();
    if (!reservation?.reservedAt)
      throw new ConflictException('Active driver reservation required');
  }

  private async visit(tx: Transaction, routeId: string, stopId: string) {
    const stop = await tx.orm.public.RouteStop.where({
      id: stopId,
      routeId,
    }).first();
    if (!stop) throw new NotFoundException('Route stop not found');
    if (
      stop.isLegacy ||
      !stop.sequence ||
      stop.sequence < 1 ||
      stop.sequence > 4 ||
      stop.outcome !== 'PENDING'
    )
      throw new ConflictException('Verified pending visit required');
    const claim = await tx.orm.public.OrderClaim.where({
      routeId,
      orderId: stop.orderId,
      releasedAt: null,
    }).first();
    if (!claim?.claimedAt)
      throw new ConflictException('Matching active order claim required');
    const order = await tx.orm.public.Order.where({ id: stop.orderId }).first();
    if (
      !order ||
      order.routeId !== routeId ||
      !['ASSIGNED', 'IN_TRANSIT'].includes(order.status) ||
      order.requiresAdministrativeReview
    )
      throw new ConflictException('Order is not operationally eligible');
    return { stop, order };
  }

  private response(
    attempt: Awaited<
      ReturnType<Transaction['orm']['public']['DeliveryAttempt']['create']>
    >,
  ) {
    return {
      id: attempt.id,
      stopId: attempt.stopId,
      driverId: attempt.driverId,
      recordedAt: attempt.recordedAt.toString(),
      outcome: attempt.outcome,
      failureReason: attempt.failureReason,
      context: (attempt.context as { description: string }).description,
      requestId: attempt.idempotencyKey,
    };
  }

  async fail(
    routeId: string,
    stopId: string,
    actorId: string,
    dto: RecordFailedVisitDto,
  ) {
    return this.prisma.client.transaction(async (tx) => {
      const { route, driver } = await this.lock(tx, routeId, actorId);
      const stop = await tx.orm.public.RouteStop.where({
        id: stopId,
        routeId,
      }).first();
      if (!stop) throw new NotFoundException('Route stop not found');
      const payload = { actorId, reason: dto.reason, context: dto.context };
      const existing = await tx.orm.public.DeliveryAttempt.where({
        stopId,
        idempotencyKey: dto.requestId,
      }).first();
      if (existing) {
        if (
          existing.driverId !== driver.id ||
          existing.outcome !== 'FAILED' ||
          !isDeepStrictEqual(existing.requestPayload, payload)
        )
          throw new ConflictException(
            'Idempotency key conflicts with persisted attempt',
          );
        if (!['IN_PROGRESS', 'COMPLETED'].includes(route.status ?? ''))
          throw new ConflictException('Invalid replay lifecycle');
        return this.response(existing);
      }
      await this.active(tx, route);
      const { order } = await this.visit(tx, routeId, stopId);
      const attempt = await tx.orm.public.DeliveryAttempt.create({
        stopId,
        driverId: driver.id,
        recordedAt: nowInstant(),
        outcome: 'FAILED',
        failureReason: dto.reason,
        context: { description: dto.context },
        idempotencyKey: dto.requestId,
        requestPayload: payload,
      });
      const resolved = await tx.orm.public.RouteStop.where({
        id: stopId,
        outcome: 'PENDING',
      }).update({ outcome: 'FAILED' });
      const flagged = await tx.orm.public.Order.where({
        id: order.id,
        routeId,
        status: order.status,
        requiresAdministrativeReview: false,
      }).update({ requiresAdministrativeReview: true });
      if (!resolved || !flagged)
        throw new ConflictException('Concurrent visit resolution');
      return this.response(attempt);
    });
  }

  async updateOrder(orderId: string, actorId: string, status: OrderStatus) {
    return this.prisma.client.transaction(async (tx) => {
      const initial = await tx.orm.public.Order.where({ id: orderId }).first();
      if (!initial) throw new NotFoundException('Order not found');
      if (!initial.routeId)
        throw new ForbiddenException('El pedido no está asignado a ninguna ruta');
      const { route, driver } = await this.lock(tx, initial.routeId, actorId);
      const stop = await tx.orm.public.RouteStop.where({
        routeId: route.id,
        orderId,
      }).first();
      if (!stop) throw new ConflictException('Stable route stop required');
      const order = await tx.orm.public.Order.where({ id: orderId }).first();
      if (!order || order.routeId !== route.id)
        throw new ConflictException('Order assignment changed');
      const key = `delivery:${stop.id}`;
      if (status === OrderStatus.DELIVERED) {
        const attempt = await tx.orm.public.DeliveryAttempt.where({
          stopId: stop.id,
          idempotencyKey: key,
        }).first();
        if (attempt) {
          if (
            attempt.driverId !== driver.id ||
            attempt.outcome !== 'SUCCESSFUL' ||
            stop.outcome !== 'SUCCESSFUL' ||
            order.status !== 'DELIVERED' ||
            !isDeepStrictEqual(attempt.requestPayload, { actorId, status })
          )
            throw new ConflictException(
              'Delivery replay conflicts with persisted evidence',
            );
          if (!['IN_PROGRESS', 'COMPLETED'].includes(route.status ?? ''))
            throw new ConflictException('Invalid replay lifecycle');
          return order;
        }
      }
      await this.active(tx, route);
      await this.visit(tx, route.id, stop.id);
      if (![OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED].includes(status))
        throw new ForbiddenException('Driver may only progress delivery');
      if (order.status === status && status === OrderStatus.IN_TRANSIT)
        return order;
      validateOrderTransition(order.status as OrderStatus, status);
      const updated = await tx.orm.public.Order.where({
        id: orderId,
        routeId: route.id,
        requiresAdministrativeReview: false,
        status: order.status,
      }).update({ status });
      if (!updated)
        throw new ConflictException('Concurrent commercial transition');
      if (status === OrderStatus.DELIVERED) {
        await tx.orm.public.DeliveryAttempt.create({
          stopId: stop.id,
          driverId: driver.id,
          recordedAt: nowInstant(),
          outcome: 'SUCCESSFUL',
          failureReason: null,
          context: {},
          idempotencyKey: key,
          requestPayload: { actorId, status },
        });
        const resolved = await tx.orm.public.RouteStop.where({
          id: stop.id,
          outcome: 'PENDING',
        }).update({ outcome: 'SUCCESSFUL' });
        if (!resolved)
          throw new ConflictException('Concurrent visit resolution');
      }
      return updated;
    });
  }

  async cancelOrder(orderId: string) {
    return this.prisma.client.transaction(async (tx) => {
      const initial = await tx.orm.public.Order.where({ id: orderId }).first();
      if (!initial) throw new NotFoundException('Order not found');
      if (initial.routeId) {
        const route = await tx.orm.public.Route.where({
          id: initial.routeId,
        }).first();
        if (!route?.driverId)
          throw new ConflictException('Unverified operational association');
        await tx.orm.public.Driver.where({ id: route.driverId }).update({
          id: route.driverId,
        });
        const lockedRoute = await tx.orm.public.Route.where({
          id: route.id,
          driverId: route.driverId,
        }).update({
          driverId: route.driverId,
        });
        if (!lockedRoute)
          throw new ConflictException('Operational ownership changed');
      }
      // Serialize commercial cancellation with DRAFT claims even without a route pointer.
      // Driver -> Route (when present) -> Order matches assignment lock ordering.
      const lockedOrder = await tx.orm.public.Order.where({
        id: orderId,
      }).update({ id: orderId });
      if (!lockedOrder) throw new ConflictException('Order identity changed');
      const order = await tx.orm.public.Order.where({ id: orderId }).first();
      if (!order || order.routeId !== initial.routeId)
        throw new ConflictException('Order assignment changed');
      const claim = await tx.orm.public.OrderClaim.where({
        orderId,
        releasedAt: null,
      }).first();
      const history = await tx.orm.public.RouteStop.where({ orderId }).all();
      if (claim || history.length > 0)
        throw new ConflictException(
          'Operational visit history requires administrative reconciliation',
        );
      validateOrderTransition(
        order.status as OrderStatus,
        OrderStatus.CANCELLED,
      );
      const updated = await tx.orm.public.Order.where({
        id: orderId,
        status: order.status,
      }).update({ status: 'CANCELLED' });
      if (!updated)
        throw new ConflictException('Concurrent commercial transition');
      return updated;
    });
  }

  async complete(routeId: string, actorId: string) {
    return this.prisma.client.transaction(async (tx) => {
      const { route, driver } = await this.lock(tx, routeId, actorId);
      if (route.status === 'COMPLETED') {
        if (!route.completedAt || route.completedById !== actorId)
          throw new ConflictException('Unverified completion audit');
        return {
          id: route.id,
          status: RouteStatus.COMPLETED,
          completedAt: route.completedAt.toString(),
        };
      }
      await this.active(tx, route);
      const stops = await tx.orm.public.RouteStop.where({ routeId }).all();
      const ordered = [...stops].sort(
        (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
      );
      if (
        !canCompleteRoute(
          route.status as RouteStatus,
          ordered.map((s) => s.outcome as VisitOutcome | null),
        ) ||
        ordered.some((s, i) => s.isLegacy || s.sequence !== i + 1)
      )
        throw new ConflictException(
          'One to four resolved verified visits required',
        );
      const claims = await tx.orm.public.OrderClaim.where({
        routeId,
        releasedAt: null,
      }).all();
      if (
        claims.length !== stops.length ||
        claims.some(
          (c) => !c.claimedAt || !stops.some((s) => s.orderId === c.orderId),
        )
      )
        throw new ConflictException('Matching active order claims required');
      for (const stop of stops) {
        const attempts = await tx.orm.public.DeliveryAttempt.where({
          stopId: stop.id,
        }).all();
        const order = await tx.orm.public.Order.where({
          id: stop.orderId,
        }).first();
        if (
          attempts.length !== 1 ||
          attempts[0].driverId !== driver.id ||
          !attempts[0].recordedAt ||
          attempts[0].outcome !== stop.outcome ||
          !order ||
          order.routeId !== routeId ||
          (stop.outcome === 'SUCCESSFUL'
            ? order.status !== 'DELIVERED' || attempts[0].failureReason !== null
            : !order.requiresAdministrativeReview ||
              !['ASSIGNED', 'IN_TRANSIT'].includes(order.status) ||
              !attempts[0].failureReason)
        )
          throw new ConflictException(
            'Visit evidence does not match commercial history',
          );
        const attempt = attempts[0];
        const description = (
          attempt.context as { description?: unknown } | null
        )?.description;
        const expectedPayload =
          stop.outcome === 'SUCCESSFUL'
            ? { actorId, status: OrderStatus.DELIVERED }
            : { actorId, reason: attempt.failureReason, context: description };
        if (
          order.zoneId !== route.zoneId ||
          Temporal.Instant.compare(attempt.recordedAt, route.startedAt!) < 0 ||
          Temporal.Instant.compare(attempt.recordedAt, nowInstant()) > 0 ||
          !isDeepStrictEqual(attempt.requestPayload, expectedPayload) ||
          (stop.outcome === 'SUCCESSFUL'
            ? attempt.idempotencyKey !== `delivery:${stop.id}` ||
              order.requiresAdministrativeReview
            : !Object.values(FailedVisitReason).includes(
                attempt.failureReason as FailedVisitReason,
              ) ||
              typeof description !== 'string' ||
              !description.trim() ||
              description.length > 500)
        )
          throw new ConflictException(
            'Visit attempt has invalid canonical audit evidence',
          );
      }
      const completedAt = nowInstant();
      const completed = await tx.orm.public.Route.where({
        id: routeId,
        status: 'IN_PROGRESS',
      }).update({ status: 'COMPLETED', completedAt, completedById: actorId });
      if (!completed?.completedAt)
        throw new ConflictException('Concurrent completion');
      for (const claim of claims) {
        const released = await tx.orm.public.OrderClaim.where({
          id: claim.id,
          releasedAt: null,
        }).update({ releasedAt: completedAt });
        if (!released)
          throw new ConflictException('Concurrent order claim release');
      }
      return {
        id: routeId,
        status: RouteStatus.COMPLETED,
        completedAt: completed.completedAt.toString(),
      };
    });
  }
}
