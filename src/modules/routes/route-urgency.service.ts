import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  businessDay,
  isSameBusinessDay,
  nowInstant,
} from '../../common/temporal.util.js';
import { evaluatePlanningEligibility } from '../orders/order-geography.util.js';
import { OrderStatus } from '../orders/dto/update-order-status.dto.js';
import {
  canMutateRouteStructure,
  isOrderPlanningEligible,
  RouteStatus,
} from './route-lifecycle.policy.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import {
  DEFAULT_ROUTE_CAPACITY,
  planRoutes,
  type RoutingOrder,
} from './algorithms/clarke-wright.js';
import { haversineKm } from './algorithms/geo.util.js';
import { UrgencyProposalDto } from './dto/urgency-response.dto.js';

type Reader = Pick<PrismaService['client'], 'orm'>;

@Injectable()
export class RouteUrgencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: RouteAvailabilityService,
  ) {}

  // No proposal/claim/route is persisted. Confirmation must re-read under locks.
  async propose(
    orderId: string,
    reader: Reader = this.prisma.client,
  ): Promise<UrgencyProposalDto> {
    const db = reader.orm.public;
    const order = await db.Order.where({ id: orderId }).first();
    if (!order) throw new NotFoundException('Order not found');
    const date = businessDay(nowInstant()).toString();
    const zone = await db.Zone.where({ id: order.zoneId }).first();
    const geography = evaluatePlanningEligibility(order, zone);
    const reasons: string[] = [...geography.planningEligibility.reasons];
    const activeClaim = await db.OrderClaim.where({
      orderId,
      releasedAt: null,
    }).first();
    if (order.status !== 'PENDING') reasons.push('ORDER_NOT_PENDING');
    if (order.requiresAdministrativeReview)
      reasons.push('ADMINISTRATIVE_REVIEW_REQUIRED');
    if (activeClaim) reasons.push('ACTIVE_ROUTE_CLAIM');
    if (
      !order.scheduledDeliveryDate ||
      businessDay(order.scheduledDeliveryDate).toString() !== date
    )
      reasons.push('NOT_TODAY');
    const base: Pick<UrgencyProposalDto, keyof UrgencyProposalDto> = {
      orderId,
      date,
      timeZone: 'America/Guayaquil',
      kind: 'BLOCKED',
      routeId: null,
      zoneId: order.zoneId,
      routeDate: order.scheduledDeliveryDate?.toString() ?? null,
      orderIds: [],
      stops: [],
      availableDriverIds: [],
      reasons,
      totalDistanceKm: 0,
      fingerprint: '',
    };
    if (reasons.length || !zone || !geography.deliveryLocation) return base;
    const depot = { lat: zone.depotLat!, lng: zone.depotLng! };
    const snapshot = (o: typeof order) => ({
      id: o.id,
      status: o.status,
      zoneId: o.zoneId,
      routeId: o.routeId,
      review: o.requiresAdministrativeReview,
      date: o.scheduledDeliveryDate?.toString(),
      lat: o.deliveryLat,
      lng: o.deliveryLng,
    });
    const make = (
      orders: (typeof order)[],
      routeId: string | null,
      routeDate: string,
      evidence: unknown,
    ) => {
      const routing: RoutingOrder[] = orders.map((o) => ({
        id: o.id,
        zoneId: o.zoneId,
        deliveryDate: date,
        location: { lat: o.deliveryLat!, lng: o.deliveryLng! },
      }));
      // Degenerate/zero-savings groups can produce separate tours; flatten the
      // deterministic tours since all validated candidates already fit one vehicle.
      const ids = planRoutes(routing, {
        depots: { [zone.id]: depot },
        capacity: DEFAULT_ROUTE_CAPACITY,
      }).flatMap((r) => r.orderIds);
      const locations = new Map(routing.map((o) => [o.id, o.location]));
      const points = [depot, ...ids.map((id) => locations.get(id)!), depot];
      const distance = points
        .slice(1)
        .reduce((sum, p, i) => sum + haversineKm(points[i]!, p), 0);
      return {
        ...base,
        kind: routeId ? ('INSERT' as const) : ('NEW_ROUTE' as const),
        routeId,
        routeDate,
        orderIds: ids,
        stops: ids.map((id, i) => ({ orderId: id, sequence: i + 1 })),
        totalDistanceKm: Math.round(distance * 1000) / 1000,
        fingerprint: createHash('sha256')
          .update(
            JSON.stringify({
              orders: [...orders]
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(snapshot),
              depot,
              routeId,
              routeDate,
              ids,
              evidence,
            }),
          )
          .digest('hex'),
      };
    };
    const routes = await db.Route.where({ zoneId: zone.id }).all();
    for (const route of [...routes].sort((a, b) => a.id.localeCompare(b.id))) {
      if (
        !canMutateRouteStructure(route.status as RouteStatus | null) ||
        !isSameBusinessDay(route.date, order.scheduledDeliveryDate!)
      )
        continue;
      const stops = (
        await db.RouteStop.where({ routeId: route.id }).all()
      ).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      if (
        !stops.length ||
        stops.length >= DEFAULT_ROUTE_CAPACITY ||
        stops.some(
          (s, i) =>
            s.isLegacy || s.outcome !== 'PENDING' || s.sequence !== i + 1,
        )
      )
        continue;
      const claims = await db.OrderClaim.where({
        routeId: route.id,
        releasedAt: null,
      }).all();
      if (claims.length !== stops.length) continue;
      const orders = [order];
      for (const stop of stops) {
        const current = await db.Order.where({ id: stop.orderId }).first();
        const claim = claims.find(
          (c) => c.orderId === stop.orderId && c.claimedAt,
        );
        const eligible =
          current &&
          (route.status === 'DRAFT'
            ? isOrderPlanningEligible(
                current.status as OrderStatus,
                false,
                current.requiresAdministrativeReview,
              )
            : current.status === 'ASSIGNED' &&
              current.routeId === route.id &&
              !current.requiresAdministrativeReview);
        if (
          !current ||
          !eligible ||
          !claim ||
          current.zoneId !== zone.id ||
          !current.scheduledDeliveryDate ||
          !isSameBusinessDay(current.scheduledDeliveryDate, route.date) ||
          !evaluatePlanningEligibility(current, zone).planningEligibility
            .eligible
        )
          break;
        orders.push(current);
      }
      if (orders.length !== stops.length + 1) continue;
      return make(orders, route.id, route.date.toString(), {
        status: route.status,
        driverId: route.driverId,
        stops: stops.map((s) => ({
          id: s.id,
          sequence: s.sequence,
          orderId: s.orderId,
        })),
        claims: claims.map((c) => c.id).sort(),
      });
    }
    const proposal = make(
      [order],
      null,
      order.scheduledDeliveryDate!.toString(),
      null,
    );
    for (const driver of await db.Driver.all()) {
      if (
        (await db.User.where({ id: driver.userId, role: 'DRIVER' }).first()) &&
        (await this.availability.effective(driver.id, reader)).isAvailable
      )
        proposal.availableDriverIds.push(driver.id);
    }
    proposal.availableDriverIds.sort();
    if (!proposal.availableDriverIds.length)
      return { ...proposal, kind: 'BLOCKED', reasons: ['NO_AVAILABLE_DRIVER'] };
    return proposal;
  }

  async inbox() {
    const date = businessDay(nowInstant()).toString();
    const db = this.prisma.client.orm.public;
    const urgencies: UrgencyProposalDto[] = [];
    const incidents: {
      orderId: string;
      routeId: string | null;
      attempts: {
        id: string;
        stopId: string;
        outcome: string;
        failureReason: string | null;
        recordedAt: string;
      }[];
    }[] = [];
    for (const order of await db.Order.where({ status: 'PENDING' }).all()) {
      if (
        order.scheduledDeliveryDate &&
        businessDay(order.scheduledDeliveryDate).toString() === date &&
        !order.requiresAdministrativeReview
      )
        urgencies.push(await this.propose(order.id));
    }
    for (const order of await db.Order.where({
      requiresAdministrativeReview: true,
    }).all()) {
      const attempts = [];
      for (const stop of await db.RouteStop.where({
        orderId: order.id,
      }).all()) {
        for (const a of await db.DeliveryAttempt.where({
          stopId: stop.id,
          outcome: 'FAILED',
        }).all())
          attempts.push({
            id: a.id,
            stopId: stop.id,
            outcome: a.outcome,
            failureReason: a.failureReason,
            recordedAt: a.recordedAt.toString(),
          });
      }
      incidents.push({ orderId: order.id, routeId: order.routeId, attempts });
    }
    return { date, timeZone: 'America/Guayaquil', urgencies, incidents };
  }
}
