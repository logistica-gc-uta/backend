import { DriverAvailabilityResponseDto } from './dto/driver-availability-response.dto.js';
import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

type Transaction = Parameters<
  Parameters<PrismaService['client']['transaction']>[0]
>[0];

@Injectable()
export class RouteAvailabilityService {
  constructor(private readonly prisma: PrismaService) {}
  private async persistedHolds(
    driverId: string,
    tx: Pick<Transaction, 'orm'>,
  ): Promise<string[]> {
    const blocking = new Set<string>();
    const reservations = await tx.orm.public.DriverReservation.where({
      driverId,
      releasedAt: null,
    }).all();
    reservations.forEach((row) => blocking.add(row.routeId));
    const routes = await tx.orm.public.Route.where({ driverId }).all();
    for (const route of routes) {
      if (route.status === 'DRAFT') continue;
      if (
        route.status === 'COMPLETED' &&
        route.startedAt &&
        route.startedById &&
        route.completedAt &&
        route.completedById &&
        route.returnedAt &&
        route.returnedById
      )
        continue;
      if (route.status === null) {
        const audit = await tx.orm.public.LegacyRouteReconciliation.where({
          routeId: route.id,
          releaseDriverHold: true,
        }).first();
        const evidence = audit?.evidence;
        const text =
          typeof evidence === 'string'
            ? evidence
            : evidence &&
                typeof evidence === 'object' &&
                !Array.isArray(evidence)
              ? (evidence as { readonly evidence?: unknown }).evidence
              : null;
        // Persisted audit authority survives later role changes; the actor FK remains valid.
        if (
          audit?.recordedAt &&
          audit.reason.trim() &&
          audit.reason.length <= 500 &&
          typeof text === 'string' &&
          text.trim() &&
          text.length <= 2000 &&
          (await tx.orm.public.User.where({
            id: audit.administratorId,
          }).first())
        )
          continue;
      }
      blocking.add(route.id);
    }
    return [...blocking].sort();
  }

  async effective(
    driverId: string,
    tx: Pick<Transaction, 'orm'> = this.prisma.client,
  ): Promise<DriverAvailabilityResponseDto> {
    const blockingRouteIds = await this.persistedHolds(driverId, tx);
    const driver = await tx.orm.public.Driver.where({ id: driverId }).first();
    const compatibilityFlagBlocks = driver?.isAvailable !== true;
    return {
      isAvailable: blockingRouteIds.length === 0 && !compatibilityFlagBlocks,
      hasPersistedHolds: blockingRouteIds.length !== 0,
      compatibilityFlagBlocks,
      blockingRouteIds,
    };
  }

  // Caller owns the driver's lock. Return or reconciliation resets only the projection;
  // remaining reservations and current/legacy routes remain authoritative holds.
  async recomputeProjection(
    driverId: string,
    userId: string,
    tx: Transaction,
  ): Promise<DriverAvailabilityResponseDto> {
    const blockingRouteIds = await this.persistedHolds(driverId, tx);
    if (
      !(await tx.orm.public.Driver.where({ id: driverId, userId }).update({
        isAvailable: blockingRouteIds.length === 0,
      }))
    )
      throw new ConflictException(
        'Driver changed during availability projection',
      );
    return this.effective(driverId, tx);
  }
}
