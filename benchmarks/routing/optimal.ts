import type { DistanceFn, RoutingOrder } from '../../src/modules/routes/algorithms/clarke-wright.js';
import type { GeoPoint } from '../../src/modules/routes/algorithms/geo.util.js';

/**
 * Tope de la solución exacta: 3^n subconjuntos. Con 10 pedidos son ~59 000
 * combinaciones; por encima el costo crece demasiado y no tiene sentido.
 */
export const MAX_EXACT_ORDERS = 10;

const popcount = (mask: number) => {
  let count = 0;
  for (let m = mask; m; m &= m - 1) count++;
  return count;
};

/**
 * Distancia total óptima del CVRP para UN solo depósito (misma zona y fecha),
 * obtenida por programación dinámica sobre subconjuntos: primero el mejor
 * recorrido de cada subconjunto de hasta `capacity` pedidos (TSP exacto) y luego
 * la mejor partición en rutas. Sirve únicamente como referencia para instancias
 * pequeñas; NO es un método de producción ni se extrapola a tamaños grandes.
 */
export function optimalPlanKm(orders: RoutingOrder[], depot: GeoPoint, capacity: number, distance: DistanceFn): number {
  const n = orders.length;
  if (n > MAX_EXACT_ORDERS) throw new Error(`La solución exacta admite como máximo ${MAX_EXACT_ORDERS} pedidos`);
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('La capacidad debe ser un entero mayor o igual a 1');
  if (n === 0) return 0;

  const toDepot = orders.map((order) => distance(depot, order.location));
  const between = orders.map((a) => orders.map((b) => distance(a.location, b.location)));
  const full = (1 << n) - 1;

  // tsp[mask][last]: mínimo costo de salir del depósito, visitar mask y terminar en last.
  const tsp: number[][] = Array.from({ length: full + 1 }, () => Array.from({ length: n }, () => Infinity));
  for (let i = 0; i < n; i++) tsp[1 << i]![i] = toDepot[i]!;
  for (let mask = 1; mask <= full; mask++) {
    if (popcount(mask) > capacity) continue;
    for (let last = 0; last < n; last++) {
      const here = tsp[mask]![last]!;
      if (!(mask & (1 << last)) || here === Infinity) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const target = mask | (1 << next);
        if (popcount(target) > capacity) continue;
        const cost = here + between[last]![next]!;
        if (cost < tsp[target]![next]!) tsp[target]![next] = cost;
      }
    }
  }

  const routeCost = Array.from({ length: full + 1 }, () => Infinity);
  for (let mask = 1; mask <= full; mask++) {
    if (popcount(mask) > capacity) continue;
    for (let last = 0; last < n; last++) {
      const cost = tsp[mask]![last]! + toDepot[last]!;
      if (cost < routeCost[mask]!) routeCost[mask] = cost;
    }
  }

  const best = Array.from({ length: full + 1 }, () => Infinity);
  best[0] = 0;
  for (let mask = 1; mask <= full; mask++) {
    const lowest = mask & -mask;
    for (let sub = mask; sub; sub = (sub - 1) & mask) {
      if (!(sub & lowest) || routeCost[sub] === Infinity) continue;
      const cost = routeCost[sub]! + best[mask ^ sub]!;
      if (cost < best[mask]!) best[mask] = cost;
    }
  }
  return best[full]!;
}
