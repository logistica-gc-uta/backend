import type { DistanceFn } from './clarke-wright.js';
import type { GeoPoint } from './geo.util.js';

/** Matriz de distancias en km entre `points` (fila = origen, columna = destino). Puede ser asimétrica. */
export interface DistanceMatrix {
  points: GeoPoint[];
  distanceKm: number[][];
}

/** Clave estable de un punto: 6 decimales (~0,1 m). La misma función arma la lista y resuelve la búsqueda. */
export const pointKey = (point: GeoPoint): string => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;

/** Puntos únicos (por coordenadas) conservando el orden de aparición. */
export function uniquePoints(points: readonly GeoPoint[]): GeoPoint[] {
  const seen = new Set<string>();
  const result: GeoPoint[] = [];
  for (const point of points) {
    const key = pointKey(point);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(point);
    }
  }
  return result;
}

/** Índice de cada punto de la matriz por su clave. */
export function indexByKey(points: readonly GeoPoint[]): Map<string, number> {
  return new Map(points.map((point, index) => [pointKey(point), index]));
}

/**
 * Función de distancia sobre una matriz precalculada. Un punto que no está en la matriz es un error de
 * programación y falla en voz alta: jamás se rellena con un cero ni con una línea recta.
 */
export function matrixDistance(matrix: DistanceMatrix): DistanceFn {
  const index = indexByKey(matrix.points);
  return (a, b) => {
    const row = index.get(pointKey(a));
    const column = index.get(pointKey(b));
    if (row === undefined || column === undefined) {
      throw new Error(`El punto ${row === undefined ? pointKey(a) : pointKey(b)} no está en la matriz de distancias`);
    }
    return matrix.distanceKm[row]![column]!;
  };
}
