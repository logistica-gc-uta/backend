import {
  Injectable,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { businessDay, nowInstant } from '../../common/temporal.util.js';
import { driverRouteDay } from '../drivers/driver-route-date.util.js';
import { evaluatePlanningEligibility } from '../orders/order-geography.util.js';
import { ShopSettingsService } from '../shop/settings/shop-settings.service.js';
import { StoreCoverageService } from '../store-coverage/store-coverage.service.js';
import {
  DEFAULT_ROUTE_CAPACITY,
  type RoutingOrder,
} from './algorithms/clarke-wright.js';
import { type GeoPoint, haversineKm } from './algorithms/geo.util.js';
import { indexByKey, matrixDistance, pointKey, uniquePoints, type DistanceMatrix } from './algorithms/matrix-distance.js';
import { RoadMetricsService } from './road/road-metrics.service.js';
import { RoadMetricsError, type RoadMatrix } from './road/road-metrics.types.js';
import { independentTripsKm, savingsFigures } from './algorithms/route-metrics.js';
import { RoutePlanner } from './route-planner.js';
import { ExclusionReason, type PlanningExclusionReason } from './planning-exclusion-reason.js';
import type { PlanRoutesQueryDto } from './dto/plan-routes-query.dto.js';
import type {
  ExcludedOrderDto,
  RouteProposalDto,
  RouteProposalResponseDto,
} from './dto/route-proposal-response.dto.js';

export const PLANNING_TIME_ZONE = 'America/Guayaquil';
export const DISTANCE_METHOD = 'HAVERSINE_STRAIGHT_LINE';
export const ROAD_DISTANCE_METHOD = 'OSRM_ROAD_NETWORK';
export const DEFAULT_TIME_WINDOW_MARGIN_MINUTES = 30;
/**
 * Clarke & Wright is O(n^2 log n) per zone (about 0.45 s for 1000 orders and
 * 5.9 s for 3000 on a development machine; see docs/clarke-wright.md). The cap
 * keeps a single request from blocking the event loop for seconds.
 */
export const MAX_ORDERS_PER_ZONE = 2000;

export { ExclusionReason };

/**
 * Builds TEMPORARY route proposals from PostgreSQL data. Read-only: it never
 * persists routes, claims or assignments. Confirming (DRAFT) and assigning a
 * driver are separate ADMIN operations (POST /routes, POST /routes/:id/assign).
 */
@Injectable()
export class RoutePlanningService implements OnModuleDestroy {
  /** Planificador compartido: cálculo en worker, memoizado y sin duplicar trabajo concurrente (P-1 de #15). */
  private readonly planner = new RoutePlanner();

  constructor(
    private readonly prisma: PrismaService,
    /** Motor vial (#47). Sin `ROAD_ENGINE=OSRM` conserva la línea recta de siempre. */
    private readonly roads: RoadMetricsService = new RoadMetricsService(),
    @Optional() private readonly storeCoverage?: StoreCoverageService,
    @Optional() private readonly shopSettings?: ShopSettingsService,
  ) {}

  /**
   * Matriz vial de la propuesta: depósitos + destinos únicos. Los errores que señalan puntos concretos se
   * traducen a los pedidos afectados para que el ADMIN sepa cuáles revisar.
   */
  private async roadMatrix(routable: RoutingOrder[], depots: Record<string, GeoPoint>) {
    const points = uniquePoints([...Object.values(depots), ...routable.map((order) => order.location)]);
    let matrix: RoadMatrix;
    try {
      matrix = (await this.roads.matrixFor(points))!;
    } catch (error) {
      if (error instanceof RoadMetricsError && Array.isArray(error.details.pointIndexes)) {
        const affected = new Set((error.details.pointIndexes as number[]).map((index) => pointKey(points[index]!)));
        const orderIds = routable.filter((order) => affected.has(pointKey(order.location))).map((order) => order.id).sort();
        throw new RoadMetricsError(error.code, error.message, { ...error.details, orderIds });
      }
      throw error;
    }
    const km: DistanceMatrix = {
      points: matrix.points,
      distanceKm: matrix.distancesM.map((row) => row.map((m) => m / 1000)),
      durationS: matrix.durationsS,
    };
    const index = indexByKey(matrix.points);
    const lookup = (a: GeoPoint, b: GeoPoint) => [index.get(pointKey(a))!, index.get(pointKey(b))!] as const;
    const roundKm = (value: number) => Math.round(value * 1000) / 1000;
    return {
      matrix,
      km,
      distanceKm: matrixDistance(km),
      /** Tramos consecutivos de una visita con su distancia y duración reales (en el sentido recorrido). */
      legs: (visit: GeoPoint[]) =>
        visit.slice(1).map((point, i) => {
          const [from, to] = lookup(visit[i]!, point);
          return { km: roundKm(matrix.distancesM[from]![to]! / 1000), seconds: Math.round(matrix.durationsS[from]![to]!) };
        }),
    };
  }

  /** Estado del motor vial para el ADMIN (sin exponer la URL ni credenciales). */
  roadEngineStatus() {
    return this.roads.status();
  }

  async onModuleDestroy(): Promise<void> {
    await this.planner.close();
  }

  async propose(query: PlanRoutesQueryDto): Promise<RouteProposalResponseDto> {
    const day = driverRouteDay(query.date)!;

    if (query.zoneId && !(await this.prisma.zone.where({ id: query.zoneId }).first())) {
      throw new NotFoundException(`Zone '${query.zoneId}' not found`);
    }

    const marginMinutes = this.shopSettings
      ? await this.shopSettings.getRouteTimeWindowMarginMinutes()
      : DEFAULT_TIME_WINDOW_MARGIN_MINUTES;
const STORE_ROUTE_GROUP_KEY = '__STORE__';

    const coverage = this.storeCoverage ? await this.storeCoverage.getCoverage() : null;
    const storeRow = !coverage
      ? await this.prisma.client.orm.public.StoreCoverage?.where({ singletonKey: 'GLOBAL' }).first()
      : null;
    const storeOrigin: GeoPoint | null = coverage?.configured
      ? { lat: coverage.location.lat, lng: coverage.location.lng }
      : storeRow && typeof storeRow.lat === 'number' && typeof storeRow.lng === 'number'
        ? { lat: storeRow.lat, lng: storeRow.lng }
        : null;

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
    const addresses = new Map<string, string>();
    const depots: Record<string, GeoPoint> = {};
    const zones = new Map<string, { zoneId: string | null; code: string | null }>();
    const perZone = new Map<string, number>();

    for (const order of candidates) {
      const { deliveryLocation, planningEligibility } =
        evaluatePlanningEligibility(order, order.zone, storeOrigin);
      const reasons: PlanningExclusionReason[] = [...planningEligibility.reasons];
      if (claimed.has(order.id)) reasons.push(ExclusionReason.ACTIVE_ROUTE_CLAIM);
      if (order.requiresAdministrativeReview) {
        reasons.push(ExclusionReason.ADMINISTRATIVE_REVIEW_REQUIRED);
      }
      const groupKey = order.zoneId ?? STORE_ROUTE_GROUP_KEY;
      const depot =
        storeOrigin ??
        (order.zone &&
        typeof order.zone.depotLat === 'number' &&
        typeof order.zone.depotLng === 'number'
          ? { lat: order.zone.depotLat, lng: order.zone.depotLng }
          : null);
      if (reasons.length || !deliveryLocation || !depot) {
        excluded.push({ orderId: order.id, zoneId: order.zoneId, reasons });
        continue;
      }

      const count = (perZone.get(groupKey) ?? 0) + 1;
      if (count > MAX_ORDERS_PER_ZONE) {
        throw new UnprocessableEntityException(
          `Zone '${order.zone?.code ?? 'STORE'}' has more than ${MAX_ORDERS_PER_ZONE} plannable orders for ${query.date}; narrow the request`,
        );
      }
      perZone.set(groupKey, count);

      depots[groupKey] = depot;
      zones.set(groupKey, { zoneId: order.zoneId ?? null, code: order.zone?.code ?? null });
      instants.set(order.id, order.scheduledDeliveryDate!.toString());
      addresses.set(order.id, order.deliveryAddress);
      routable.push({
        id: order.id,
        zoneId: groupKey,
        deliveryDate: query.date,
        location: deliveryLocation,
        scheduledAtMs: order.scheduledDeliveryDate!.epochMilliseconds,
      });
    }

    const locations = new Map(routable.map((order) => [order.id, order.location]));
    // Con el motor vial activo, toda la propuesta usa la red vial; si el motor falla se corta con un error
    // tipado (503/502/422) y no se genera ninguna propuesta con datos incompletos ni en línea recta.
    const road = this.roads.active ? await this.roadMatrix(routable, depots) : null;
    const planned = await this.planner.plan(routable, {
      depots,
      capacity: DEFAULT_ROUTE_CAPACITY,
      timeWindowMarginMinutes: marginMinutes,
      ...(road ? { matrix: road.km } : {}),
    });
    const proposals: RouteProposalDto[] = planned.map((route) => {
      // Instants are ISO strings of the same business day, sorted chronologically.
      const scheduledInstants = [
        ...new Set(route.orderIds.map((id) => instants.get(id)!)),
      ].sort((a, b) => Temporal.Instant.compare(Temporal.Instant.from(a), Temporal.Instant.from(b)));
      const depot = depots[route.zoneId]!;
      const stopPoints = route.orderIds.map((id) => locations.get(id)!);
      const savings = savingsFigures(
        independentTripsKm(stopPoints, depot, road ? road.distanceKm : undefined),
        route.totalDistance,
      );
      const legs = road ? road.legs([depot, ...stopPoints, depot]) : null;
      const zoneInfo = zones.get(route.zoneId)!;
      return {
        zoneId: zoneInfo.zoneId,
        zoneCode: zoneInfo.code,
        depot,
        orderIds: route.orderIds,
        stops: route.orderIds.map((orderId, index) => ({
          sequence: index + 1,
          orderId,
          location: locations.get(orderId)!,
          deliveryAddress: addresses.get(orderId)!,
          scheduledDeliveryDate: instants.get(orderId)!,
          ...(legs ? { legDistanceKm: legs[index]!.km, legDurationSeconds: legs[index]!.seconds } : {}),
        })),
        ...(legs
          ? {
              straightLineKm: savingsFigures(0, [depot, ...stopPoints, depot].slice(1).reduce((sum, point, i) => sum + haversineKm([depot, ...stopPoints, depot][i]!, point), 0)).plannedKm,
              totalDurationSeconds: Math.round(legs.reduce((sum, leg) => sum + leg.seconds, 0)),
              returnLegDistanceKm: legs[legs.length - 1]!.km,
              returnLegDurationSeconds: legs[legs.length - 1]!.seconds,
            }
          : {}),
        totalDistanceKm: savings.plannedKm,
        baselineKm: savings.baselineKm,
        savingsKm: savings.savingsKm,
        savingsPercent: savings.savingsPercent,
        scheduledInstants,
        // Earliest scheduled instant: any instant of the business day is accepted by POST /routes.
        routeDate: scheduledInstants[0]!,
      };
    });

    if (road && query.includeGeometry) {
      for (const proposal of proposals) {
        const trace = await this.roads.geometry([proposal.depot, ...proposal.stops.map((stop) => stop.location), proposal.depot]);
        proposal.geometry = { type: 'LineString', coordinates: trace.coordinates };
      }
    }

    excluded.sort((a, b) => a.orderId.localeCompare(b.orderId));
    // Daily totals add up the figures shown per proposal, so the sum on screen always matches.
    const daily = savingsFigures(
      proposals.reduce((sum, proposal) => sum + proposal.baselineKm, 0),
      proposals.reduce((sum, proposal) => sum + proposal.totalDistanceKm, 0),
    );
    const isToday = query.date === businessDay(nowInstant()).toString();
    return {
      date: query.date,
      timeZone: PLANNING_TIME_ZONE,
      isToday,
      canConfirm: isToday,
      capacity: DEFAULT_ROUTE_CAPACITY,
      timeWindowMarginMinutes: marginMinutes,
      distanceMethod: road ? ROAD_DISTANCE_METHOD : DISTANCE_METHOD,
      ...(road
        ? {
            roadMetrics: {
              provider: road.matrix.provider,
              profile: road.matrix.profile,
              distanceUnit: 'km' as const,
              durationUnit: 's' as const,
              directional: true,
              trafficAware: false,
              estimate: true,
              maxSnapDistanceM: Math.round(road.matrix.maxSnapDistanceM),
            },
          }
        : {}),
      proposals,
      excluded,
      summary: {
        candidateOrders: candidates.length,
        plannedOrders: routable.length,
        excludedOrders: excluded.length,
        routes: proposals.length,
        baselineKm: daily.baselineKm,
        plannedKm: daily.plannedKm,
        savingsKm: daily.savingsKm,
        savingsPercent: daily.savingsPercent,
      },
    };
  }
}
