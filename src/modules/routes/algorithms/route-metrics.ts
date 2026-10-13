import type { DistanceFn } from './clarke-wright.js';
import { type GeoPoint, haversineKm } from './geo.util.js';

/** Kilómetros con 3 decimales (metro), igual que `totalDistanceKm`. */
export const roundKm = (km: number) => Math.round(km * 1000) / 1000;

/** Porcentajes con 2 decimales. */
export const roundPercent = (value: number) => Math.round(value * 100) / 100;

/**
 * Línea base «sin optimizar»: un viaje independiente depósito → pedido →
 * depósito por cada pedido. Usa la misma distancia que la heurística, por lo que
 * la comparación es entre las mismas distancias en línea recta.
 */
export function independentTripsKm(stops: GeoPoint[], depot: GeoPoint, distance: DistanceFn = haversineKm): number {
  return stops.reduce((sum, stop) => sum + 2 * distance(depot, stop), 0);
}

export interface SavingsFigures {
  baselineKm: number;
  plannedKm: number;
  savingsKm: number;
  savingsPercent: number;
}

/**
 * Cifras de ahorro coherentes entre sí: parte de los kilómetros ya redondeados
 * (los que verá el usuario) y deriva de ellos el ahorro, de modo que
 * `baselineKm − plannedKm = savingsKm` se cumple exactamente en pantalla.
 * Si la línea base es 0 el ahorro es 0: nunca se divide entre 0.
 */
export function savingsFigures(baselineKm: number, plannedKm: number): SavingsFigures {
  const baseline = roundKm(baselineKm);
  const planned = roundKm(plannedKm);
  return {
    baselineKm: baseline,
    plannedKm: planned,
    savingsKm: roundKm(baseline - planned),
    savingsPercent: baseline > 0 ? roundPercent(((baseline - planned) / baseline) * 100) : 0,
  };
}
