import { DEFAULT_ROUTE_CAPACITY, type DistanceFn, type PlannedRoute, type RoutingOrder } from '../../src/modules/routes/algorithms/clarke-wright.js';
import type { Depots } from './metrics.js';

export interface InvariantContext {
  orders: RoutingOrder[];
  routes: PlannedRoute[];
  depots: Depots;
  distance: DistanceFn;
  capacity?: number;
}

/**
 * Comprueba de forma independiente que la propuesta es válida. Devuelve la
 * lista de violaciones (vacía si todo se cumple):
 * - cada pedido aparece exactamente una vez, sin duplicados ni inventados;
 * - ninguna ruta supera la capacidad ni está vacía;
 * - ninguna ruta mezcla zona o fecha;
 * - la distancia informada coincide con el recálculo desde las coordenadas.
 */
export function verifyProposal({ orders, routes, depots, distance, capacity = DEFAULT_ROUTE_CAPACITY }: InvariantContext): string[] {
  const violations: string[] = [];
  const byId = new Map(orders.map((order) => [order.id, order]));
  const seen = new Set<string>();

  for (const [index, route] of routes.entries()) {
    const label = `ruta ${index + 1}`;
    if (route.orderIds.length === 0) violations.push(`${label} vacía`);
    if (route.orderIds.length > capacity) {
      violations.push(`${label} supera la capacidad (${route.orderIds.length} > ${capacity})`);
    }
    const stops: RoutingOrder[] = [];
    for (const id of route.orderIds) {
      const order = byId.get(id);
      if (!order) {
        violations.push(`${label} contiene un pedido inexistente '${id}'`);
        continue;
      }
      if (seen.has(id)) violations.push(`pedido duplicado '${id}'`);
      seen.add(id);
      if (order.zoneId !== route.zoneId) violations.push(`${label} mezcla zonas`);
      if (order.deliveryDate !== route.deliveryDate) violations.push(`${label} mezcla fechas`);
      stops.push(order);
    }
    const depot = depots[route.zoneId];
    if (depot && stops.length) {
      let km = distance(depot, stops[0]!.location);
      for (let k = 1; k < stops.length; k++) km += distance(stops[k - 1]!.location, stops[k]!.location);
      km += distance(stops[stops.length - 1]!.location, depot);
      if (Math.abs(km - route.totalDistance) > 1e-9 * Math.max(1, km)) {
        violations.push(`${label} informa ${route.totalDistance} km pero recalculada da ${km} km`);
      }
    }
  }
  for (const id of byId.keys()) {
    if (!seen.has(id)) violations.push(`pedido sin ruta '${id}'`);
  }
  return violations;
}
