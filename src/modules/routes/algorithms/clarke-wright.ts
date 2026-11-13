import { type GeoPoint, haversineKm } from './geo.util.js';

export interface RoutingOrder {
  id: string;
  zoneId: string;
  /** Fecha de entrega (YYYY-MM-DD). Pedidos de fechas distintas nunca comparten ruta. */
  deliveryDate: string;
  location: GeoPoint;
  /** Instante programado de entrega en milisegundos desde época Unix (opcional). */
  scheduledAtMs?: number;
}

export type DistanceFn = (a: GeoPoint, b: GeoPoint) => number;

export interface ClarkeWrightOptions {
  /** Punto de salida (depósito) de cada zona. */
  depots: Record<string, GeoPoint>;
  /** Máximo de pedidos por ruta. Por defecto 4 (regla de negocio). */
  capacity?: number;
  /** Función de distancia en km. Por defecto Haversine en km. */
  distance?: DistanceFn;
  /** Función de duración en segundos para priorizar el costo vial (opcional). */
  duration?: DistanceFn;
  /** Margen máximo (en minutos) entre extremos horarios de una misma ruta (opcional). */
  timeWindowMarginMinutes?: number;
  /**
   * Las distancias NO son simétricas (matriz vial con sentidos de calle). Las decisiones de agrupación usan el
   * promedio de ambos sentidos y el recorrido final se mide, y se orienta, con el sentido real de cada tramo.
   * Con Haversine (simétrica) no hace falta y el resultado no cambia.
   */
  directional?: boolean;
}

export interface PlannedRoute {
  zoneId: string;
  deliveryDate: string;
  /** IDs de pedidos en el orden en que se visitan (stopOrder = índice + 1). */
  orderIds: string[];
  /** Distancia del recorrido completo depósito → paradas → depósito. */
  totalDistance: number;
}

export const DEFAULT_ROUTE_CAPACITY = 4;
const EXACT_BUCKET_PERMUTATION_LIMIT = 120;

interface Saving {
  i: number;
  j: number;
  primary: number;
  secondary: number;
}

interface EmittedRoute {
  planned: PlannedRoute;
  earliestScheduledAtMs: number;
}

/**
 * Arma rutas con la heurística de ahorros de Clarke & Wright (1964) para el
 * VRP con capacidad: agrupa por zona y fecha (y por ventanas horarias compatibles
 * si se especifica `timeWindowMarginMinutes`), parte con una ruta por pedido y
 * fusiona rutas por mayor ahorro sin superar la capacidad.
 *
 * Es una función pura y determinista: no accede a la base de datos.
 */
export function planRoutes(orders: RoutingOrder[], options: ClarkeWrightOptions): PlannedRoute[] {
  const capacity = options.capacity ?? DEFAULT_ROUTE_CAPACITY;
  const distance = options.distance ?? haversineKm;
  const duration = options.duration;

  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error('La capacidad por ruta debe ser un entero mayor o igual a 1');
  }
  if (
    options.timeWindowMarginMinutes !== undefined &&
    (!Number.isInteger(options.timeWindowMarginMinutes) || options.timeWindowMarginMinutes < 0)
  ) {
    throw new Error('El margen de ventana horaria debe ser un entero no negativo');
  }
  const marginMs =
    options.timeWindowMarginMinutes !== undefined ? options.timeWindowMarginMinutes * 60_000 : undefined;

  const seen = new Set<string>();
  for (const order of orders) {
    if (seen.has(order.id)) {
      throw new Error(`Pedido duplicado en la entrada: '${order.id}'`);
    }
    if (order.scheduledAtMs !== undefined && !Number.isFinite(order.scheduledAtMs)) {
      throw new Error(`Instante programado inválido para el pedido '${order.id}'`);
    }
    seen.add(order.id);
  }

  const groups = new Map<string, RoutingOrder[]>();
  for (const order of orders) {
    const key = `${order.zoneId}|${order.deliveryDate}`;
    const group = groups.get(key);
    if (group) {
      group.push(order);
    } else {
      groups.set(key, [order]);
    }
  }

  const decisionDistance: DistanceFn = options.directional
    ? (a, b) => (distance(a, b) + distance(b, a)) / 2
    : distance;
  const decisionDuration: DistanceFn | undefined = duration
    ? options.directional
      ? (a, b) => (duration(a, b) + duration(b, a)) / 2
      : duration
    : undefined;

  const emitted: EmittedRoute[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const { zoneId, deliveryDate } = group[0]!;
    const depot = options.depots[zoneId];
    if (!depot) {
      throw new Error(`No hay depósito definido para la zona '${zoneId}'`);
    }

    const subgroups = marginMs !== undefined ? partitionByTimeWindow(group, marginMs) : [group];
    for (const subgroup of subgroups) {
      const plannedGroup = planGroup(
        subgroup,
        depot,
        capacity,
        decisionDistance,
        decisionDuration,
        distance,
        duration,
        Boolean(options.directional),
      );
      for (const route of plannedGroup) {
        emitted.push({
          planned: {
            zoneId,
            deliveryDate,
            orderIds: route.map((order) => order.id),
            totalDistance: routeDistance(route, depot, distance),
          },
          earliestScheduledAtMs: earliestScheduledMs(route),
        });
      }
    }
  }

  emitted.sort(compareEmittedRoutes);
  return emitted.map((entry) => entry.planned);
}

