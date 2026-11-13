import { HttpException, HttpStatus } from '@nestjs/common';
import type { GeoPoint } from '../algorithms/geo.util.js';

/**
 * Métricas viales entre puntos (#47). La matriz es DIRECCIONAL: `distancesM[i][j]` es el recorrido de `i` a `j`
 * y puede diferir de `distancesM[j][i]` (sentidos de calle). Las duraciones son estimadas con el perfil del motor:
 * NO incluyen tráfico en vivo y no son una hora de llegada garantizada.
 */
export interface RoadMatrix {
  provider: 'OSRM';
  profile: string;
  distanceUnit: 'm';
  durationUnit: 's';
  /** Puntos en el orden en que aparecen las filas y columnas. */
  points: GeoPoint[];
  distancesM: number[][];
  durationsS: number[][];
  /** Distancia máxima (m) a la que algún punto tuvo que «pegarse» a la red vial. */
  maxSnapDistanceM: number;
  /** Distancia (m) a la que cada punto tuvo que «pegarse» a la red vial, en el orden de `points`. */
  snapDistancesM: number[];
}

export interface RoadGeometry {
  /** Longitud y latitud (GeoJSON), en el orden de la visita. */
  coordinates: [number, number][];
  distanceM: number;
  durationS: number;
}

export interface RoadEngineStatus {
  engine: 'HAVERSINE' | 'OSRM';
  configured: boolean;
  available: boolean;
  profile: string | null;
  latencyMs: number | null;
  checkedAt: string;
  message: string;
}

export const ROAD_ERROR_CODES = {
  /** No responde, agotó el tiempo o contestó con un error de servidor. */
  UNAVAILABLE: 'ROAD_ENGINE_UNAVAILABLE',
  /** Respondió pero la respuesta está incompleta o no es la esperada: nunca se convierte en ceros. */
  BAD_RESPONSE: 'ROAD_ENGINE_BAD_RESPONSE',
  /** Algún par de puntos no tiene recorrido vial. */
  ROUTE_NOT_FOUND: 'ROAD_ROUTE_NOT_FOUND',
  /** Un punto queda demasiado lejos de la red vial conocida. */
  POINT_OFF_NETWORK: 'ROAD_POINT_OFF_NETWORK',
  /** Hay más puntos de los que la matriz admite en una sola propuesta. */
  MATRIX_TOO_LARGE: 'ROAD_MATRIX_TOO_LARGE',
} as const;

export type RoadErrorCode = (typeof ROAD_ERROR_CODES)[keyof typeof ROAD_ERROR_CODES];

const STATUS: Record<RoadErrorCode, HttpStatus> = {
  ROAD_ENGINE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  ROAD_ENGINE_BAD_RESPONSE: HttpStatus.BAD_GATEWAY,
  ROAD_ROUTE_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  ROAD_POINT_OFF_NETWORK: HttpStatus.UNPROCESSABLE_ENTITY,
  ROAD_MATRIX_TOO_LARGE: HttpStatus.UNPROCESSABLE_ENTITY,
};

/** Error tipado con el sobre `{statusCode, error, code, message, details}` que verá el ADMIN. */
export class RoadMetricsError extends HttpException {
  constructor(
    readonly code: RoadErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(
      { statusCode: STATUS[code], error: STATUS[code] === 503 ? 'Service Unavailable' : STATUS[code] === 502 ? 'Bad Gateway' : 'Unprocessable Entity', code, message, details },
      STATUS[code],
    );
  }
}

/** Configuración sensible: vive solo en el backend; los consumidores no ven la URL ni las credenciales. */
export interface RoadEngineConfig {
  engine: 'HAVERSINE' | 'OSRM';
  baseUrl: string | null;
  profile: string;
  timeoutMs: number;
  maxPoints: number;
  tileSize: number;
  concurrency: number;
  maxSnapDistanceM: number;
}

export const DEFAULT_ROAD_CONFIG: RoadEngineConfig = {
  engine: 'HAVERSINE',
  baseUrl: null,
  profile: 'car',
  timeoutMs: 5000,
  maxPoints: 300,
  tileSize: 50,
  concurrency: 4,
  maxSnapDistanceM: 500,
};

const positive = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Lee la configuración del entorno. Sin `ROAD_ENGINE=OSRM` el comportamiento sigue siendo el de siempre (línea recta). */
export function loadRoadEngineConfig(env: NodeJS.ProcessEnv = process.env): RoadEngineConfig {
  const engine = (env.ROAD_ENGINE ?? '').trim().toUpperCase() === 'OSRM' ? 'OSRM' : 'HAVERSINE';
  return {
    engine,
    baseUrl: engine === 'OSRM' ? (env.OSRM_BASE_URL ?? '').trim().replace(/\/+$/, '') || null : null,
    profile: (env.OSRM_PROFILE ?? DEFAULT_ROAD_CONFIG.profile).trim() || DEFAULT_ROAD_CONFIG.profile,
    timeoutMs: positive(env.OSRM_TIMEOUT_MS, DEFAULT_ROAD_CONFIG.timeoutMs),
    maxPoints: Math.floor(positive(env.OSRM_MAX_POINTS, DEFAULT_ROAD_CONFIG.maxPoints)),
    tileSize: Math.min(50, Math.floor(positive(env.OSRM_TILE_SIZE, DEFAULT_ROAD_CONFIG.tileSize))),
    concurrency: Math.floor(positive(env.OSRM_CONCURRENCY, DEFAULT_ROAD_CONFIG.concurrency)),
    maxSnapDistanceM: positive(env.OSRM_MAX_SNAP_DISTANCE_M, DEFAULT_ROAD_CONFIG.maxSnapDistanceM),
  };
}
