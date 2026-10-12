import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { nowInstant } from '../../common/temporal.util.js';
import { RouteAssignmentService } from './route-assignment.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { RouteUrgencyService } from './route-urgency.service.js';
import {
  canMutateRouteStructure,
  RouteStatus,
} from './route-lifecycle.policy.js';
import {
  DispatchAuditDto,
  DispatchInterventionDto,
} from './dto/dispatch-intervention.dto.js';

type Transaction = Parameters<
  Parameters<PrismaService['client']['transaction']>[0]
>[0];
type Audit = NonNullable<
  Awaited<
    ReturnType<
      PrismaService['client']['orm']['public']['DispatchIntervention']['first']
    >
  >
>;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

@Injectable()
export class DispatchInterventionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: RouteAssignmentService,
    private readonly availability: RouteAvailabilityService,
    private readonly urgency: RouteUrgencyService,
  ) {}
  private response(a: Audit): DispatchAuditDto {
    return {
      id: a.id,
      requestId: a.requestId,
      actorId: a.actorId,
      orderId: a.orderId,
      routeId: a.routeId,
      action: a.action,
      reason: a.reason,
      outcome: a.outcome,
      recordedAt: a.recordedAt.toString(),
      result: a.result,
    };
  }
  async audit() {
    return (
      await this.prisma.client.orm.public.DispatchIntervention.orderBy((a) =>
        a.recordedAt.desc(),
      ).all()
    ).map((a) => this.response(a));
  }
  private replay(a: Audit, actorId: string, dto: DispatchInterventionDto) {
    if (a.actorId !== actorId || canonical(a.payload) !== canonical(dto))
      throw new ConflictException(
        'Idempotency key belongs to another actor or payload',
      );
    return this.response(a);
  }
  private validate(dto: DispatchInterventionDto) {
    const fields: Record<string, string[]> = {
      CONFIRM: ['orderId', 'fingerprint', 'driverId'],
      REJECT: ['orderId', 'fingerprint'],
      REORDER: ['routeId', 'orderIds'],
      MOVE: ['orderId', 'routeId', 'targetRouteId'],
      REASSIGN_DRIVER: ['routeId', 'driverId'],
      PRIORITIZE: ['orderId'],
    };
    const required: Record<string, string[]> = {
      CONFIRM: ['orderId', 'fingerprint'],
      REJECT: ['orderId', 'fingerprint'],
      REORDER: ['routeId', 'orderIds'],
      MOVE: ['orderId', 'routeId', 'targetRouteId'],
      REASSIGN_DRIVER: ['routeId', 'driverId'],
      PRIORITIZE: ['orderId'],
    };
    const allowed = fields[dto.action];
    if (
      !allowed ||
      Object.entries(dto).some(
        ([k, v]) =>
          v !== undefined &&
          !['action', 'reason', 'requestId', ...allowed].includes(k),
      ) ||
      required[dto.action]!.some(
        (k) => !(dto as unknown as Record<string, unknown>)[k],
      )
    )
      throw new BadRequestException(
        'Action requires its exact resource fields',
      );
  }
  private async lockResources(
    tx: Transaction,
    routes: string[],
    drivers: string[],
    orders: string[],
  ) {
    // Shared with start/assignment: drivers, sorted routes, sorted orders.
    for (const id of [...new Set(drivers)].sort())
      await this.assignment.lockDriver(tx, id);
    for (const id of [...new Set(routes)].sort()) {
      const r = await tx.orm.public.Route.where({ id }).update({ id });
      if (!r) throw new NotFoundException('Route not found');
      if (!canMutateRouteStructure(r.status as RouteStatus | null))
        throw new ConflictException('Route structure is frozen');
      if (r.driverId && !drivers.includes(r.driverId))
        throw new ConflictException('Route driver changed; refresh decision');
    }
    for (const id of [...new Set(orders)].sort())
      if (!(await tx.orm.public.Order.where({ id }).update({ id })))
        throw new NotFoundException('Order not found');
  }
  private createAudit(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    routeId: string | null,
    result: Record<string, string | null>,
  ) {
    return tx.orm.public.DispatchIntervention.create({
      requestId: dto.requestId,
      actorId,
      orderId: dto.orderId ?? null,
      routeId,
      action: dto.action,
      reason: dto.reason.trim(),
      outcome: dto.action === 'REJECT' ? 'REJECTED' : 'APPLIED',
      payload: JSON.parse(canonical(dto)),
      result,
      recordedAt: nowInstant(),
    });
  }
  async intervene(
    dto: DispatchInterventionDto,
    actorId: string,
  ): Promise<DispatchAuditDto> {
    this.validate(dto);
    try {
      return await this.assignment.transaction(actorId, async (tx) => {
        const db = tx.orm.public;
        const prior = await db.DispatchIntervention.where({
          requestId: dto.requestId,
        }).first();
        if (prior) return this.replay(prior, actorId, dto);
        if (dto.action === 'CONFIRM' || dto.action === 'REJECT') {
          const initial = await this.urgency.propose(dto.orderId!, tx);
          const route = initial.routeId
            ? await db.Route.where({ id: initial.routeId }).first()
            : null;
          const driverIds = [
            ...(route?.driverId ? [route.driverId] : []),
            ...(dto.driverId ? [dto.driverId] : []),
          ];
          await this.lockResources(
            tx,
            initial.routeId ? [initial.routeId] : [],
            driverIds,
            initial.orderIds.length ? initial.orderIds : [dto.orderId!],
          );
          const proposal = await this.urgency.propose(dto.orderId!, tx);
          if (
            proposal.kind === 'BLOCKED' ||
            proposal.fingerprint !== dto.fingerprint
          )
            throw new ConflictException(
              'Proposal blocked or stale; refresh proposal',
            );
          if (proposal.kind === 'INSERT' && dto.driverId)
            throw new BadRequestException('Insertion retains the route driver');
          if (dto.action === 'REJECT')
            return this.response(
              await this.createAudit(tx, dto, actorId, proposal.routeId, {
                orderId: dto.orderId!,
                routeId: proposal.routeId,
              }),
            );
          let routeId = proposal.routeId;
          if (routeId)
            await this.assignment.replaceStops(tx, routeId, proposal.orderIds);
          else {
            if (
              !dto.driverId ||
              !proposal.availableDriverIds.includes(dto.driverId)
            )
              throw new ConflictException(
                'New departure requires an effectively available driver',
              );
            const draft = await this.assignment.confirmInTransaction(
              tx,
              {
                zoneId: proposal.zoneId,
                routeDate: proposal.routeDate!,
                orderIds: proposal.orderIds,
              },
              Temporal.Instant.from(proposal.routeDate!),
            );
            routeId = draft.id;
            await this.assignment.assignInTransaction(tx, routeId, {
              driverId: dto.driverId,
            });
          }
          return this.response(
            await this.createAudit(tx, dto, actorId, routeId, {
              orderId: dto.orderId!,
              routeId,
            }),
          );
        }
        if (dto.action === 'PRIORITIZE') {
          await this.lockResources(tx, [], [], [dto.orderId!]);
          const order = await db.Order.where({ id: dto.orderId! }).first();
          if (
            order?.status !== 'PENDING' ||
            order.requiresAdministrativeReview ||
            (await db.OrderClaim.where({
              orderId: dto.orderId!,
              releasedAt: null,
            }).first())
          )
            throw new ConflictException(
              'Only an eligible unclaimed PENDING order may be prioritized',
            );
          return this.response(
            await this.createAudit(tx, dto, actorId, null, {
              orderId: dto.orderId!,
              routeId: null,
            }),
          );
        }
        const routeIds = [
          dto.routeId!,
          ...(dto.targetRouteId ? [dto.targetRouteId] : []),
        ];
        const routes = [];
        for (const id of routeIds) {
          const route = await db.Route.where({ id }).first();
          if (!route) throw new NotFoundException('Route not found');
          routes.push(route);
        }
        const stopIds: string[] = [];
        for (const r of routes)
          for (const s of await db.RouteStop.where({ routeId: r.id }).all())
            stopIds.push(s.orderId);
        await this.lockResources(
          tx,
          routeIds,
          [
            ...routes.flatMap((r) => (r.driverId ? [r.driverId] : [])),
            ...(dto.driverId ? [dto.driverId] : []),
          ],
          stopIds,
        );
        const route = await db.Route.where({ id: dto.routeId! }).first();
        if (!route) throw new NotFoundException('Route not found');
        if (dto.action === 'REASSIGN_DRIVER') {
          if (
            route.status !== 'ASSIGNED' ||
            !route.driverId ||
            route.driverId === dto.driverId
          )
            throw new ConflictException(
              'Reassignment requires a different driver on ASSIGNED',
            );
          const next = await db.Driver.where({ id: dto.driverId! }).first();
          if (
            !next ||
            !(await db.User.where({
              id: next.userId,
              role: 'DRIVER',
            }).first()) ||
            !(await this.availability.effective(next.id, tx)).isAvailable
          )
            throw new ConflictException(
              'Driver has an unresolved route or reservation hold',
            );
          const reservation = await db.DriverReservation.where({
            routeId: route.id,
            driverId: route.driverId,
            releasedAt: null,
          }).first();
          if (!reservation?.reservedAt)
            throw new ConflictException(
              'Matching verified reservation required',
            );
          const audit = await this.createAudit(tx, dto, actorId, route.id, {
            routeId: route.id,
            driverId: next.id,
          });
          await db.Route.where({
            id: route.id,
            status: 'ASSIGNED',
            driverId: route.driverId,
          }).update({ driverId: next.id });
          await db.DriverReservation.where({ id: reservation.id }).update({
            releasedAt: nowInstant(),
          });
          await db.DriverReservation.create({
            routeId: route.id,
            driverId: next.id,
            reservedAt: nowInstant(),
          });
          const previous = await db.Driver.where({
            id: route.driverId,
          }).first();
          if (!previous)
            throw new ConflictException('Previous driver not found');
          await this.availability.recomputeProjection(
            previous.id,
            previous.userId,
            tx,
          );
          await db.Driver.where({ id: next.id }).update({ isAvailable: false });
          return this.response(audit);
        }
        const stops = (
          await db.RouteStop.where({ routeId: route.id }).all()
        ).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        if (dto.action === 'REORDER') {
          if (
            dto.orderIds!.length !== stops.length ||
            stops.some((s) => !dto.orderIds!.includes(s.orderId))
          )
            throw new ConflictException(
              'Reorder must contain exactly the current stops',
            );
          await this.assignment.replaceStops(tx, route.id, dto.orderIds!);
          return this.response(
            await this.createAudit(tx, dto, actorId, route.id, {
              routeId: route.id,
            }),
          );
        }
        if (
          dto.routeId === dto.targetRouteId ||
          !stops.some((s) => s.orderId === dto.orderId) ||
          stops.length <= 1
        )
          throw new ConflictException(
            'Move requires a distinct target and a nonempty source route',
          );
        const target = (
          await db.RouteStop.where({ routeId: dto.targetRouteId! }).all()
        ).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        if (target.length >= 4)
          throw new ConflictException('Route maximum is four stops');
        const claim = await db.OrderClaim.where({
          routeId: route.id,
          orderId: dto.orderId!,
          releasedAt: null,
        }).first();
        if (!claim?.claimedAt)
          throw new ConflictException('Matching verified claim required');
        const audit = await this.createAudit(tx, dto, actorId, route.id, {
          orderId: dto.orderId!,
          routeId: route.id,
          targetRouteId: dto.targetRouteId!,
        });
        await this.assignment.replaceStops(
          tx,
          route.id,
          stops.filter((s) => s.orderId !== dto.orderId).map((s) => s.orderId),
        );
        await db.OrderClaim.where({ id: claim.id }).update({
          releasedAt: nowInstant(),
        });
        await db.Order.where({ id: dto.orderId! }).update({
          status: 'PENDING',
          routeId: null,
          stopOrder: null,
        });
        await this.assignment.replaceStops(tx, dto.targetRouteId!, [
          ...target.map((s) => s.orderId),
          dto.orderId!,
        ]);
        return this.response(audit);
      });
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      // Unique-key contenders reconcile once after rollback, never repeat mutation.
      const prior =
        await this.prisma.client.orm.public.DispatchIntervention.where({
          requestId: dto.requestId,
        }).first();
      if (prior) return this.replay(prior, actorId, dto);
      throw error;
    }
  }
}