function compareEmittedRoutes(a: EmittedRoute, b: EmittedRoute): number {
  const keyA = `${a.planned.zoneId}|${a.planned.deliveryDate}`;
  const keyB = `${b.planned.zoneId}|${b.planned.deliveryDate}`;
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (a.earliestScheduledAtMs !== b.earliestScheduledAtMs) {
    return a.earliestScheduledAtMs - b.earliestScheduledAtMs;
  }
  return (a.planned.orderIds[0] ?? '').localeCompare(b.planned.orderIds[0] ?? '');
}

function earliestScheduledMs(route: RoutingOrder[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const order of route) {
    if (order.scheduledAtMs !== undefined && order.scheduledAtMs < min) {
      min = order.scheduledAtMs;
    }
  }
  return min;
}

/**
 * Particiona pedidos del mismo día y zona por extremos horarios (`max - min <= marginMs`, inclusivo),
 * sin encadenar vecinos. Los pedidos sin hora programada (si los hubiera) van en un subgrupo final.
 */
function partitionByTimeWindow(group: RoutingOrder[], marginMs: number): RoutingOrder[][] {
  const scheduled: RoutingOrder[] = [];
  const unscheduled: RoutingOrder[] = [];
  for (const order of group) {
    if (order.scheduledAtMs !== undefined) {
      scheduled.push(order);
    } else {
      unscheduled.push(order);
    }
  }

  scheduled.sort((a, b) => a.scheduledAtMs! - b.scheduledAtMs! || a.id.localeCompare(b.id));

  const subgroups: RoutingOrder[][] = [];
  let cluster: RoutingOrder[] = [];
  let clusterMinMs = 0;

  for (const order of scheduled) {
    const t = order.scheduledAtMs!;
    if (cluster.length === 0) {
      cluster = [order];
      clusterMinMs = t;
    } else if (t - clusterMinMs <= marginMs) {
      cluster.push(order);
    } else {
      subgroups.push(cluster);
      cluster = [order];
      clusterMinMs = t;
    }
  }
  if (cluster.length > 0) subgroups.push(cluster);
  if (unscheduled.length > 0) subgroups.push(unscheduled);
  return subgroups;
}

