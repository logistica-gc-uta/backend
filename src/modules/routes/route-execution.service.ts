import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { nowInstant } from '../../common/temporal.util.js';
import { RouteStartResponseDto } from './dto/route-start-response.dto.js';
import { canTransitionRoute, RouteStatus } from './route-lifecycle.policy.js';

@Injectable()
export class RouteExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  async start(id: string, actorId: string): Promise<RouteStartResponseDto> {
    return this.prisma.client.transaction(async (tx) => {
      const driver = await tx.orm.public.Driver.where({
        userId: actorId,
      }).first();
      if (!driver) throw new ForbiddenException('Driver profile required');
      // Supported UPDATE acquires a row lock without changing availability/ownership.
      const lockedDriver = await tx.orm.public.Driver.where({
        id: driver.id,
        userId: actorId,
      }).update({ userId: actorId });
      if (!lockedDriver)
        throw new ForbiddenException('Driver profile ownership changed');
      await tx.orm.public.Route.where({ id, driverId: driver.id }).update({
        driverId: driver.id,
      });
      const route = await tx.orm.public.Route.where({ id }).first();
      if (!route) throw new NotFoundException('Route not found');
      if (route.driverId !== driver.id)
        throw new ForbiddenException('Route belongs to another driver');
      const reservation = await tx.orm.public.DriverReservation.where({
        driverId: driver.id,
        routeId: id,
        releasedAt: null,
      }).first();
      if (!reservation?.reservedAt)
        throw new ConflictException(
          'Active verified driver reservation required',
        );
      if (route.status === RouteStatus.IN_PROGRESS) {
        if (
          !route.startedAt ||
          route.startedById !== actorId ||
          route.completedAt ||
          route.returnedAt
        )
          throw new ConflictException('Unverified start audit');
        return {
          id,
          status: RouteStatus.IN_PROGRESS,
          startedAt: route.startedAt.toString(),
        };
      }
      if (
        !canTransitionRoute(
          route.status as RouteStatus | null,
          RouteStatus.IN_PROGRESS,
        ) ||
        route.startedAt ||
        route.startedById ||
        route.completedAt ||
        route.returnedAt
      ) {
        throw new ConflictException(
          'Route cannot start from its current state',
        );
      }
      const stops = await tx.orm.public.RouteStop.where({ routeId: id }).all();
      const ordered = [...stops].sort(
        (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
      );
      if (
        ordered.length < 1 ||
        ordered.length > 4 ||
        ordered.some(
          (stop, index) =>
            stop.isLegacy ||
            stop.sequence !== index + 1 ||
            stop.outcome !== 'PENDING',
        )
      ) {
        throw new ConflictException(
          'One to four verified pending ordered stops required',
        );
      }
      const claims = await tx.orm.public.OrderClaim.where({
        routeId: id,
        releasedAt: null,
      }).all();
      if (
        claims.length !== ordered.length ||
        claims.some(
          (claim) =>
            !claim.claimedAt ||
            !ordered.some((stop) => stop.orderId === claim.orderId),
        )
      ) {
        throw new ConflictException('Matching active order claims required');
      }
      for (const stop of ordered) {
        const order = await tx.orm.public.Order.where({
          id: stop.orderId,
        }).first();
        if (
          !order ||
          order.zoneId !== route.zoneId ||
          order.routeId !== id ||
          order.status !== 'ASSIGNED' ||
          order.requiresAdministrativeReview
        ) {
          throw new ConflictException(
            'Stops must reference assigned same-zone orders',
          );
        }
      }
      const started = await tx.orm.public.Route.where({
        id,
        driverId: driver.id,
        status: 'ASSIGNED',
      }).update({
        status: 'IN_PROGRESS',
        startedAt: nowInstant(),
        startedById: actorId,
      });
      if (!started?.startedAt)
        throw new ConflictException('Concurrent route transition');
      return {
        id,
        status: RouteStatus.IN_PROGRESS,
        startedAt: started.startedAt.toString(),
      };
    });
  }
}
