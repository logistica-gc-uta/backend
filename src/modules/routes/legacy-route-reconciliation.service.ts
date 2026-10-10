import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { nowInstant } from '../../common/temporal.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RegularizeLegacyRouteDto } from './dto/regularize-legacy-route.dto.js';
import { RouteReconciliationResponseDto } from './dto/route-reconciliation-response.dto.js';
import { RouteAvailabilityService } from './route-availability.service.js';

@Injectable()
export class LegacyRouteReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: RouteAvailabilityService,
  ) {}

  async reconcile(
    id: string,
    actorId: string,
    dto: RegularizeLegacyRouteDto,
  ): Promise<RouteReconciliationResponseDto> {
    return this.prisma.client.transaction(async (tx) => {
      const snapshot = await tx.orm.public.Route.where({ id }).first();
      if (!snapshot) throw new NotFoundException('Route not found');
      if (snapshot.status !== null)
        throw new ConflictException(
          'Only unverified legacy routes may be reconciled',
        );
      // Same driver-before-route order as dispatch and physical depot return.
      const profile = snapshot.driverId
        ? await tx.orm.public.Driver.where({ id: snapshot.driverId }).first()
        : null;
      const driver = profile
        ? await tx.orm.public.Driver.where({
            id: profile.id,
            userId: profile.userId,
          }).update({ userId: profile.userId })
        : null;
      if (snapshot.driverId && !driver)
        throw new ConflictException(
          'Driver binding changed before lock acquisition',
        );
      const route = await tx.orm.public.Route.where({
        id,
        driverId: snapshot.driverId,
        status: null,
      }).update({ driverId: snapshot.driverId });
      if (!route)
        throw new ConflictException(
          'Route binding changed before lock acquisition',
        );
      // Fresh authorization, including replays; JWT claim alone is not authority.
      if (
        !(await tx.orm.public.User.where({
          id: actorId,
          role: 'ADMIN',
        }).first())
      )
        throw new ForbiddenException('Current ADMIN role required');
      const existing = await tx.orm.public.LegacyRouteReconciliation.where({
        routeId: id,
      }).all();
      const previous = existing[0];
      if (previous) {
        const evidence = previous.evidence;
        if (
          existing.length !== 1 ||
          previous.administratorId !== actorId ||
          previous.reason !== dto.reason ||
          !previous.recordedAt ||
          !previous.releaseDriverHold ||
          !evidence ||
          typeof evidence !== 'object' ||
          Array.isArray(evidence) ||
          Object.keys(evidence).length !== 1 ||
          (evidence as { evidence?: unknown }).evidence !== dto.evidence
        )
          throw new ConflictException('Conflicting reconciliation audit');
      }
      const recordedAt = nowInstant();
      const audit =
        previous ??
        (await tx.orm.public.LegacyRouteReconciliation.create({
          routeId: id,
          administratorId: actorId,
          recordedAt,
          reason: dto.reason,
          evidence: { evidence: dto.evidence },
          releaseDriverHold: true,
        }));
      if (!previous && driver) {
        const reservations = await tx.orm.public.DriverReservation.where({
          driverId: driver.id,
          routeId: id,
          releasedAt: null,
        }).all();
        for (const reservation of reservations) {
          if (
            !(await tx.orm.public.DriverReservation.where({
              id: reservation.id,
              driverId: driver.id,
              routeId: id,
              releasedAt: null,
            }).update({ releasedAt: recordedAt }))
          )
            throw new ConflictException(
              'Reservation changed during reconciliation',
            );
        }
      }
      const availability = driver
        ? previous
          ? await this.availability.effective(driver.id, tx)
          : await this.availability.recomputeProjection(
              driver.id,
              driver.userId,
              tx,
            )
        : null;
      return {
        audit: {
          id: audit.id,
          routeId: audit.routeId,
          administratorId: audit.administratorId,
          recordedAt: audit.recordedAt.toString(),
          reason: audit.reason,
          evidence: { evidence: dto.evidence },
          releaseDriverHold: true,
        },
        availability,
      };
    });
  }
}