function planGroup(
  group: RoutingOrder[],
  depot: GeoPoint,
  capacity: number,
  decisionDistance: DistanceFn,
  decisionDuration: DistanceFn | undefined,
  realDistance: DistanceFn,
  realDuration: DistanceFn | undefined,
  directional: boolean,
): RoutingOrder[][] {
  // Orden por id: el resultado no depende del orden de llegada de los pedidos.
  const orders = [...group].sort((a, b) => a.id.localeCompare(b.id));

  const routes = new Map<number, number[]>();
  const routeOf: number[] = [];
  orders.forEach((_, index) => {
    routes.set(index, [index]);
    routeOf.push(index);
  });

  const toDepotDist = orders.map((order) => decisionDistance(depot, order.location));
  const toDepotDur = decisionDuration ? orders.map((order) => decisionDuration(depot, order.location)) : undefined;

  const savings: Saving[] = [];
  for (let i = 0; i < orders.length; i++) {
    for (let j = i + 1; j < orders.length; j++) {
      const distSaving =
        toDepotDist[i]! + toDepotDist[j]! - decisionDistance(orders[i]!.location, orders[j]!.location);
      if (decisionDuration && toDepotDur) {
        const durSaving =
          toDepotDur[i]! + toDepotDur[j]! - decisionDuration(orders[i]!.location, orders[j]!.location);
        if (durSaving > 0 || (durSaving === 0 && distSaving > 0)) {
          savings.push({ i, j, primary: durSaving, secondary: distSaving });
        }
      } else if (distSaving > 0) {
        savings.push({ i, j, primary: distSaving, secondary: 0 });
      }
    }
  }
  savings.sort((a, b) => b.primary - a.primary || b.secondary - a.secondary || a.i - b.i || a.j - b.j);

  for (const { i, j } of savings) {
    const routeI = routeOf[i]!;
    const routeJ = routeOf[j]!;
    if (routeI === routeJ) continue;

    const a = routes.get(routeI)!;
    const b = routes.get(routeJ)!;
    if (a.length + b.length > capacity) continue;

    // Solo se pueden unir rutas por sus extremos.
    const iIsEnd = a[0] === i || a[a.length - 1] === i;
    const jIsEnd = b[0] === j || b[b.length - 1] === j;
    if (!iIsEnd || !jIsEnd) continue;

    if (a[a.length - 1] !== i) a.reverse();
    if (b[0] !== j) b.reverse();

    const merged = a.concat(b);
    routes.set(routeI, merged);
    routes.delete(routeJ);
    for (const index of b) routeOf[index] = routeI;
  }

  return [...routes.values()].map((indexes) => {
    const route = indexes.map((index) => orders[index]!);
    if (route.some((order) => order.scheduledAtMs !== undefined)) {
      return orderScheduledRoute(route, depot, realDistance, realDuration);
    }
    return orientUnscheduledRoute(route, depot, decisionDistance, realDistance, realDuration, directional);
  });
}

function orientUnscheduledRoute(
  route: RoutingOrder[],
  depot: GeoPoint,
  decisionDistance: DistanceFn,
  realDistance: DistanceFn,
  realDuration: DistanceFn | undefined,
  directional: boolean,
): RoutingOrder[] {
  if (directional) {
    // Con sentidos de calle, cada orientación cuesta distinto: se elige la de menor recorrido real.
    const reversed = [...route].reverse();
    if (realDuration) {
      const revDur = routeDistance(reversed, depot, realDuration);
      const fwdDur = routeDistance(route, depot, realDuration);
      if (revDur !== fwdDur) return revDur < fwdDur ? reversed : route;
    }
    return routeDistance(reversed, depot, realDistance) < routeDistance(route, depot, realDistance) ? reversed : route;
  }

  if (realDuration) {
    const firstDur = realDuration(depot, route[0]!.location);
    const lastDur = realDuration(depot, route[route.length - 1]!.location);
    if (firstDur !== lastDur) return lastDur < firstDur ? route.reverse() : route;
  }

  // Se recorre primero la parada más cercana al depósito.
  const first = decisionDistance(depot, route[0]!.location);
  const last = decisionDistance(depot, route[route.length - 1]!.location);
  return last < first ? route.reverse() : route;
}

/**
 * Ordena las paradas de una ruta con horario programado: estrictamente cronológico
 * (`scheduledAtMs` ascendente) y, dentro de cada instante compartido, minimizando el costo
 * real de ida y vuelta (`duration` primario, `distance` secundario, desempate lexicográfico).
 */
