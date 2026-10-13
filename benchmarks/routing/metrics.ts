import {
  DEFAULT_ROUTE_CAPACITY,
  type DistanceFn,
  type PlannedRoute,
  type RoutingOrder,
} from '../../src/modules/routes/algorithms/clarke-wright.js';
import type { GeoPoint } from '../../src/modules/routes/algorithms/geo.util.js';

export type Depots = Record<string, GeoPoint>;

/** Redondeo a 6 decimales: las métricas deterministas se comparan y firman con esta precisión. */
export const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Línea base: un viaje independiente depósito → pedido → depósito por cada
 * pedido. Usa la MISMA función de distancia que la heurística.
 */
export function independentTripsKm(orders: RoutingOrder[], depots: Depots, distance: DistanceFn): number {
  let total = 0;
  for (const order of orders) {
    const depot = depots[order.zoneId];
    if (!depot) throw new Error(`No hay depósito definido para la zona '${order.zoneId}'`);
    total += 2 * distance(depot, order.location);
  }
  return total;
}

/** Ahorro porcentual respecto a la línea base. Nunca divide entre 0: sin base no hay ahorro. */
export function savingsPercent(baselineKm: number, plannedKm: number): number {
  if (!(baselineKm > 0)) return 0;
  return ((baselineKm - plannedKm) / baselineKm) * 100;
}

/** Fracción de la capacidad usada: pedidos / (rutas × capacidad). Sin rutas, 0. */
export function utilization(orders: number, routes: number, capacity: number): number {
  if (routes === 0 || capacity <= 0) return 0;
  return orders / (routes * capacity);
}

export interface DeterministicMetrics {
  orders: number;
  capacity: number;
  routes: number;
  minimumRoutes: number;
  baselineKm: number;
  plannedKm: number;
  savingsKm: number;
  savingsPercent: number;
  utilization: number;
  averageStopsPerRoute: number;
}

export function deterministicMetrics(
  orders: RoutingOrder[],
  routes: PlannedRoute[],
  depots: Depots,
  distance: DistanceFn,
  capacity = DEFAULT_ROUTE_CAPACITY,
): DeterministicMetrics {
  const baselineKm = independentTripsKm(orders, depots, distance);
  const plannedKm = routes.reduce((sum, route) => sum + route.totalDistance, 0);
  return {
    orders: orders.length,
    capacity,
    routes: routes.length,
    minimumRoutes: Math.ceil(orders.length / capacity),
    baselineKm: round6(baselineKm),
    plannedKm: round6(plannedKm),
    savingsKm: round6(baselineKm - plannedKm),
    savingsPercent: round6(savingsPercent(baselineKm, plannedKm)),
    utilization: round6(utilization(orders.length, routes.length, capacity)),
    averageStopsPerRoute: routes.length ? round6(orders.length / routes.length) : 0,
  };
}
