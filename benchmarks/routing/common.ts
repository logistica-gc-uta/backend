import {
  DEFAULT_ROUTE_CAPACITY,
  type PlannedRoute,
  type RoutingOrder,
  planRoutes,
} from '../../src/modules/routes/algorithms/clarke-wright.js';
import { type GeoPoint, haversineKm } from '../../src/modules/routes/algorithms/geo.util.js';
import type { DatasetKind } from './datasets.js';
import type { Depots } from './metrics.js';
import { createRng } from './prng.js';

/** La misma función para la línea base, la heurística y las verificaciones. */
export const DISTANCE = haversineKm;
export const DEFAULT_SIZES = [4, 5, 20, 100, 500, 2000];
export const DEFAULT_SEEDS = [1, 2, 3];
export const DEFAULT_KINDS: DatasetKind[] = ['uniform', 'clustered'];
export const OPTIMALITY_SIZES = [4, 5, 6, 8, 10];
export const OPTIMALITY_INSTANCES = 50;

export const depotsFor = (orders: RoutingOrder[], depot: GeoPoint): Depots =>
  Object.fromEntries(orders.map((order) => [order.zoneId, depot]));

export const plan = (orders: RoutingOrder[], depots: Depots, capacity = DEFAULT_ROUTE_CAPACITY): PlannedRoute[] =>
  planRoutes(orders, { depots, capacity, distance: DISTANCE });

export const signature = (routes: PlannedRoute[]) => JSON.stringify(routes);

export function shuffled<T>(items: T[], seed: number): T[] {
  const rng = createRng(seed ^ 0x9e3779b9);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
