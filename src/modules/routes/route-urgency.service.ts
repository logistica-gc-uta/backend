import { createHash } from 'node:crypto';
import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  businessDay,
  isSameBusinessDay,
  nowInstant,
} from '../../common/temporal.util.js';
import {
  evaluatePlanningEligibility,
  orderBelongsToRouteZone,
  type GeoPoint,
} from '../orders/order-geography.util.js';
import { deliveryClock } from '../orders/order-delivery.util.js';
import { OrderStatus } from '../orders/dto/update-order-status.dto.js';
import { StoreCoverageService } from '../store-coverage/store-coverage.service.js';
import {
  canMutateRouteStructure,
  isOrderPlanningEligible,
  RouteStatus,
} from './route-lifecycle.policy.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import {
  DEFAULT_VEHICLE_CAPACITY,
  loadOrderDemandsMap,
  MAX_ROUTE_STOPS,
  resolveVehicleCapacity,
  routeLoadUnits,
} from './vehicle-capacity.js';
import {
  planRoutes,
  type RoutingOrder,
} from './algorithms/clarke-wright.js';
import { haversineKm } from './algorithms/geo.util.js';
import { matrixDistance, uniquePoints } from './algorithms/matrix-distance.js';
import { RoadMetricsService } from './road/road-metrics.service.js';
import { RoadMetricsError } from './road/road-metrics.types.js';
import {
  UrgencyInboxDto,
  UrgencyIncidentDto,
  UrgencyProposalDto,
} from './dto/urgency-response.dto.js';
import { projectIncidentInboxItem } from './incident-inbox-projection.js';

type Reader = Pick<PrismaService['client'], 'orm'>;

const STORE_URGENCY_GROUP_KEY = '__STORE__';

