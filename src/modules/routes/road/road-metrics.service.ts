import type { GeoPoint } from '../algorithms/geo.util.js';
import { OsrmClient } from './osrm.client.js';
import {
  loadRoadEngineConfig,
  RoadMetricsError,
  type RoadEngineConfig,
  type RoadEngineStatus,
  type RoadGeometry,
  type RoadMatrix,
} from './road-metrics.types.js';

/** Punto de la ciudad usado solo para comprobar que el motor responde (no es un dato de negocio). */
const HEALTH_PROBE: GeoPoint = { lat: -1.24908, lng: -78.61675 };

/**
 * Proveedor de métricas viales del backend REGALÍA (#47). Las reglas comerciales y el planificador siguen
 * siendo del backend: el motor solo entrega distancias, duraciones estimadas y trazado.
 *
 * - `ROAD_ENGINE` sin definir (o distinto de `OSRM`): comportamiento histórico, línea recta (`active = false`).
 * - `ROAD_ENGINE=OSRM`: toda propuesta usa la red vial y, si el motor falla, la operación FALLA con un error
 *   tipado. No hay respaldo silencioso a línea recta ni a otro motor.
 *
 * Se construye con una fábrica (no por inyección de parámetros) para poder probarlo con un `fetch` simulado.
 */
export class RoadMetricsService {
  private readonly client: OsrmClient;

  constructor(
    readonly config: RoadEngineConfig = loadRoadEngineConfig(),
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new OsrmClient(config, fetchImpl);
  }

  /** `true` si las propuestas deben calcularse con la red vial. */
  get active(): boolean {
    return this.config.engine === 'OSRM';
  }

  /** Matriz vial entre los puntos, o `null` si el motor vial no está activado. */
  async matrixFor(points: GeoPoint[]): Promise<RoadMatrix | null> {
    return this.active ? this.client.matrix(points) : null;
  }

  /** Trazado de una visita; solo existe con el motor vial activado. */
  async geometry(points: GeoPoint[]): Promise<RoadGeometry> {
    if (!this.active) throw new Error('El trazado vial requiere ROAD_ENGINE=OSRM');
    return this.client.route(points);
  }

  /** Estado para que el ADMIN sepa si el motor responde. No expone la URL ni credenciales. */
  async status(): Promise<RoadEngineStatus> {
    const checkedAt = new Date().toISOString();
    if (!this.active) {
      return { engine: 'HAVERSINE', configured: false, available: true, profile: null, latencyMs: null, checkedAt, message: 'Motor vial desactivado: las distancias son en línea recta (Haversine)' };
    }
    const started = Date.now();
    try {
      const { distanceM } = await this.client.nearest(HEALTH_PROBE);
      return {
        engine: 'OSRM',
        configured: true,
        available: true,
        profile: this.config.profile,
        latencyMs: Date.now() - started,
        checkedAt,
        message: `Motor vial disponible (el punto de prueba queda a ${Math.round(distanceM)} m de la red)`,
      };
    } catch (error) {
      return {
        engine: 'OSRM',
        configured: Boolean(this.config.baseUrl),
        available: false,
        profile: this.config.profile,
        latencyMs: null,
        checkedAt,
        message: error instanceof RoadMetricsError ? error.message : 'El motor vial no está disponible',
      };
    }
  }
}
