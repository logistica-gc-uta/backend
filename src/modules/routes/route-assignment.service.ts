import { AssignRouteDto } from './dto/assign-route.dto.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { nowInstant } from '../../common/temporal.util.js';
import { OrderStatus } from '../orders/dto/update-order-status.dto.js';
import {
  canTransitionRoute,
  isOrderPlanningEligible,
  RouteStatus,
} from './route-lifecycle.policy.js';
import { ConfirmDraftRouteDto } from './dto/confirm-draft-route.dto.js';
import { AssignDraftRouteDto } from './dto/assign-draft-route.dto.js';
import { RouteAssignmentResponseDto } from './dto/route-assignment-response.dto.js';

type Transaction = Parameters<
  Parameters<PrismaService['client']['transaction']>[0]
>[0];
interface RouteSnapshot {
  id: string;
  status: string | null;
  driverId: string | null;
  zoneId: string;
  date: Temporal.Instant;
  createdAt: Temporal.Instant;
}

@Injectable()
export class RouteAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: RouteAvailabilityService,
  ) {}

  private async transaction<T>(
    actorId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.client.transaction(async (tx) => {
        const actor = await tx.orm.public.User.where({
          id: actorId,
          role: 'ADMIN',
        }).first();
        if (!actor) throw new ForbiddenException('ADMIN confirmation required');
        return fn(tx);
      });
    } catch (error) {
      // Installed driver errors expose SQLSTATE, sometimes through a cause chain.
      let cause: unknown = error;
      for (
        let depth = 0;
        depth < 6 && cause && typeof cause === 'object';
        depth++
      ) {
        const record = cause as { sqlState?: string; cause?: unknown };
        if (
          record.sqlState &&
          ['23505', '23514', '40001', '40P01'].includes(record.sqlState)
        ) {
          throw new ConflictException('Route resources or lifecycle conflict');
        }
        cause = record.cause;
      }
      throw error;
    }
  }

  private response(route: RouteSnapshot): RouteAssignmentResponseDto {
    if (route.status !== 'DRAFT' && route.status !== 'ASSIGNED')
      throw new ConflictException('Unexpected assignment state');
    return {
      id: route.id,
      status: route.status,
      driverId: route.driverId,
      zoneId: route.zoneId,
      date: route.date.toString(),
      createdAt: route.createdAt.toString(),
    };
  }

  private async lockOrders(
    tx: Transaction,
    orderIds: string[],
    zoneId: string,
    date: Temporal.Instant,
    routeId?: string,
  ) {
    for (const id of [...orderIds].sort()) {
      // Lock identity, never overwrite a status observed before acquiring the lock.
      const order = await tx.orm.public.Order.where({ id }).update({ id });
      if (!order) throw new NotFoundException('Proposal order not found');
      const claim = await tx.orm.public.OrderClaim.where({
        orderId: id,
        releasedAt: null,
      }).first();
      if (routeId) {
        if (
          !claim?.claimedAt ||
          claim.routeId !== routeId ||
          !(await tx.orm.public.OrderClaim.where({
            id: claim.id,
            routeId,
            releasedAt: null,
          }).update({ id: claim.id }))
        ) {
          throw new ConflictException(
            'Matching verified active order claim required',
          );
        }
      } else if (claim)
        throw new ConflictException(
          'Order already reserved by another proposal',
        );
      if (
        !isOrderPlanningEligible(
          order.status as OrderStatus,
          false,
          order.requiresAdministrativeReview,
        ) ||
        order.zoneId !== zoneId ||
        !order.scheduledDeliveryDate ||
        Temporal.Instant.compare(order.scheduledDeliveryDate, date) !== 0
      ) {
        throw new ConflictException(
          'Orders require PENDING eligibility, one zone and exact explicit schedule instant',
        );
      }
    }
  }

  private validateOrderIds(orderIds: string[]): void {
    if (
      !Array.isArray(orderIds) ||
      orderIds.length < 1 ||
      orderIds.length > 4 ||
      new Set(orderIds).size !== orderIds.length
    )
      throw new BadRequestException('One to four distinct orders required');
  }

  async assignLegacy(
    dto: AssignRouteDto,
    actorId: string,
  ): Promise<RouteAssignmentResponseDto> {
    this.validateOrderIds(dto.orderIds);
    return this.transaction(actorId, async (tx) => {
      // Hold the shared driver before creating the route and locking sorted orders.
      await this.lockDriver(tx, dto.driverId);
      if (!(await tx.orm.public.Zone.where({ id: dto.zoneId }).first()))
        throw new NotFoundException('Zone not found');
      let date: Temporal.Instant | null = null;
      for (const id of [...dto.orderIds].sort()) {
        const order = await tx.orm.public.Order.where({ id }).first();
        if (!order) throw new NotFoundException('Proposal order not found');
        if (order.zoneId !== dto.zoneId)
          throw new BadRequestException(
            'Order does not belong to the requested zone',
          );
        if (
          !order.scheduledDeliveryDate ||
          (date &&
            Temporal.Instant.compare(date, order.scheduledDeliveryDate) !== 0)
        )
          throw new ConflictException(
            'Legacy assignment requires an exact common non-null scheduled timestamp',
          );
        date = order.scheduledDeliveryDate;
      }
      if (!date)
        throw new ConflictException('Common scheduled timestamp required');
      const draft = await this.confirmInTransaction(
        tx,
        {
          zoneId: dto.zoneId,
          orderIds: dto.orderIds,
          routeDate: date.toString(),
        },
        date,
      );
      // These helpers use the same transaction; previously acquired locks stay held.
      return this.assignInTransaction(tx, draft.id, { driverId: dto.driverId });
    });
  }

  async confirmDraft(
    dto: ConfirmDraftRouteDto,
    actorId: string,
  ): Promise<RouteAssignmentResponseDto> {
    this.validateOrderIds(dto.orderIds);
    let date: Temporal.Instant;
    try {
      date = Temporal.Instant.from(dto.routeDate);
    } catch {
      throw new BadRequestException('Explicit route timestamp required');
    }
    return this.transaction(actorId, (tx) =>
      this.confirmInTransaction(tx, dto, date),
    );
  }

  private async confirmInTransaction(
    tx: Transaction,
    dto: ConfirmDraftRouteDto,
    date: Temporal.Instant,
  ): Promise<RouteAssignmentResponseDto> {
    if (!(await tx.orm.public.Zone.where({ id: dto.zoneId }).first()))
      throw new NotFoundException('Zone not found');
    const route = await tx.orm.public.Route.create({
      status: 'DRAFT',
      driverId: null,
      zoneId: dto.zoneId,
      date,
    });
    await this.lockOrders(tx, dto.orderIds, dto.zoneId, date);
    const claimedAt = nowInstant();
    for (const [index, orderId] of dto.orderIds.entries()) {
      await tx.orm.public.RouteStop.create({
        routeId: route.id,
        orderId,
        sequence: index + 1,
        outcome: 'PENDING',
        isLegacy: false,
        createdAt: claimedAt,
      });
      await tx.orm.public.OrderClaim.create({
        routeId: route.id,
        orderId,
        claimedAt,
      });
    }
    return this.response(route);
  }

  async assignDraft(
    id: string,
    dto: AssignDraftRouteDto,
    actorId: string,
  ): Promise<RouteAssignmentResponseDto> {
    return this.transaction(actorId, (tx) =>
      this.assignInTransaction(tx, id, dto),
    );
  }

  private async lockDriver(tx: Transaction, driverId: string) {
    const initialDriver = await tx.orm.public.Driver.where({
      id: driverId,
    }).first();
    if (!initialDriver) throw new NotFoundException('Driver not found');
    const driver = await tx.orm.public.Driver.where({
      id: driverId,
      userId: initialDriver.userId,
    }).update({ userId: initialDriver.userId });
    if (!driver)
      throw new ConflictException('Driver profile changed during assignment');
    return driver;
  }

  private async assignInTransaction(
    tx: Transaction,
    id: string,
    dto: AssignDraftRouteDto,
  ): Promise<RouteAssignmentResponseDto> {
    const driver = await this.lockDriver(tx, dto.driverId);
    const route = await tx.orm.public.Route.where({ id }).update({ id });
    if (!route) throw new NotFoundException('Route not found');
    if (
      !canTransitionRoute(
        route.status as RouteStatus | null,
        RouteStatus.ASSIGNED,
      ) ||
      route.driverId !== null
    )
      throw new ConflictException('Only an unassigned DRAFT may be assigned');
    const profile = await tx.orm.public.User.where({
      id: driver.userId,
      role: 'DRIVER',
    }).first();
    if (
      !profile ||
      !(await this.availability.effective(driver.id, tx)).isAvailable
    )
      throw new ConflictException(
        'Driver has an unresolved route or reservation hold',
      );
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
    )
      throw new ConflictException(
        'Verified one-to-four pending stops required',
      );
    const claims = await tx.orm.public.OrderClaim.where({
      routeId: id,
      releasedAt: null,
    }).all();
    if (claims.length !== ordered.length)
      throw new ConflictException('Route claims do not match its stops');
    await this.lockOrders(
      tx,
      ordered.map((stop) => stop.orderId),
      route.zoneId,
      route.date,
      id,
    );
    await tx.orm.public.DriverReservation.create({
      driverId: driver.id,
      routeId: id,
      reservedAt: nowInstant(),
    });
    const assigned = await tx.orm.public.Route.where({
      id,
      status: 'DRAFT',
      driverId: null,
    }).update({ status: 'ASSIGNED', driverId: driver.id });
    if (!assigned) throw new ConflictException('Concurrent route assignment');
    for (const stop of ordered) {
      const assignedOrder = await tx.orm.public.Order.where({
        id: stop.orderId,
        status: 'PENDING',
      }).update({
        status: 'ASSIGNED',
        routeId: id,
        stopOrder: stop.sequence,
      });
      if (!assignedOrder)
        throw new ConflictException('Order changed during assignment');
    }
    if (
      !(await tx.orm.public.Driver.where({
        id: driver.id,
        userId: driver.userId,
      }).update({ isAvailable: false }))
    )
      throw new ConflictException('Driver changed during assignment');
    return this.response(assigned);
  }
}
