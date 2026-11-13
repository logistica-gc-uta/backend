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
import { matrixDistance, uniquePoints } from './algorithms/matrix-distance.js';
import { RoadMetricsService } from './road/road-metrics.service.js';
import { RoadMetricsError } from './road/road-metrics.types.js';
import { UrgencyProposalDto } from './dto/urgency-response.dto.js';

type Reader = Pick<PrismaService['client'], 'orm'>;

@Injectable()
export class RouteUrgencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: RouteAvailabilityService,
    /** Motor vial (#47). Sin `ROAD_ENGINE=OSRM` conserva la línea recta de siempre. */
    private readonly roads: RoadMetricsService = new RoadMetricsService(),
  ) {}

  /**
   * Con el motor vial activo, si el motor falla la urgencia queda BLOQUEADA con el código del error:
   * no se propone una nueva salida con distancias inexistentes ni en línea recta, y el pedido sigue pendiente.
   */
  async propose(
    orderId: string,
    reader: Reader = this.prisma.client,
  ): Promise<UrgencyProposalDto> {
    try {
      return await this.proposeWithEngine(orderId, reader);
    } catch (error) {
      if (!(error instanceof RoadMetricsError)) throw error;
      const order = await reader.orm.public.Order.where({ id: orderId }).first();
      return {
        orderId,
        date: businessDay(nowInstant()).toString(),
        timeZone: 'America/Guayaquil',
        kind: 'BLOCKED',
        routeId: null,
        zoneId: order?.zoneId ?? null,
        routeDate: order?.scheduledDeliveryDate?.toString() ?? null,
        orderIds: [],
        stops: [],
        availableDriverIds: [],
        reasons: [error.code],
        totalDistanceKm: 0,
        fingerprint: '',
      };
    }
  }

  // No proposal/claim/route is persisted. Confirmation must re-read under locks.
  private async proposeWithEngine(
    orderId: string,
    reader: Reader,
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
    const make = async (
      orders: (typeof order)[],
      routeId: string | null,
      routeDate: string,
      evidence: unknown,
    ) => {
      const routing: RoutingOrder[] = orders.map((o) => {
        if (!o.zoneId) {
          throw new Error('Urgent dispatch grouping requires a persisted zoneId');
        }
        return {
          id: o.id,
          zoneId: o.zoneId,
          deliveryDate: date,
          location: { lat: o.deliveryLat!, lng: o.deliveryLng! },
        };
      });
      // Degenerate/zero-savings groups can produce separate tours; flatten the
      // deterministic tours since all validated candidates already fit one vehicle.
      // Con el motor vial, la matriz se pide una sola vez y sirve para agrupar y para medir la visita.
      const matrixPoints = uniquePoints([depot, ...routing.map((o) => o.location)]);
      const roadMatrix = this.roads.active ? await this.roads.matrixFor(matrixPoints) : null;
      const km = roadMatrix
        ? { points: roadMatrix.points, distanceKm: roadMatrix.distancesM.map((row) => row.map((m) => m / 1000)) }
        : null;
      const distanceFn = km ? matrixDistance(km) : haversineKm;
      const ids = planRoutes(routing, {
        depots: { [zone.id]: depot },
        capacity: DEFAULT_ROUTE_CAPACITY,
        ...(km ? { distance: distanceFn, directional: true } : {}),
      }).flatMap((r) => r.orderIds);
      const locations = new Map(routing.map((o) => [o.id, o.location]));
      const points = [depot, ...ids.map((id) => locations.get(id)!), depot];
      const distance = points
        .slice(1)
        .reduce((sum, p, i) => sum + distanceFn(points[i]!, p), 0);
      return {
        ...base,
        kind: routeId ? ('INSERT' as const) : ('NEW_ROUTE' as const),
        routeId,
        routeDate,
        orderIds: ids,
        stops: ids.map((id, i) => ({ orderId: id, sequence: i + 1 })),
        totalDistanceKm: Math.round(distance * 1000) / 1000,
        distanceMethod: km ? 'OSRM_ROAD_NETWORK' : 'HAVERSINE_STRAIGHT_LINE',
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
      return await make(orders, route.id, route.date.toString(), {
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
    const proposal = await make(
      [order],
      null,
      order.scheduledDeliveryDate!.toString(),
      null,
    );
    for (const driver of await db.Driver.all()) {
      if (
        (await db.User.where({ id: driver.userId, role: 'DRIVER' }).first()) &&
        (await this.availability.effective(driver.id, reader, businessDay(order.scheduledDeliveryDate!))).isAvailable
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
      pickup: { state: 'PENDING_PICKUP' | 'PICKED_UP'; agreedAt: string; pickedUpAt: string | null } | null;
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
      // Retiro en tienda (#50): el ADMIN ve qué pedidos esperan el retiro y cuáles ya se retiraron.
      const pickup = await db.OrderPickup.where({ orderId: order.id }).first();
      incidents.push({
        orderId: order.id,
        routeId: order.routeId,
        attempts,
        pickup: pickup
          ? {
              state: pickup.confirmedAt ? ('PICKED_UP' as const) : ('PENDING_PICKUP' as const),
              agreedAt: pickup.agreedAt.toString(),
              pickedUpAt: pickup.confirmedAt ? pickup.confirmedAt.toString() : null,
            }
          : null,
      });
    }
    const priorities = new Map<string, string>();
    for (const a of await db.DispatchIntervention.where({
      action: 'PRIORITIZE',
      outcome: 'APPLIED',
    }).all()) {
      if (
        a.orderId &&
        (!priorities.has(a.orderId) ||
          a.recordedAt.toString() > priorities.get(a.orderId)!)
      )
        priorities.set(a.orderId, a.recordedAt.toString());
    }
    urgencies.sort(
      (a, b) =>
        (priorities.get(b.orderId) ?? '').localeCompare(
          priorities.get(a.orderId) ?? '',
        ) || a.orderId.localeCompare(b.orderId),
    );
    return { date, timeZone: 'America/Guayaquil', urgencies, incidents };
  }
}