function orderScheduledRoute(
  route: RoutingOrder[],
  depot: GeoPoint,
  realDistance: DistanceFn,
  realDuration: DistanceFn | undefined,
): RoutingOrder[] {
  const sorted = [...route].sort((a, b) => {
    const ta = a.scheduledAtMs ?? Number.POSITIVE_INFINITY;
    const tb = b.scheduledAtMs ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  const buckets: RoutingOrder[][] = [];
  for (const order of sorted) {
    const currentTime = order.scheduledAtMs ?? Number.POSITIVE_INFINITY;
    const lastBucket = buckets[buckets.length - 1];
    if (!lastBucket || (lastBucket[0]!.scheduledAtMs ?? Number.POSITIVE_INFINITY) !== currentTime) {
      buckets.push([order]);
    } else {
      lastBucket.push(order);
    }
  }

  if (permutationProductExceedsLimit(buckets, EXACT_BUCKET_PERMUTATION_LIMIT)) {
    return greedyBucketOrder(buckets, depot, realDistance, realDuration);
  }
  return exactBucketOrder(buckets, depot, realDistance, realDuration);
}

function permutationProductExceedsLimit(buckets: readonly RoutingOrder[][], limit: number): boolean {
  let product = 1;
  for (const bucket of buckets) {
    for (let k = 2; k <= bucket.length; k++) {
      product *= k;
      if (product > limit) return true;
    }
  }
  return false;
}

function exactBucketOrder(
  buckets: readonly RoutingOrder[][],
  depot: GeoPoint,
  realDistance: DistanceFn,
  realDuration: DistanceFn | undefined,
): RoutingOrder[] {
  let bestRoute: RoutingOrder[] | undefined;
  let bestDuration = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestIds: string[] = [];

  const current: RoutingOrder[] = [];

  const search = (bucketIdx: number, usedMask: number) => {
    if (bucketIdx === buckets.length) {
      const candDuration = realDuration ? routeDistance(current, depot, realDuration) : 0;
      const candDistance = routeDistance(current, depot, realDistance);
      const candIds = current.map((o) => o.id);
      if (
        !bestRoute ||
        isBetterTour(candDuration, candDistance, candIds, bestDuration, bestDistance, bestIds, Boolean(realDuration))
      ) {
        bestRoute = [...current];
        bestDuration = candDuration;
        bestDistance = candDistance;
        bestIds = candIds;
      }
      return;
    }

    const bucket = buckets[bucketIdx]!;
    if (usedMask === (1 << bucket.length) - 1) {
      search(bucketIdx + 1, 0);
      return;
    }

    for (let idx = 0; idx < bucket.length; idx++) {
      if ((usedMask & (1 << idx)) !== 0) continue;
      current.push(bucket[idx]!);
      search(bucketIdx, usedMask | (1 << idx));
      current.pop();
    }
  };

  search(0, 0);
  return bestRoute!;
}

function isBetterTour(
  candDuration: number,
  candDistance: number,
  candIds: readonly string[],
  bestDuration: number,
  bestDistance: number,
  bestIds: readonly string[],
  hasDuration: boolean,
): boolean {
  if (hasDuration && candDuration !== bestDuration) {
    return candDuration < bestDuration;
  }
  if (candDistance !== bestDistance) {
    return candDistance < bestDistance;
  }
  for (let k = 0; k < candIds.length; k++) {
    const cmp = candIds[k]!.localeCompare(bestIds[k]!);
    if (cmp !== 0) return cmp < 0;
  }
  return false;
}

function greedyBucketOrder(
  buckets: readonly RoutingOrder[][],
  depot: GeoPoint,
  realDistance: DistanceFn,
  realDuration: DistanceFn | undefined,
): RoutingOrder[] {
  const ordered: RoutingOrder[] = [];
  let prev = depot;

  for (const bucket of buckets) {
    const remaining = [...bucket];
    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestDur = realDuration ? realDuration(prev, remaining[0]!.location) : 0;
      let bestDist = realDistance(prev, remaining[0]!.location);

      for (let idx = 1; idx < remaining.length; idx++) {
        const candidate = remaining[idx]!;
        const candDur = realDuration ? realDuration(prev, candidate.location) : 0;
        const candDist = realDistance(prev, candidate.location);
        const better = realDuration
          ? candDur < bestDur ||
            (candDur === bestDur &&
              (candDist < bestDist || (candDist === bestDist && candidate.id.localeCompare(remaining[bestIdx]!.id) < 0)))
          : candDist < bestDist || (candDist === bestDist && candidate.id.localeCompare(remaining[bestIdx]!.id) < 0);
        if (better) {
          bestIdx = idx;
          bestDur = candDur;
          bestDist = candDist;
        }
      }

      const [chosen] = remaining.splice(bestIdx, 1);
      ordered.push(chosen!);
      prev = chosen!.location;
    }
  }

  return ordered;
}

function routeDistance(route: RoutingOrder[], depot: GeoPoint, distance: DistanceFn): number {
  let total = distance(depot, route[0]!.location);
  for (let k = 1; k < route.length; k++) {
    total += distance(route[k - 1]!.location, route[k]!.location);
  }
  return total + distance(route[route.length - 1]!.location, depot);
}
