import type { GeoPoint } from '../algorithms/geo.util.js';
import {
  ROAD_ERROR_CODES,
  RoadMetricsError,
  type RoadEngineConfig,
  type RoadGeometry,
  type RoadMatrix,
} from './road-metrics.types.js';

type Fetch = typeof fetch;

/** `lng,lat` con 6 decimales (~0,1 m): es el orden que usa OSRM. */
const coordinate = (point: GeoPoint) => `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Cliente HTTP del motor vial OSRM (servicios `table`, `route` y `nearest`).
 * - No asume simetría: cada celda es el recorrido de la fila a la columna.
 * - Una celda sin recorrido (`null`) o una respuesta incompleta NUNCA se convierte en cero: es un error tipado.
 * - Las matrices grandes se piden por bloques para respetar el límite de coordenadas de OSRM (`--max-table-size`).
 */
export class OsrmClient {
  constructor(
    private readonly config: RoadEngineConfig,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private get base(): string {
    if (!this.config.baseUrl) {
      throw new RoadMetricsError(ROAD_ERROR_CODES.UNAVAILABLE, 'El motor vial OSRM está activado pero no tiene URL configurada (OSRM_BASE_URL)');
    }
    return this.config.baseUrl;
  }

  private async getJson(path: string): Promise<Record<string, any>> {
    const url = `${this.base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      let body: Record<string, any> | undefined;
      try {
        body = (await response.json()) as Record<string, any>;
      } catch {
        body = undefined;
      }
      if (response.status >= 500) {
        throw new RoadMetricsError(ROAD_ERROR_CODES.UNAVAILABLE, `El motor vial respondió con un error de servidor (${response.status})`);
      }
      if (!response.ok && !(body && typeof body.code === 'string')) {
        throw new RoadMetricsError(ROAD_ERROR_CODES.BAD_RESPONSE, `El motor vial respondió ${response.status} sin un cuerpo reconocible`);
      }
      if (!body || typeof body !== 'object') {
        throw new RoadMetricsError(ROAD_ERROR_CODES.BAD_RESPONSE, 'El motor vial respondió algo que no es JSON');
      }
      return body;
    } catch (error) {
      if (error instanceof RoadMetricsError) throw error;
      const aborted = (error as { name?: string })?.name === 'AbortError';
      throw new RoadMetricsError(
        ROAD_ERROR_CODES.UNAVAILABLE,
        aborted ? `El motor vial no respondió en ${this.config.timeoutMs} ms` : 'No se pudo conectar con el motor vial',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Comprobación rápida de disponibilidad: pide el punto de la red más cercano a un punto de prueba. */
  async nearest(point: GeoPoint): Promise<{ distanceM: number }> {
    const body = await this.getJson(`/nearest/v1/${this.config.profile}/${coordinate(point)}?number=1`);
    const waypoint = body.waypoints?.[0];
    if (body.code !== 'Ok' || !waypoint || !isNumber(waypoint.distance)) {
      throw new RoadMetricsError(ROAD_ERROR_CODES.BAD_RESPONSE, 'El motor vial no devolvió un punto de red válido');
    }
    return { distanceM: waypoint.distance };
  }

  /**
   * Matriz de distancias y duraciones entre todos los pares de `points`, por bloques de `tileSize × tileSize`.
   * Valida: forma de la matriz, números finitos, pares sin recorrido y puntos lejos de la red.
   */
  async matrix(points: GeoPoint[]): Promise<RoadMatrix> {
    const n = points.length;
    if (n > this.config.maxPoints) {
      throw new RoadMetricsError(
        ROAD_ERROR_CODES.MATRIX_TOO_LARGE,
        `La propuesta necesita ${n} puntos y el límite del motor vial es ${this.config.maxPoints}: acota la fecha o la zona`,
        { points: n, maxPoints: this.config.maxPoints },
      );
    }
    const distancesM = Array.from({ length: n }, () => new Array<number>(n).fill(Number.NaN));
    const durationsS = Array.from({ length: n }, () => new Array<number>(n).fill(Number.NaN));
    const snap = new Array<number>(n).fill(0);
    const unreachable: [number, number][] = [];

    const size = Math.max(1, this.config.tileSize);
    const blocks: [number, number][] = [];
    for (let r = 0; r < n; r += size) for (let c = 0; c < n; c += size) blocks.push([r, c]);

    const runBlock = async ([r, c]: [number, number]) => {
      const rows = Array.from({ length: Math.min(size, n - r) }, (_, k) => r + k);
      const cols = Array.from({ length: Math.min(size, n - c) }, (_, k) => c + k);
      // Coordenadas únicas del bloque: filas y columnas pueden coincidir (bloque diagonal).
      const unique = [...new Set([...rows, ...cols])];
      const position = new Map(unique.map((index, k) => [index, k]));
      const path =
        `/table/v1/${this.config.profile}/${unique.map((index) => coordinate(points[index]!)).join(';')}` +
        `?annotations=distance,duration&sources=${rows.map((i) => position.get(i)).join(';')}` +
        `&destinations=${cols.map((j) => position.get(j)).join(';')}`;
      const body = await this.getJson(path);
      if (body.code !== 'Ok') {
        const noRoute = body.code === 'NoRoute' || body.code === 'NoSegment';
        throw new RoadMetricsError(
          noRoute ? ROAD_ERROR_CODES.ROUTE_NOT_FOUND : ROAD_ERROR_CODES.BAD_RESPONSE,
          noRoute ? 'El motor vial no encontró un recorrido para alguno de los puntos' : `El motor vial respondió con el código ${String(body.code)}`,
        );
      }
      const distances = body.distances as unknown;
      const durations = body.durations as unknown;
      const shapeOk = (m: unknown): m is (number | null)[][] =>
        Array.isArray(m) && m.length === rows.length && m.every((row) => Array.isArray(row) && row.length === cols.length);
      if (!shapeOk(distances) || !shapeOk(durations)) {
        throw new RoadMetricsError(ROAD_ERROR_CODES.BAD_RESPONSE, 'La matriz del motor vial está incompleta (faltan distancias o duraciones)');
      }
      rows.forEach((i, a) =>
        cols.forEach((j, b) => {
          const d = distances[a]![b];
          const t = durations[a]![b];
          if (i === j) {
            distancesM[i]![j] = 0;
            durationsS[i]![j] = 0;
          } else if (d === null || t === null) {
            unreachable.push([i, j]);
          } else if (isNumber(d) && isNumber(t) && d >= 0 && t >= 0) {
            distancesM[i]![j] = d;
            durationsS[i]![j] = t;
          } else {
            throw new RoadMetricsError(ROAD_ERROR_CODES.BAD_RESPONSE, 'El motor vial devolvió un valor que no es un número válido');
          }
        }),
      );
      // Distancia de «ajuste» a la red de cada punto del bloque (útil para detectar puntos fuera de calle).
      for (const list of [body.sources, body.destinations]) {
        if (!Array.isArray(list)) continue;
        const origin = list === body.sources ? rows : cols;
        list.forEach((waypoint: any, k: number) => {
          if (isNumber(waypoint?.distance) && origin[k] !== undefined) snap[origin[k]!] = Math.max(snap[origin[k]!]!, waypoint.distance);
        });
      }
    };

    // Concurrencia limitada: nunca más de `concurrency` bloques a la vez contra el motor.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.config.concurrency, blocks.length) }, async () => {
      while (cursor < blocks.length) {
        const block = blocks[cursor++]!;
        await runBlock(block);
      }
    });
    await Promise.all(workers);

    const offNetwork = snap.map((distance, index) => ({ index, distance })).filter((entry) => entry.distance > this.config.maxSnapDistanceM);
    if (offNetwork.length) {
      throw new RoadMetricsError(
        ROAD_ERROR_CODES.POINT_OFF_NETWORK,
        `Hay puntos a más de ${this.config.maxSnapDistanceM} m de la red vial conocida`,
        { pointIndexes: offNetwork.map((entry) => entry.index), maxSnapDistanceM: this.config.maxSnapDistanceM },
      );
    }
    if (unreachable.length) {
      throw new RoadMetricsError(ROAD_ERROR_CODES.ROUTE_NOT_FOUND, 'No hay recorrido vial entre algunos pares de puntos', {
        pairs: unreachable.slice(0, 20),
        pointIndexes: [...new Set(unreachable.flat())].sort((a, b) => a - b),
      });
    }
    return {
      provider: 'OSRM',
      profile: this.config.profile,
      distanceUnit: 'm',
      durationUnit: 's',
      points,
      distancesM,
      durationsS,
      maxSnapDistanceM: Math.max(0, ...snap),
      snapDistancesM: snap,
    };
  }

  /** Trazado vial de una visita (para dibujarlo en el mapa). `points` en el orden de la visita. */
  async route(points: GeoPoint[]): Promise<RoadGeometry> {
    if (points.length < 2) throw new RoadMetricsError(ROAD_ERROR_CODES.BAD_RESPONSE, 'Un trazado necesita al menos dos puntos');
    const path = `/route/v1/${this.config.profile}/${points.map(coordinate).join(';')}?overview=full&geometries=geojson&steps=false`;
    const body = await this.getJson(path);
    if (body.code === 'NoRoute') {
      throw new RoadMetricsError(ROAD_ERROR_CODES.ROUTE_NOT_FOUND, 'El motor vial no encontró un recorrido para esta visita');
    }
    const route = body.routes?.[0];
    const coordinates = route?.geometry?.coordinates;
    if (
      body.code !== 'Ok' ||
      !isNumber(route?.distance) ||
      !isNumber(route?.duration) ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      !coordinates.every((c: unknown) => Array.isArray(c) && c.length >= 2 && isNumber(c[0]) && isNumber(c[1]))
    ) {
      throw new RoadMetricsError(ROAD_ERROR_CODES.BAD_RESPONSE, 'El trazado del motor vial está incompleto');
    }
    return {
      coordinates: coordinates.map((c: number[]) => [c[0]!, c[1]!] as [number, number]),
      distanceM: route.distance,
      durationS: route.duration,
    };
  }
}
