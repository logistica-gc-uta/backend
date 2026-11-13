/**
 * Validación del motor vial OSRM con calles reales (issue #47). Se ejecuta a mano contra una instancia LOCAL:
 *
 *   OSRM_BASE_URL=http://127.0.0.1:5001 pnpm tsx benchmarks/osrm/validate.ts [salida.json]
 *
 * Usa el mismo adaptador (`OsrmClient`) que el backend, así que además de medir el motor valida el adaptador con
 * respuestas reales. No toca la base de datos ni ningún servicio público: solo `OSRM_BASE_URL`.
 * Los resultados se registran en docs/issue-47-road-engine.md; este script no afirma ningún umbral aprobado.
 */
import { writeFileSync } from 'node:fs';
import { haversineKm } from '../../src/modules/routes/algorithms/geo.util.js';
import { OsrmClient } from '../../src/modules/routes/road/osrm.client.js';
import { DEFAULT_ROAD_CONFIG, RoadMetricsError, type RoadEngineConfig } from '../../src/modules/routes/road/road-metrics.types.js';

const baseUrl = process.env.OSRM_BASE_URL;
if (!baseUrl || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(baseUrl)) {
  console.error('Define OSRM_BASE_URL apuntando a una instancia LOCAL (http://127.0.0.1:<puerto>). No se valida contra servicios públicos.');
  process.exit(1);
}
const out = process.argv[2];
const config: RoadEngineConfig = { ...DEFAULT_ROAD_CONFIG, engine: 'OSRM', baseUrl, maxPoints: 100, tileSize: 50, timeoutMs: 15_000 };
const client = new OsrmClient(config);
// Para analizar la red sin que el límite de ajuste del backend corte la corrida (se filtran los puntos a mano).
const analysis = new OsrmClient({ ...config, maxSnapDistanceM: 1_000_000 });

type P = { lat: number; lng: number };
const STORE: P = { lat: -1.24908, lng: -78.61675 }; // la tienda de demostración de Ambato (seed DEMO/TEST)

/** Cuadrícula reproducible alrededor de Ambato: no depende de direcciones reales ni de datos personales. */
const grid = (rows: number, cols: number, south = -1.3, west = -78.66, dLat = 0.011, dLng = 0.009): P[] =>
  Array.from({ length: rows * cols }, (_, k) => ({ lat: south + Math.floor(k / cols) * dLat, lng: west + (k % cols) * dLng }));

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const timed = async <T>(fn: () => Promise<T>) => {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
};

