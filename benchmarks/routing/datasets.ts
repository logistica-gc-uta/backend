import type { RoutingOrder } from '../../src/modules/routes/algorithms/clarke-wright.js';
import type { GeoPoint } from '../../src/modules/routes/algorithms/geo.util.js';
import { createRng, gaussian } from './prng.js';

/** Depósito de referencia (centro de Ambato). Es un dato DEMO/TEST, no una ubicación real del negocio. */
export const DEPOT: GeoPoint = { lat: -1.2491, lng: -78.6167 };
/** Semilado de la caja de pedidos en grados (~5,5 km): escala de una zona urbana. */
export const BOX_DEGREES = 0.05;
/** Dispersión de cada clúster en grados (~440 m). */
export const CLUSTER_SIGMA_DEGREES = 0.004;
/** Un clúster por cada ~25 pedidos. */
export const ORDERS_PER_CLUSTER = 25;

export const ZONE_ID = 'Z1';
export const DELIVERY_DATE = '2030-02-14';

export type DatasetKind = 'uniform' | 'clustered';

export interface Dataset {
  id: string;
  kind: DatasetKind;
  seed: number;
  depot: GeoPoint;
  orders: RoutingOrder[];
}

// Las coordenadas se guardan con 6 decimales (~0,11 m), igual que la base de datos.
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export function orderId(index: number): string {
  return `o${String(index + 1).padStart(5, '0')}`;
}

export function generateDataset(kind: DatasetKind, orders: number, seed: number): Dataset {
  if (!Number.isInteger(orders) || orders < 0) {
    throw new Error('El número de pedidos debe ser un entero no negativo');
  }
  const rng = createRng(seed);
  const centers: GeoPoint[] = [];
  if (kind === 'clustered') {
    const count = Math.max(1, Math.round(orders / ORDERS_PER_CLUSTER));
    for (let c = 0; c < count; c++) {
      centers.push({
        lat: DEPOT.lat + (rng() * 2 - 1) * BOX_DEGREES,
        lng: DEPOT.lng + (rng() * 2 - 1) * BOX_DEGREES,
      });
    }
  }

  const list: RoutingOrder[] = [];
  for (let i = 0; i < orders; i++) {
    let location: GeoPoint;
    if (kind === 'uniform') {
      location = {
        lat: DEPOT.lat + (rng() * 2 - 1) * BOX_DEGREES,
        lng: DEPOT.lng + (rng() * 2 - 1) * BOX_DEGREES,
      };
    } else {
      const center = centers[Math.floor(rng() * centers.length)]!;
      location = {
        lat: center.lat + gaussian(rng) * CLUSTER_SIGMA_DEGREES,
        lng: center.lng + gaussian(rng) * CLUSTER_SIGMA_DEGREES,
      };
    }
    list.push({
      id: orderId(i),
      zoneId: ZONE_ID,
      deliveryDate: DELIVERY_DATE,
      location: { lat: round6(location.lat), lng: round6(location.lng) },
    });
  }
  return { id: `${kind}-n${orders}-s${seed}`, kind, seed, depot: DEPOT, orders: list };
}
