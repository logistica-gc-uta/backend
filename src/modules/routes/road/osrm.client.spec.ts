import { createFakeOsrmFetch, fakeRoadMeters } from '../../../../test/fake-osrm.js';
import { haversineKm } from '../algorithms/geo.util.js';
import { OsrmClient } from './osrm.client.js';
import { DEFAULT_ROAD_CONFIG, loadRoadEngineConfig, RoadMetricsError, type RoadEngineConfig } from './road-metrics.types.js';

const config = (extra: Partial<RoadEngineConfig> = {}): RoadEngineConfig => ({ ...DEFAULT_ROAD_CONFIG, engine: 'OSRM', baseUrl: 'http://osrm.test', ...extra });
const P = (lat: number, lng: number) => ({ lat, lng });
// Dos orillas del río simulado en lng = -78.62 y un punto en cada una.
const WEST = P(-1.235, -78.628);
const EAST = P(-1.235, -78.612);
const NORTH = P(-1.225, -78.628);

const rejection = async (promise: Promise<unknown>): Promise<RoadMetricsError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RoadMetricsError);
    return error as RoadMetricsError;
  }
  throw new Error('Se esperaba un rechazo');
};

describe('OsrmClient: matriz vial (#47)', () => {
  it('devuelve distancias y duraciones en metros y segundos, con la procedencia', async () => {
    const client = new OsrmClient(config(), createFakeOsrmFetch());
    const matrix = await client.matrix([WEST, EAST, NORTH]);
    expect(matrix).toMatchObject({ provider: 'OSRM', profile: 'car', distanceUnit: 'm', durationUnit: 's' });
    expect(matrix.distancesM[0]![0]).toBe(0);
    expect(matrix.distancesM).toHaveLength(3);
    expect(matrix.durationsS[0]![1]).toBeGreaterThan(0);
  });

  it('cruzar el río por el puente da un recorrido mucho mayor que la línea recta', async () => {
    const client = new OsrmClient(config(), createFakeOsrmFetch({ riverLng: -78.62, bridgeLat: -1.215 }));
    const matrix = await client.matrix([WEST, EAST]);
    const straightM = haversineKm(WEST, EAST) * 1000;
    expect(matrix.distancesM[0]![1]!).toBeGreaterThan(straightM * 1.5);
    // Mismo lado del río: solo el factor normal de las calles, claramente menor que el rodeo del puente.
    const same = await client.matrix([WEST, NORTH]);
    const sameRatio = same.distancesM[0]![1]! / (haversineKm(WEST, NORTH) * 1000);
    expect(sameRatio).toBeLessThan(2);
    expect(matrix.distancesM[0]![1]! / straightM).toBeGreaterThan(sameRatio);
  });

  it('no asume simetría: ir y volver pueden medir distinto (sentidos de calle)', async () => {
    const matrix = await new OsrmClient(config(), createFakeOsrmFetch()).matrix([WEST, NORTH]);
    expect(matrix.distancesM[0]![1]).not.toBe(matrix.distancesM[1]![0]);
    expect(matrix.distancesM[0]![1]).toBe(fakeRoadMeters([WEST.lng, WEST.lat], [NORTH.lng, NORTH.lat]));
  });

  it('pide las matrices grandes por bloques y reconstruye la matriz completa', async () => {
    const calls: string[] = [];
    const points = Array.from({ length: 7 }, (_, i) => P(-1.25 + i * 0.002, -78.63 + i * 0.001));
    const matrix = await new OsrmClient(config({ tileSize: 3, concurrency: 2 }), createFakeOsrmFetch({}, calls)).matrix(points);
    expect(calls.length).toBe(9); // ceil(7/3)^2 bloques
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 7; j++) {
        expect(matrix.distancesM[i]![j]).toBe(fakeRoadMeters([points[i]!.lng, points[i]!.lat], [points[j]!.lng, points[j]!.lat]));
      }
    }
  });

  it('rechaza una propuesta con más puntos que el límite configurado, sin llamar al motor', async () => {
    const calls: string[] = [];
    const error = await rejection(new OsrmClient(config({ maxPoints: 3 }), createFakeOsrmFetch({}, calls)).matrix([WEST, EAST, NORTH, P(-1.2, -78.6)]));
    expect(error).toMatchObject({ code: 'ROAD_MATRIX_TOO_LARGE', details: { points: 4, maxPoints: 3 } });
    expect(error.getStatus()).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('el motor caído (error de servidor) es ROAD_ENGINE_UNAVAILABLE (503), nunca distancias ficticias', async () => {
    const error = await rejection(new OsrmClient(config(), createFakeOsrmFetch({ mode: 'server-error' })).matrix([WEST, EAST]));
    expect(error).toMatchObject({ code: 'ROAD_ENGINE_UNAVAILABLE' });
    expect(error.getStatus()).toBe(503);
  });

  it('un motor que no responde a tiempo es ROAD_ENGINE_UNAVAILABLE por tiempo agotado', async () => {
    const error = await rejection(new OsrmClient(config({ timeoutMs: 20 }), createFakeOsrmFetch({ mode: 'slow', slowMs: 300 })).matrix([WEST, EAST]));
    expect(error.code).toBe('ROAD_ENGINE_UNAVAILABLE');
    expect(error.message).toContain('20 ms');
  });

  it('una URL sin configurar o sin conexión es ROAD_ENGINE_UNAVAILABLE', async () => {
    expect((await rejection(new OsrmClient(config({ baseUrl: null })).matrix([WEST, EAST]))).code).toBe('ROAD_ENGINE_UNAVAILABLE');
    const refusing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect((await rejection(new OsrmClient(config(), refusing).matrix([WEST, EAST]))).code).toBe('ROAD_ENGINE_UNAVAILABLE');
  });

  it('una respuesta incompleta (faltan duraciones) o que no es JSON es ROAD_ENGINE_BAD_RESPONSE y no se rellena con ceros', async () => {
    const incomplete = await rejection(new OsrmClient(config(), createFakeOsrmFetch({ mode: 'incomplete' })).matrix([WEST, EAST]));
    expect(incomplete).toMatchObject({ code: 'ROAD_ENGINE_BAD_RESPONSE' });
    expect(incomplete.getStatus()).toBe(502);
    expect((await rejection(new OsrmClient(config(), createFakeOsrmFetch({ mode: 'not-json' })).matrix([WEST, EAST]))).code).toBe('ROAD_ENGINE_BAD_RESPONSE');
    expect((await rejection(new OsrmClient(config(), createFakeOsrmFetch({ mode: 'bad-values' })).matrix([WEST, EAST]))).code).toBe('ROAD_ENGINE_BAD_RESPONSE');
  });

  it('el ruido numérico de OSRM (valores levemente negativos) se trata como 0 y no descarta la matriz', async () => {
    const matrix = await new OsrmClient(config(), createFakeOsrmFetch({ mode: 'negative-noise' })).matrix([WEST, EAST]);
    expect(matrix.distancesM[0]![1]).toBe(0);
    expect(matrix.durationsS[0]![1]).toBe(0);
    expect(matrix.distancesM[1]![0]).toBeGreaterThan(0);
  });

  it('un negativo grande sigue siendo una respuesta inválida (ROAD_ENGINE_BAD_RESPONSE)', async () => {
    const error = await rejection(new OsrmClient(config(), createFakeOsrmFetch({ mode: 'bad-distance' })).matrix([WEST, EAST]));
    expect(error).toMatchObject({ code: 'ROAD_ENGINE_BAD_RESPONSE' });
  });

  it('un cierre de conexión aislado se reintenta y la matriz se completa', async () => {
    const real = createFakeOsrmFetch();
    let failures = 2;
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      if (failures-- > 0) throw new TypeError('fetch failed');
      return real(...args);
    }) as typeof fetch;
    const matrix = await new OsrmClient(config(), flaky).matrix([WEST, EAST]);
    expect(matrix.distancesM[0]![1]).toBeGreaterThan(0);
  });

  it('si la conexión sigue fallando tras los reintentos es ROAD_ENGINE_UNAVAILABLE, sin reintentar sin límite', async () => {
    let calls = 0;
    const dead = (async () => {
      calls++;
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const error = await rejection(new OsrmClient(config(), dead).matrix([WEST, EAST]));
    expect(error).toMatchObject({ code: 'ROAD_ENGINE_UNAVAILABLE' });
    expect(calls).toBe(3);
  });

  it('un par sin recorrido es ROAD_ROUTE_NOT_FOUND con los puntos afectados, no una distancia en cero', async () => {
    const error = await rejection(new OsrmClient(config(), createFakeOsrmFetch({ mode: 'no-route-pair', isolatedIndex: 1 })).matrix([WEST, EAST, NORTH]));
    expect(error).toMatchObject({ code: 'ROAD_ROUTE_NOT_FOUND', details: { pointIndexes: [0, 1, 2] } });
    expect(error.getStatus()).toBe(422);
  });

  it('un punto lejos de la red vial es ROAD_POINT_OFF_NETWORK con su índice', async () => {
    const error = await rejection(new OsrmClient(config({ maxSnapDistanceM: 500 }), createFakeOsrmFetch({ mode: 'far-point', isolatedIndex: 1 })).matrix([WEST, EAST]));
    expect(error).toMatchObject({ code: 'ROAD_POINT_OFF_NETWORK', details: { pointIndexes: [1], maxSnapDistanceM: 500 } });
  });
});

