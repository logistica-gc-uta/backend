import { createHash } from 'node:crypto';
import { createRng } from '../routing/prng.js';

/** Tamaños de pedidos que exige el Issue #15 (volumen). */
export const VOLUME_SIZES = [100, 500, 2000] as const;
export type VolumeSize = (typeof VOLUME_SIZES)[number];

/** Semilla fija por defecto: mismos datos en cualquier máquina y en cualquier ejecución. */
export const DEFAULT_SEED = 20261104;
/** Día de entrega de todos los pedidos (10:00 de Guayaquil = 15:00Z); una fecha futura estable. */
export const DEFAULT_DATE = '2030-02-14';
/** Capacidad de una salida (paradas por ruta) fijada por el contrato de planificación. */
export const ROUTE_CAPACITY = 4;

/** Marcas que identifican TODO lo que crea el seeder, para poder limpiarlo sin tocar datos reales. */
export const PERF_TAG = {
  zoneCodePrefix: 'PERF-',
  emailDomain: '@perf.test',
  addressPrefix: 'PERF/',
} as const;

export interface PerfZone { code: string; name: string; depotLat: number; depotLng: number }
export interface PerfUser { email: string; name: string }
export interface PerfOrder { zoneCode: string; clientEmail: string; deliveryAddress: string; lat: number; lng: number }
export interface PerfDataset {
  size: number;
  seed: number;
  date: string;
  zones: PerfZone[];
  clients: PerfUser[];
  drivers: PerfUser[];
  orders: PerfOrder[];
}

// Cinco depósitos ilustrativos en Ambato (datos sintéticos, no ubicaciones reales de operación).
const ZONE_DEPOTS: readonly [string, string, number, number][] = [
  ['PERF-CEN', 'Perf Centro', -1.2425, -78.6188],
  ['PERF-FIC', 'Perf Ficoa', -1.2491, -78.632],
  ['PERF-HUA', 'Perf Huachi', -1.2712, -78.6294],
  ['PERF-IZA', 'Perf Izamba', -1.2146, -78.6041],
  ['PERF-ATO', 'Perf Atocha', -1.2278, -78.6405],
];
export const CLIENT_COUNT = 10;
export const DRIVER_COUNT = 20;

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/**
 * Genera el conjunto de datos de un volumen dado. Es una función pura: no toca la base de datos.
 * Los pedidos se reparten por bloques de cuatro, de modo que cada zona queda con un múltiplo de la
 * capacidad de una salida y el total teórico es `size / 4` salidas (500 salidas para 2000 pedidos).
 */
export function buildDataset(size: number, seed = DEFAULT_SEED, date = DEFAULT_DATE): PerfDataset {
  if (!Number.isInteger(size) || size < ROUTE_CAPACITY || size % ROUTE_CAPACITY !== 0) {
    throw new Error(`El tamaño debe ser un múltiplo de ${ROUTE_CAPACITY} (recibido: ${size})`);
  }
  if (size > 2000 * ZONE_DEPOTS.length) throw new Error('Demasiados pedidos para las zonas disponibles');
  const rng = createRng(seed);

  const zones: PerfZone[] = ZONE_DEPOTS.map(([code, name, depotLat, depotLng]) => ({ code, name, depotLat, depotLng }));
  const clients: PerfUser[] = Array.from({ length: CLIENT_COUNT }, (_, i) => ({
    email: `perf-client-${pad(i + 1, 2)}${PERF_TAG.emailDomain}`,
    name: `Cliente Perf ${pad(i + 1, 2)}`,
  }));
  const drivers: PerfUser[] = Array.from({ length: DRIVER_COUNT }, (_, i) => ({
    email: `perf-driver-${pad(i + 1, 2)}${PERF_TAG.emailDomain}`,
    name: `Chofer Perf ${pad(i + 1, 2)}`,
  }));

  const orders: PerfOrder[] = [];
  const blocks = size / ROUTE_CAPACITY;
  const perZone = new Map<string, number>();
  for (let block = 0; block < blocks; block++) {
    const zone = zones[Math.floor(rng() * zones.length)]!;
    for (let slot = 0; slot < ROUTE_CAPACITY; slot++) {
      const n = (perZone.get(zone.code) ?? 0) + 1;
      perZone.set(zone.code, n);
      orders.push({
        zoneCode: zone.code,
        clientEmail: clients[Math.floor(rng() * clients.length)]!.email,
        deliveryAddress: `${PERF_TAG.addressPrefix}${size}/${date}/${zone.code} #${pad(n, 4)}`,
        // ~ ±1,1 km alrededor del depósito, con 6 decimales como el contrato.
        lat: Number((zone.depotLat + (rng() - 0.5) * 0.02).toFixed(6)),
        lng: Number((zone.depotLng + (rng() - 0.5) * 0.02).toFixed(6)),
      });
    }
  }
  return { size, seed, date, zones, clients, drivers, orders };
}

/** Salidas teóricas si todos los pedidos de cada zona se asignan de cuatro en cuatro. */
export function theoreticalRoutes(dataset: PerfDataset): number {
  const perZone = new Map<string, number>();
  for (const order of dataset.orders) perZone.set(order.zoneCode, (perZone.get(order.zoneCode) ?? 0) + 1);
  return [...perZone.values()].reduce((sum, count) => sum + Math.ceil(count / ROUTE_CAPACITY), 0);
}

/** Huella del contenido: sirve para demostrar que dos ejecuciones generaron exactamente lo mismo. */
export function datasetChecksum(dataset: PerfDataset): string {
  return createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
}
