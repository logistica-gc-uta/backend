import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { driverRouteDay } from '../drivers/driver-route-date.util.js';
import { evaluatePlanningEligibility } from '../orders/order-geography.util.js';
import {
  DEFAULT_ROUTE_CAPACITY,
  planRoutes,
  type RoutingOrder,
} from './algorithms/clarke-wright.js';
import type { GeoPoint } from './algorithms/geo.util.js';
import type { PlanRoutesQueryDto } from './dto/plan-routes-query.dto.js';
import type {
  ExcludedOrderDto,
  RouteProposalDto,
  RouteProposalResponseDto,
} from './dto/route-proposal-response.dto.js';

export const PLANNING_TIME_ZONE = 'America/Guayaquil';
export const DISTANCE_METHOD = 'HAVERSINE_STRAIGHT_LINE';
/**
 * Clarke & Wright is O(n^2 log n) per zone (about 0.45 s for 1000 orders and
 * 5.9 s for 3000 on a development machine; see docs/clarke-wright.md). The cap
 * keeps a single request from blocking the event loop for seconds.
 */
export const MAX_ORDERS_PER_ZONE = 2000;

export const ExclusionReason = {
  ACTIVE_ROUTE_CLAIM: 'ACTIVE_ROUTE_CLAIM',
  ADMINISTRATIVE_REVIEW_REQUIRED: 'ADMINISTRATIVE_REVIEW_REQUIRED',
} as const;

const roundKm = (km: number) => Math.round(km * 1000) / 1000;

/**
 * Builds TEMPORARY route proposals from PostgreSQL data. Read-only: it never
 * persists routes, claims or assignments. Confirming (DRAFT) and assigning a
 * driver are separate ADMIN operations (POST /routes, POST /routes/:id/assign).
 */
@Injectable()
export class RoutePlanningService {
  constructor(private readonly prisma: PrismaService) {}

  async propose(query: PlanRoutesQueryDto): Promise<RouteProposalResponseDto> {
    const day = driverRouteDay(query.date)!;

    if (query.zoneId && !(await this.prisma.zone.where({ id: query.zoneId }).first())) {
      throw new NotFoundException(`Zone '${query.zoneId}' not found`);
    }

    let orderQuery = this.prisma.order
      .where({ status: 'PENDING' })
      .where((order) => order.scheduledDeliveryDate.gte(day.start))
      .where((order) => order.scheduledDeliveryDate.lt(day.end));
    if (query.zoneId) orderQuery = orderQuery.where({ zoneId: query.zoneId });
    const candidates = await orderQuery.include('zone').all();

    const claimed = new Set<string>();
    if (candidates.length) {
      const claims = await this.prisma.client.orm.public.OrderClaim.where(
        (claim) => claim.orderId.in(candidates.map((order) => order.id)),
      )
        .where({ releasedAt: null })
        .all();
      for (const claim of claims) claimed.add(claim.orderId);
    }

    const excluded: ExcludedOrderDto[] = [];
    const routable: RoutingOrder[] = [];
    const instants = new Map<string, string>();
    const depots: Record<string, GeoPoint> = {};
    const zones = new Map<string, { code: string }>();
    const perZone = new Map<string, number>();

    for (const order of candidates) {
      const { deliveryLocation, planningEligibility } =
        evaluatePlanningEligibility(order, order.zone);
      const reasons: string[] = [...planningEligibility.reasons];
      if (claimed.has(order.id)) reasons.push(ExclusionReason.ACTIVE_ROUTE_CLAIM);
      if (order.requiresAdministrativeReview) {
        reasons.push(ExclusionReason.ADMINISTRATIVE_REVIEW_REQUIRED);
      }
      if (reasons.length || !deliveryLocation || !order.zone) {
        excluded.push({ orderId: order.id, zoneId: order.zoneId, reasons });
        continue;
      }

      const count = (perZone.get(order.zoneId) ?? 0) + 1;
      if (count > MAX_ORDERS_PER_ZONE) {
        throw new UnprocessableEntityException(
          `Zone '${order.zone.code}' has more than ${MAX_ORDERS_PER_ZONE} plannable orders for ${query.date}; narrow the request`,
        );
      }
      perZone.set(order.zoneId, count);

      depots[order.zoneId] = {
        lat: order.zone.depotLat as number,
        lng: order.zone.depotLng as number,
      };
      zones.set(order.zoneId, { code: order.zone.code });
      instants.set(order.id, order.scheduledDeliveryDate!.toString());
      routable.push({
        id: order.id,
        zoneId: order.zoneId,
        deliveryDate: query.date,
        location: deliveryLocation,
      });
    }

    const locations = new Map(routable.map((order) => [order.id, order.location]));
    const proposals: RouteProposalDto[] = planRoutes(routable, {
      depots,
      capacity: DEFAULT_ROUTE_CAPACITY,
    }).map((route) => {
      const scheduledInstants = [
        ...new Set(route.orderIds.map((id) => instants.get(id)!)),
      ].sort();
      const confirmable = scheduledInstants.length === 1;
      return {
        zoneId: route.zoneId,
        zoneCode: zones.get(route.zoneId)!.code,
        depot: depots[route.zoneId]!,
        orderIds: route.orderIds,
        stops: route.orderIds.map((orderId, index) => ({
          sequence: index + 1,
          orderId,
          location: locations.get(orderId)!,
          scheduledDeliveryDate: instants.get(orderId)!,
        })),
        totalDistanceKm: roundKm(route.totalDistance),
        scheduledInstants,
        confirmable,
        routeDate: confirmable ? scheduledInstants[0]! : null,
      };
    });

    excluded.sort((a, b) => a.orderId.localeCompare(b.orderId));
    return {
      date: query.date,
      timeZone: PLANNING_TIME_ZONE,
      capacity: DEFAULT_ROUTE_CAPACITY,
      distanceMethod: DISTANCE_METHOD,
      proposals,
      excluded,
      summary: {
        candidateOrders: candidates.length,
        plannedOrders: routable.length,
        excludedOrders: excluded.length,
        routes: proposals.length,
      },
    };
  }
}