@Injectable()
export class RouteUrgencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: RouteAvailabilityService,
    /** Motor vial (#47). Sin `ROAD_ENGINE=OSRM` conserva la línea recta de siempre. */
    private readonly roads: RoadMetricsService = new RoadMetricsService(),
    @Optional()
    private readonly storeCoverage?: StoreCoverageService,
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
    const coverage = this.storeCoverage ? await this.storeCoverage.getCoverage() : null;
    const storeRow = !coverage
      ? await db.StoreCoverage?.where({ singletonKey: 'GLOBAL' }).first()
      : null;
    const storeOrigin: GeoPoint | null = coverage?.configured
      ? { lat: coverage.location.lat, lng: coverage.location.lng }
      : storeRow && typeof storeRow.lat === 'number' && typeof storeRow.lng === 'number'
        ? { lat: storeRow.lat, lng: storeRow.lng }
        : null;
    const zone = order.zoneId ? await db.Zone.where({ id: order.zoneId }).first() : null;
    const geography = evaluatePlanningEligibility(order, zone, storeOrigin);
    const reasons: string[] = [...geography.planningEligibility.reasons];
    const activeClaim = await db.OrderClaim.where({
      orderId,
      releasedAt: null,
    }).first();
    if (order.status !== 'PENDING') reasons.push('ORDER_NOT_PENDING');
    if (order.requiresAdministrativeReview)
      reasons.push('ADMINISTRATIVE_REVIEW_REQUIRED');
    if (activeClaim) reasons.push('ACTIVE_ROUTE_CLAIM');
    if (db.RouteUnitRecovery) {
      const recoveries = await db.RouteUnitRecovery.where({ orderId }).all();
      if (recoveries.length > 0) {
        const activeLosses = db.OrderItemLoss
          ? await db.OrderItemLoss.where({ orderId, cancelledAt: null }).all()
          : [];
        const resolved = recoveries.every((unit) => {
          if (unit.recoveredAt != null) return true;
          return activeLosses.some(
            (loss) =>
              loss.orderItemId === unit.orderItemId &&
              loss.unitNumber === unit.unitNumber &&
              loss.replacementPreparedAt != null,
          );
        });
        if (!resolved) reasons.push('RECOVERY_PENDING');
      }
    }
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
    const depot: GeoPoint | null =
      storeOrigin ??
      (zone && typeof zone.depotLat === 'number' && typeof zone.depotLng === 'number'
        ? { lat: zone.depotLat, lng: zone.depotLng }
        : null);
    if (reasons.length || !depot || !geography.deliveryLocation) return base;
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
    const computeOrderDemands = (orderIds: readonly string[]) =>
      loadOrderDemandsMap(db.OrderItem, orderIds);
    const make = async (
      orders: (typeof order)[],
      routeId: string | null,
      routeDate: string,
      evidence: unknown,
      targetCapacity: number,
    ) => {
      const routingGroupKey = order.zoneId ?? STORE_URGENCY_GROUP_KEY;
      const demandsByOrder = await computeOrderDemands(orders.map((o) => o.id));
      const routing: RoutingOrder[] = orders.map((o) => ({
        id: o.id,
        zoneId: routingGroupKey,
        deliveryDate: date,
        location: { lat: o.deliveryLat!, lng: o.deliveryLng! },
        demandUnits: demandsByOrder.get(o.id) ?? 1,
      }));
      const effectiveCapacity = Math.max(
        targetCapacity,
        ...routing.map((r) => r.demandUnits ?? 1),
      );
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
        depots: { [routingGroupKey]: depot },
        capacity: effectiveCapacity,
        maxStops: MAX_ROUTE_STOPS,
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
    const routes = await db.Route.all();
    for (const route of [...routes].sort((a, b) => a.id.localeCompare(b.id))) {
      if (
        !orderBelongsToRouteZone(order.zoneId, route.zoneId) ||
        !canMutateRouteStructure(route.status as RouteStatus | null) ||
        !isSameBusinessDay(route.date, order.scheduledDeliveryDate!)
      )
        continue;
      const stops = (
        await db.RouteStop.where({ routeId: route.id }).all()
      ).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      if (
        !stops.length ||
        stops.length >= MAX_ROUTE_STOPS ||
        stops.some(
          (s, i) =>
            s.isLegacy || s.outcome !== 'PENDING' || s.sequence !== i + 1,
        )
      )
        continue;
      const routeDriver =
        route.driverId && db.Driver && typeof db.Driver.where === 'function'
          ? await db.Driver.where({ id: route.driverId }).first()
          : null;
      const targetCapacity = resolveVehicleCapacity(
        routeDriver?.vehicleCapacity,
      );
      const claims = await db.OrderClaim.where({
        routeId: route.id,
        releasedAt: null,
      }).all();
      if (claims.length !== stops.length) continue;
      const routeZone = route.zoneId
        ? await db.Zone.where({ id: route.zoneId }).first()
        : null;
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
        const currentZone = current?.zoneId
          ? await db.Zone.where({ id: current.zoneId }).first()
          : routeZone;
        if (
          !current ||
          !eligible ||
          !claim ||
          !orderBelongsToRouteZone(current.zoneId, route.zoneId) ||
          !orderBelongsToRouteZone(current.zoneId, order.zoneId) ||
          !current.scheduledDeliveryDate ||
          !isSameBusinessDay(current.scheduledDeliveryDate, route.date) ||
          !evaluatePlanningEligibility(current, currentZone, storeOrigin)
            .planningEligibility.eligible
        )
          break;
        orders.push(current);
      }
      if (orders.length !== stops.length + 1) continue;
      const demandsByOrder = await computeOrderDemands(orders.map((o) => o.id));
      const candidateLoadUnits = routeLoadUnits(
        orders.map((o) => demandsByOrder.get(o.id) ?? 1),
      );
      if (candidateLoadUnits > targetCapacity) continue;
      return await make(
        orders,
        route.id,
        route.date.toString(),
        {
          status: route.status,
          driverId: route.driverId,
          stops: stops.map((s) => ({
            id: s.id,
            sequence: s.sequence,
            orderId: s.orderId,
          })),
          claims: claims.map((c) => c.id).sort(),
        },
        targetCapacity,
      );
    }
    const proposal = await make(
      [order],
      null,
      order.scheduledDeliveryDate!.toString(),
      null,
      DEFAULT_VEHICLE_CAPACITY,
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

  private async withIncidentSnapshot<T>(
    read: (
      db: PrismaService['client']['orm']['public'],
      now: Temporal.Instant,
    ) => Promise<T>,
    fallbackNow: Temporal.Instant,
  ): Promise<T> {
    const client = this.prisma.client;
    if (typeof client.transaction === 'function' && client.raw?.sql) {
      return client.transaction(async (tx) => {
        await tx.execute(
          client.raw.sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
            .affectedCount()
            .build(),
        );
        const snapshotNow = await deliveryClock(tx, client.raw);
        return read(tx.orm.public, snapshotNow);
      });
    }
    return read(client.orm.public, fallbackNow);
  }

  async inbox(): Promise<UrgencyInboxDto> {
    const now = nowInstant();
    const date = businessDay(now).toString();
    const db = this.prisma.client.orm.public;
    const urgencies: UrgencyProposalDto[] = [];
    for (const order of await db.Order.where({ status: 'PENDING' }).all()) {
      if (
        order.scheduledDeliveryDate &&
        businessDay(order.scheduledDeliveryDate).toString() === date &&
        !order.requiresAdministrativeReview
      )
        urgencies.push(await this.propose(order.id));
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

    const { incidents, interruptedRoutes, pendingRecoveries } =
      await this.withIncidentSnapshot(async (snapshotDb, snapshotNow) => {
        const emergencies = snapshotDb.RouteEmergency
          ? await snapshotDb.RouteEmergency.all()
          : [];
        const emergencyByRoute = new Map(emergencies.map((e) => [e.routeId, e]));
        const emergencyById = new Map(emergencies.map((e) => [e.id, e]));
        const allRecoveries = snapshotDb.RouteUnitRecovery
          ? await snapshotDb.RouteUnitRecovery.all()
          : [];
        const recoveriesByOrder = new Map<string, typeof allRecoveries>();
        for (const rec of allRecoveries) {
          const list = recoveriesByOrder.get(rec.orderId) ?? [];
          list.push(rec);
          recoveriesByOrder.set(rec.orderId, list);
        }
        const activeLossByOrder = new Map<
          string,
          Awaited<ReturnType<typeof snapshotDb.OrderItemLoss.all>>
        >();
        const recoveryOrderIds = [...recoveriesByOrder.keys()];
        if (snapshotDb.OrderItemLoss && recoveryOrderIds.length > 0) {
          const recoveryOrderIdSet = new Set(recoveryOrderIds);
          const losses = (
            await snapshotDb.OrderItemLoss.where((l) =>
              l.orderId.in(recoveryOrderIds),
            )
              .where({ cancelledAt: null })
              .all()
          ).filter(
            (l) => recoveryOrderIdSet.has(l.orderId) && l.cancelledAt == null,
          );
          for (const loss of losses) {
            const list = activeLossByOrder.get(loss.orderId) ?? [];
            list.push(loss);
            activeLossByOrder.set(loss.orderId, list);
          }
        }

        const reviewOrders = await snapshotDb.Order.where({
          requiresAdministrativeReview: true,
        }).all();
        const projectedIncidents: UrgencyIncidentDto[] = [];
        if (reviewOrders.length > 0) {
          const reviewOrderIds = reviewOrders.map((o) => o.id);
          const reviewOrderIdSet = new Set(reviewOrderIds);

          const allReviewStops = (
            await snapshotDb.RouteStop.where((s) =>
              s.orderId.in(reviewOrderIds),
            ).all()
          ).filter((s) => reviewOrderIdSet.has(s.orderId));
          const stopsByOrder = new Map<string, typeof allReviewStops>();
          for (const stop of allReviewStops) {
            const list = stopsByOrder.get(stop.orderId) ?? [];
            list.push(stop);
            stopsByOrder.set(stop.orderId, list);
          }

          const stopIds = allReviewStops.map((s) => s.id);
          const stopIdSet = new Set(stopIds);
          const allFailedAttempts =
            stopIds.length > 0
              ? (
                  await snapshotDb.DeliveryAttempt.where((a) =>
                    a.stopId.in(stopIds),
                  )
                    .where({ outcome: 'FAILED' })
                    .all()
                ).filter((a) => stopIdSet.has(a.stopId) && a.outcome === 'FAILED')
              : [];
          const failedAttemptsByStop = new Map<
            string,
            typeof allFailedAttempts
          >();
          for (const attempt of allFailedAttempts) {
            const list = failedAttemptsByStop.get(attempt.stopId) ?? [];
            list.push(attempt);
            failedAttemptsByStop.set(attempt.stopId, list);
          }

          const allPickups = snapshotDb.OrderPickup
            ? (
                await snapshotDb.OrderPickup.where((p) =>
                  p.orderId.in(reviewOrderIds),
                ).all()
              ).filter((p) => reviewOrderIdSet.has(p.orderId))
            : [];
          const pickupByOrder = new Map(allPickups.map((p) => [p.orderId, p]));

          const allClaims = snapshotDb.OrderClaim
            ? (
                await snapshotDb.OrderClaim.where((c) =>
                  c.orderId.in(reviewOrderIds),
                ).all()
              ).filter((c) => reviewOrderIdSet.has(c.orderId))
            : [];
          const claimsByOrder = new Map<string, typeof allClaims>();
          for (const claim of allClaims) {
            const list = claimsByOrder.get(claim.orderId) ?? [];
            list.push(claim);
            claimsByOrder.set(claim.orderId, list);
          }

          const referencedRouteIds = [
            ...new Set([
              ...allReviewStops.map((s) => s.routeId),
              ...reviewOrders
                .map((o) => o.routeId)
                .filter(
                  (id): id is string =>
                    typeof id === 'string' && id.length > 0,
                ),
              ...allClaims.map((c) => c.routeId),
            ]),
          ];
          const referencedRouteIdSet = new Set(referencedRouteIds);
          const referencedRoutes =
            referencedRouteIds.length > 0 && snapshotDb.Route
              ? (
                  await snapshotDb.Route.where((r) =>
                    r.id.in(referencedRouteIds),
                  ).all()
                ).filter((r) => referencedRouteIdSet.has(r.id))
              : [];
          const routesById = new Map(referencedRoutes.map((r) => [r.id, r]));

          const incidentAudits = snapshotDb.DispatchIntervention
            ? (
                await snapshotDb.DispatchIntervention.where((a) =>
                  a.orderId.in(reviewOrderIds),
                )
                  .where({ outcome: 'APPLIED' })
                  .all()
              ).filter(
                (a) =>
                  a.orderId !== null &&
                  reviewOrderIdSet.has(a.orderId) &&
                  a.outcome === 'APPLIED',
              )
            : [];
          const auditsByOrder = new Map<string, typeof incidentAudits>();
          for (const audit of incidentAudits) {
            if (!audit.orderId) continue;
            const list = auditsByOrder.get(audit.orderId) ?? [];
            list.push(audit);
            auditsByOrder.set(audit.orderId, list);
          }

          const referencedZoneIds = [
            ...new Set(
              reviewOrders
                .map((o) => o.zoneId)
                .filter(
                  (id): id is string =>
                    typeof id === 'string' && id.length > 0,
                ),
            ),
          ];
          const referencedZoneIdSet = new Set(referencedZoneIds);
          const referencedZones =
            referencedZoneIds.length > 0 && snapshotDb.Zone
              ? (
                  await snapshotDb.Zone.where((z) =>
                    z.id.in(referencedZoneIds),
                  ).all()
                ).filter((z) => referencedZoneIdSet.has(z.id))
              : [];
          const zonesById = new Map(referencedZones.map((z) => [z.id, z]));

          const storeRow = snapshotDb.StoreCoverage
            ? await snapshotDb.StoreCoverage.where({
                singletonKey: 'GLOBAL',
              }).first()
            : null;
          const coverage =
            !snapshotDb.StoreCoverage && this.storeCoverage
              ? await this.storeCoverage.getCoverage()
              : null;
          const storeOrigin: GeoPoint | null =
            storeRow &&
            typeof storeRow.lat === 'number' &&
            typeof storeRow.lng === 'number'
              ? { lat: storeRow.lat, lng: storeRow.lng }
              : coverage?.configured
                ? { lat: coverage.location.lat, lng: coverage.location.lng }
                : null;

          for (const order of reviewOrders) {
            const orderStops = stopsByOrder.get(order.id) ?? [];
            const orderFailedAttempts: typeof allFailedAttempts = [];
            const attempts = [];
            for (const stop of orderStops) {
              for (const a of failedAttemptsByStop.get(stop.id) ?? []) {
                orderFailedAttempts.push(a);
                attempts.push({
                  id: a.id,
                  stopId: stop.id,
                  outcome: a.outcome,
                  failureReason: a.failureReason,
                  recordedAt: a.recordedAt.toString(),
                });
              }
            }
            // Retiro en tienda (#50): el ADMIN ve qué pedidos esperan el retiro y cuáles ya se retiraron.
            const pickup = pickupByOrder.get(order.id) ?? null;
            const projection = projectIncidentInboxItem({
              order,
              stops: orderStops,
              failedAttempts: orderFailedAttempts,
              routesById,
              orderClaims: claimsByOrder.get(order.id) ?? [],
              pickup,
              audits: auditsByOrder.get(order.id) ?? [],
              unitRecoveries: recoveriesByOrder.get(order.id) ?? [],
              emergenciesById: emergencyById,
              activeLosses: activeLossByOrder.get(order.id) ?? [],
              zone: order.zoneId ? (zonesById.get(order.zoneId) ?? null) : null,
              storeOrigin,
              now: snapshotNow,
            });
            projectedIncidents.push({
              orderId: order.id,
              routeId: order.routeId ?? null,
              attempts,
              pickup: pickup
                ? {
                    state: pickup.confirmedAt
                      ? ('PICKED_UP' as const)
                      : ('PENDING_PICKUP' as const),
                    agreedAt: pickup.agreedAt.toString(),
                    pickedUpAt: pickup.confirmedAt
                      ? pickup.confirmedAt.toString()
                      : null,
                  }
                : null,
              ...projection,
            });
          }
        }

        const allInterruptedRoutes = snapshotDb.Route
          ? (
              await snapshotDb.Route.where({ status: 'INTERRUPTED' }).all()
            ).sort((a, b) => a.id.localeCompare(b.id))
          : [];
        const snapshotPendingRecoveries = allRecoveries
          .filter((unit) => {
            if (unit.recoveredAt != null) return false;
            const losses = activeLossByOrder.get(unit.orderId) ?? [];
            const activeLoss = losses.find(
              (l) =>
                l.orderItemId === unit.orderItemId &&
                l.unitNumber === unit.unitNumber,
            );
            return !activeLoss || activeLoss.replacementPreparedAt == null;
          })
          .sort(
            (a, b) =>
              a.routeId.localeCompare(b.routeId) ||
              a.orderId.localeCompare(b.orderId) ||
              a.orderItemId.localeCompare(b.orderItemId) ||
              a.unitNumber - b.unitNumber,
          )
          .map((unit) => {
            const losses = activeLossByOrder.get(unit.orderId) ?? [];
            const activeLoss = losses.find(
              (l) =>
                l.orderItemId === unit.orderItemId &&
                l.unitNumber === unit.unitNumber,
            );
            return {
              recoveryId: unit.id,
              emergencyId: unit.emergencyId,
              routeId: unit.routeId,
              orderId: unit.orderId,
              orderItemId: unit.orderItemId,
              unitNumber: unit.unitNumber,
              productId: unit.productId,
              lossId: activeLoss?.id ?? null,
              replacementState: activeLoss
                ? activeLoss.replacementPreparedAt != null
                  ? ('PREPARED' as const)
                  : ('PENDING' as const)
                : null,
            };
          });
        const snapshotInterruptedRoutes = allInterruptedRoutes.map((route) => {
          const emergency = emergencyByRoute.get(route.id) ?? null;
          const routeUnits = allRecoveries.filter(
            (u) => u.routeId === route.id,
          );
          const pendingCount = snapshotPendingRecoveries.filter(
            (u) => u.routeId === route.id,
          ).length;
          return {
            routeId: route.id,
            emergencyId: emergency?.id ?? null,
            declaredAt: emergency?.declaredAt?.toString() ?? null,
            closedAt: emergency?.closedAt?.toString() ?? null,
            driverId: route.driverId ?? null,
            returnedAt: route.returnedAt?.toString() ?? null,
            pendingUnitsCount: pendingCount,
            totalUnitsCount: routeUnits.length,
          };
        });

        return {
          incidents: projectedIncidents,
          interruptedRoutes: snapshotInterruptedRoutes,
          pendingRecoveries: snapshotPendingRecoveries,
        };
      }, now);

    return {
      date,
      timeZone: 'America/Guayaquil',
      urgencies,
      incidents,
      interruptedRoutes,
      pendingRecoveries,
    };
  }
}
