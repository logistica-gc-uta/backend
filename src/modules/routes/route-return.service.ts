import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { businessDay, nowInstant } from '../../common/temporal.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { RouteReturnResponseDto } from './dto/route-return-response.dto.js';
import { canReturnToDepot, RouteStatus } from './route-lifecycle.policy.js';
import {
  REALTIME_PUBLISHER,
  type RealtimeChange,
  type RealtimePublisher,
} from '../realtime/realtime.contract.js';

@Injectable()
export class RouteReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: RouteAvailabilityService,
    @Optional()
    @Inject(REALTIME_PUBLISHER)
    private readonly realtime?: RealtimePublisher,
  ) {}

  private async publishCommitted(changes: readonly RealtimeChange[]) {
    if (!changes.length || !this.realtime) return;
    try {
      await this.realtime.publish(changes);
    } catch {
      // A delivery fault cannot turn a committed REST operation into a failure.
    }
  }

  async returnToDepot(
    id: string,
    actorId: string,
  ): Promise<RouteReturnResponseDto> {
    const changes: RealtimeChange[] = [];
    const result: RouteReturnResponseDto =
      await this.prisma.client.transaction(async (tx) => {
      const profile = await tx.orm.public.Driver.where({
        userId: actorId,
      }).first();
      if (!profile)
        throw new ForbiddenException('Owned driver profile required');
      const driver = await tx.orm.public.Driver.where({
        id: profile.id,
        userId: actorId,
      }).update({ userId: actorId });
      if (!driver)
        throw new ForbiddenException(
          'Driver ownership changed before lock acquisition',
        );
      const locked = await tx.orm.public.Route.where({
        id,
        driverId: driver.id,
      }).update({ driverId: driver.id });
      const route = await tx.orm.public.Route.where({ id }).first();
      if (!route) throw new NotFoundException('Route not found');
      if (route.driverId !== driver.id)
        throw new ForbiddenException('Route ownership required');
      if (!locked)
        throw new ConflictException(
          'Route ownership changed before lock acquisition',
        );
      if (!canReturnToDepot(route.status as RouteStatus | null, route))
        throw new ConflictException('Genuine completed or interrupted route required');
      const routeStatus = route.status as 'COMPLETED' | 'INTERRUPTED';
      if (route.returnedAt && route.returnedById === actorId)
        return {
          id,
          // RouteReturnResponseDto.status is widened when the DTO is updated outside T2 surfaces.
          status: routeStatus as RouteReturnResponseDto['status'],
          returnedAt: route.returnedAt.toString(),
          availability: await this.availability.effective(driver.id, tx),
        };
      if (route.returnedAt || route.returnedById)
        throw new ConflictException('Conflicting return audit');
      const reservation = await tx.orm.public.DriverReservation.where({
        driverId: driver.id,
        routeId: id,
        releasedAt: null,
      }).first();
      if (!reservation?.reservedAt)
        throw new ConflictException(
          'Matching verified active reservation required',
        );
      const returnedAt = nowInstant();
      const returned = await tx.orm.public.Route.where({
        id,
        driverId: driver.id,
        status: routeStatus,
        returnedAt: null,
        returnedById: null,
      }).update({ returnedAt, returnedById: actorId });
      if (!returned) throw new ConflictException('Concurrent return conflict');
      const released = await tx.orm.public.DriverReservation.where({
        id: reservation.id,
        driverId: driver.id,
        routeId: id,
        releasedAt: null,
      }).update({ releasedAt: returnedAt });
      if (!released)
        throw new ConflictException('Reservation changed during return');
      const availability = await this.availability.recomputeProjection(
        driver.id,
        driver.userId,
        tx,
      );
      if (!returned.returnedAt)
        throw new ConflictException('Persisted return audit missing');
      // Returning releases the route hold only: an absence covering today stays, so the published
      // availability must still say "not available" (#44). The HTTP response keeps its historical shape.
      const today = await this.availability.effective(driver.id, tx, businessDay(nowInstant()));
      changes.push(
        {
          type: 'route.updated',
          routeId: returned.id,
          status: returned.status ?? routeStatus,
        },
        {
          type: 'driver.availability.updated',
          driverId: driver.id,
          available: today.isAvailable,
        },
      );
      if (routeStatus === 'INTERRUPTED') {
        // T3 widens RealtimeChange in realtime.contract.ts for route-scoped dispatch.incident.updated.
        changes.push({
          type: 'dispatch.incident.updated',
          routeId: returned.id,
          action: 'EMERGENCY_DRIVER_RETURN',
        } as unknown as RealtimeChange);
      }
      return {
        id,
        status: routeStatus as RouteReturnResponseDto['status'],
        returnedAt: returned.returnedAt.toString(),
        availability,
      };
    });
    await this.publishCommitted(changes);
    return result;
  }
}
