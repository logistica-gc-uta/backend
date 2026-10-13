import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { nowInstant } from '../../common/temporal.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { RouteReturnResponseDto } from './dto/route-return-response.dto.js';
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
      if (
        route.status !== 'COMPLETED' ||
        !route.startedAt ||
        !route.startedById ||
        !route.completedAt ||
        !route.completedById
      )
        throw new ConflictException('Genuine completed route required');
      if (route.returnedAt && route.returnedById === actorId)
        return {
          id,
          status: 'COMPLETED',
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
        status: 'COMPLETED',
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
        actorId,
        tx,
      );
      if (!returned.returnedAt)
        throw new ConflictException('Persisted return audit missing');
      changes.push(
        {
          type: 'route.updated',
          routeId: returned.id,
          status: returned.status ?? 'COMPLETED',
        },
        {
          type: 'driver.availability.updated',
          driverId: driver.id,
          available: availability.isAvailable,
        },
      );
      return {
        id,
        status: 'COMPLETED',
        returnedAt: returned.returnedAt.toString(),
        availability,
      };
    });
    await this.publishCommitted(changes);
    return result;
  }
}