describe('OsrmClient: trazado y disponibilidad', () => {
  it('devuelve la geometría en el orden de la visita con su distancia y duración', async () => {
    const trace = await new OsrmClient(config(), createFakeOsrmFetch()).route([WEST, NORTH, WEST]);
    expect(trace.coordinates).toEqual([[WEST.lng, WEST.lat], [NORTH.lng, NORTH.lat], [WEST.lng, WEST.lat]]);
    expect(trace.distanceM).toBeGreaterThan(0);
    expect(trace.durationS).toBeGreaterThan(0);
  });

  it('un trazado incompleto o un solo punto se rechazan', async () => {
    expect((await rejection(new OsrmClient(config(), createFakeOsrmFetch({ mode: 'incomplete' })).route([WEST, EAST]))).code).toBe('ROAD_ENGINE_BAD_RESPONSE');
    expect((await rejection(new OsrmClient(config(), createFakeOsrmFetch()).route([WEST]))).code).toBe('ROAD_ENGINE_BAD_RESPONSE');
  });

  it('nearest informa la distancia al punto de red más cercano', async () => {
    expect(await new OsrmClient(config(), createFakeOsrmFetch()).nearest(WEST)).toEqual({ distanceM: 7 });
  });
});

describe('Configuración del motor vial (#47)', () => {
  it('sin ROAD_ENGINE conserva la línea recta de siempre', () => {
    expect(loadRoadEngineConfig({})).toMatchObject({ engine: 'HAVERSINE', baseUrl: null });
    expect(loadRoadEngineConfig({ ROAD_ENGINE: 'otro', OSRM_BASE_URL: 'http://x' })).toMatchObject({ engine: 'HAVERSINE', baseUrl: null });
  });

  it('con ROAD_ENGINE=OSRM lee la URL, el perfil y los límites, y descarta valores inválidos', () => {
    expect(loadRoadEngineConfig({ ROAD_ENGINE: ' osrm ', OSRM_BASE_URL: 'http://osrm:5000///', OSRM_PROFILE: 'foot', OSRM_TIMEOUT_MS: '1500', OSRM_MAX_POINTS: '120', OSRM_TILE_SIZE: '80', OSRM_CONCURRENCY: '2', OSRM_MAX_SNAP_DISTANCE_M: '250' })).toEqual({
      engine: 'OSRM', baseUrl: 'http://osrm:5000', profile: 'foot', timeoutMs: 1500, maxPoints: 120, tileSize: 50, concurrency: 2, maxSnapDistanceM: 250,
    });
    expect(loadRoadEngineConfig({ ROAD_ENGINE: 'OSRM', OSRM_TIMEOUT_MS: 'abc', OSRM_MAX_POINTS: '-3' })).toMatchObject({ baseUrl: null, timeoutMs: 5000, maxPoints: 300 });
  });
});