async function main() {
  const results: Record<string, unknown> = { generatedAt: new Date().toISOString(), baseUrlHost: 'loopback', profile: config.profile };

  // 1. Disponibilidad y ajuste a la red de la tienda.
  const nearest = await client.nearest(STORE);
  results.storeSnapDistanceM = Math.round(nearest.distanceM * 10) / 10;

  // 2. Matrices de tamaños representativos (el límite del servidor es 100 coordenadas por solicitud).
  const sizes: Record<string, unknown> = {};
  for (const [label, rows, cols] of [['10x10 = 100 puntos', 10, 10], ['5x5 = 25 puntos', 5, 5], ['8x8 = 64 puntos', 8, 8]] as const) {
    const points = grid(rows, cols);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) samples.push((await timed(() => analysis.matrix(points))).ms);
    sizes[label] = { points: points.length, requests: 1, p50Ms: Math.round(percentile(samples, 50)), maxMs: Math.round(Math.max(...samples)) };
  }
  results.matrixLatency = sizes;

  // 3. Matriz grande por bloques: 200 puntos = 16 solicitudes de 50x50 (adaptador con tiles).
  const bigCandidates = grid(10, 20, -1.3, -78.7, 0.011, 0.0045);
  const bigConfig = { ...config, maxPoints: 300, concurrency: 4, maxSnapDistanceM: 1_000_000 };
  const big = bigCandidates;
  const tiled = await timed(() => new OsrmClient(bigConfig).matrix(big));
  results.tiledMatrix = { points: big.length, tileSize: 50, concurrency: 4, totalMs: Math.round(tiled.ms), requests: 16 };

  // 4. Rodeo vial frente a línea recta y asimetría, con puntos bien ajustados a la red (≤ 100 m de una calle).
  const candidates = grid(10, 10);
  const probe = await analysis.matrix(candidates);
  const keep = candidates.map((_, i) => i).filter((i) => probe.snapDistancesM[i]! <= 100);
  results.gridPointsTotal = candidates.length;
  results.gridPointsOnNetworkWithin100m = keep.length;
  const city = keep.map((i) => candidates[i]!);
  const matrix = await client.matrix(city);
  const detours: { a: P; b: P; straightM: number; roadM: number; ratio: number }[] = [];
  let asymmetricPairs = 0;
  let pairs = 0;
  let maxAsymmetryM = 0;
  for (let i = 0; i < city.length; i++) {
    for (let j = i + 1; j < city.length; j++) {
      pairs++;
      const forward = matrix.distancesM[i]![j]!;
      const back = matrix.distancesM[j]![i]!;
      const gap = Math.abs(forward - back);
      if (gap > 200) asymmetricPairs++;
      maxAsymmetryM = Math.max(maxAsymmetryM, gap);
      const straightM = haversineKm(city[i]!, city[j]!) * 1000;
      if (straightM > 600 && straightM < 1500) detours.push({ a: city[i]!, b: city[j]!, straightM: Math.round(straightM), roadM: Math.round(forward), ratio: Math.round((forward / straightM) * 100) / 100 });
    }
  }
  detours.sort((x, y) => y.ratio - x.ratio);
  results.asymmetry = { pairs, pairsDifferingOver200m: asymmetricPairs, maxDifferenceM: Math.round(maxAsymmetryM) };
  results.maxSnapDistanceMInSelectedPoints = Math.round(matrix.maxSnapDistanceM);
  results.detourSample = { pairsWithStraightLineBetween600And1500m: detours.length, medianRatio: detours.length ? detours[Math.floor(detours.length / 2)]!.ratio : null, top3: detours.slice(0, 3) };

  // 5. Visita representativa de 4 paradas: recorrido, duración y trazado.
  const stops = [grid(1, 1, -1.262, -78.598)[0]!, grid(1, 1, -1.248, -78.632)[0]!, grid(1, 1, -1.232, -78.612)[0]!, grid(1, 1, -1.241, -78.604)[0]!];
  const visit = [STORE, ...stops, STORE];
  const visitMatrix = await client.matrix([STORE, ...stops]);
  const trace = await client.route(visit);
  // La misma visita medida con la matriz, tramo a tramo y en el sentido recorrido (debe coincidir con el servicio de ruta).
  const order = [0, 1, 2, 3, 4, 0];
  let matrixVisitM = 0;
  let matrixVisitS = 0;
  for (let i = 1; i < order.length; i++) {
    matrixVisitM += visitMatrix.distancesM[order[i - 1]!]![order[i]!]!;
    matrixVisitS += visitMatrix.durationsS[order[i - 1]!]![order[i]!]!;
  }
  let straightKm = 0;
  for (let i = 1; i < visit.length; i++) straightKm += haversineKm(visit[i - 1]!, visit[i]!);
  results.sampleVisit = {
    stops: stops.length,
    straightLineKm: Math.round(straightKm * 1000) / 1000,
    routeServiceKm: Math.round(trace.distanceM) / 1000,
    routeServiceSeconds: Math.round(trace.durationS),
    geometryPoints: trace.coordinates.length,
    matrixVisitKm: Math.round(matrixVisitM) / 1000,
    matrixVisitSeconds: Math.round(matrixVisitS),
    matrixVsRouteServiceDifferenceM: Math.round(Math.abs(matrixVisitM - trace.distanceM)),
  };

  // 6. Comportamiento ante un punto sin conexión: en pleno océano Pacífico, sin ninguna calle cerca.
  try {
    await client.matrix([STORE, { lat: -1.24, lng: -90.0 }]);
    results.offNetworkPoint = 'no se detectó';
  } catch (error) {
    results.offNetworkPoint = error instanceof RoadMetricsError ? { code: error.code, details: error.details } : String(error);
  }

  // 7. Motor inalcanzable: el adaptador devuelve un error tipado en lugar de distancias.
  try {
    await new OsrmClient({ ...config, baseUrl: 'http://127.0.0.1:1', timeoutMs: 1500 }).matrix([STORE, stops[0]!]);
    results.unreachableEngine = 'no falló';
  } catch (error) {
    results.unreachableEngine = error instanceof RoadMetricsError ? { code: error.code, status: error.getStatus() } : String(error);
  }

  console.log(JSON.stringify(results, null, 2));
  if (out) writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
