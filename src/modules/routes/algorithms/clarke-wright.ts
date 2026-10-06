import { type GeoPoint, haversineKm } from './geo.util.js';

export interface RoutingOrder {
  id: string;
  zoneId: string;
  /** Fecha de entrega (YYYY-MM-DD). Pedidos de fechas distintas nunca comparten ruta. */
  deliveryDate: string;
  location: GeoPoint;
}

export type DistanceFn = (a: GeoPoint, b: GeoPoint) => number;

export interface ClarkeWrightOptions {
  /** Punto de salida (depósito) de cada zona. */
  depots: Record<string, GeoPoint>;
  /** Máximo de pedidos por ruta. Por defecto 4 (regla de negocio). */
  capacity?: number;
  /** Función de distancia. Por defecto Haversine en km. */
  distance?: DistanceFn;
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

interface Saving {
  i: number;
  j: number;
  value: number;
}

/**
 * Arma rutas con la heurística de ahorros de Clarke & Wright (1964) para el
 * VRP con capacidad: agrupa por zona y fecha, parte con una ruta por pedido y
 * fusiona rutas por mayor ahorro de distancia sin superar la capacidad.
 *
 * Es una función pura y determinista: no accede a la base de datos.
 */
export function planRoutes(orders: RoutingOrder[], options: ClarkeWrightOptions): PlannedRoute[] {
  const capacity = options.capacity ?? DEFAULT_ROUTE_CAPACITY;
  const distance = options.distance ?? haversineKm;

  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error('La capacidad por ruta debe ser un entero mayor o igual a 1');
  }

  const seen = new Set<string>();
  for (const order of orders) {
    if (seen.has(order.id)) {
      throw new Error(`Pedido duplicado en la entrada: '${order.id}'`);
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

  const planned: PlannedRoute[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const { zoneId, deliveryDate } = group[0]!;
    const depot = options.depots[zoneId];
    if (!depot) {
      throw new Error(`No hay depósito definido para la zona '${zoneId}'`);
    }

    for (const route of planGroup(group, depot, capacity, distance)) {
      planned.push({
        zoneId,
        deliveryDate,
        orderIds: route.map((order) => order.id),
        totalDistance: routeDistance(route, depot, distance),
      });
    }
  }
  return planned;
}

function planGroup(
  group: RoutingOrder[],
  depot: GeoPoint,
  capacity: number,
  distance: DistanceFn,
): RoutingOrder[][] {
  // Orden por id: el resultado no depende del orden de llegada de los pedidos.
  const orders = [...group].sort((a, b) => a.id.localeCompare(b.id));

  const routes = new Map<number, number[]>();
  const routeOf: number[] = [];
  orders.forEach((_, index) => {
    routes.set(index, [index]);
    routeOf.push(index);
  });

  const toDepot = orders.map((order) => distance(depot, order.location));
  const savings: Saving[] = [];
  for (let i = 0; i < orders.length; i++) {
    for (let j = i + 1; j < orders.length; j++) {
      const value = toDepot[i]! + toDepot[j]! - distance(orders[i]!.location, orders[j]!.location);
      if (value > 0) {
        savings.push({ i, j, value });
      }
    }
  }
  savings.sort((a, b) => b.value - a.value || a.i - b.i || a.j - b.j);

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
    // Se recorre primero la parada más cercana al depósito.
    const first = distance(depot, route[0]!.location);
    const last = distance(depot, route[route.length - 1]!.location);
    return last < first ? route.reverse() : route;
  });
}

function routeDistance(route: RoutingOrder[], depot: GeoPoint, distance: DistanceFn): number {
  let total = distance(depot, route[0]!.location);
  for (let k = 1; k < route.length; k++) {
    total += distance(route[k - 1]!.location, route[k]!.location);
  }
  return total + distance(route[route.length - 1]!.location, depot);
}
