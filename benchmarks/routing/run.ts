import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_KINDS, DEFAULT_SEEDS, DEFAULT_SIZES, DISTANCE, OPTIMALITY_INSTANCES, OPTIMALITY_SIZES } from './common.js';
import { BOX_DEGREES, CLUSTER_SIGMA_DEGREES, DEPOT, ORDERS_PER_CLUSTER } from './datasets.js';
import { runEdgeCases } from './edge-cases.js';
import { runOptimality } from './optimality.js';
import { csv, stringifyReport } from './output.js';
import { type BenchmarkReport, checksumOf } from './report.js';
import { type BenchmarkOptions, runDatasets } from './runner.js';
import { DEFAULT_ROUTE_CAPACITY } from '../../src/modules/routes/algorithms/clarke-wright.js';

// Uso: pnpm run benchmark:routing [--out dir] [--runs 5] [--sizes 4,5,20] [--seeds 1,2,3] [--quick]
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const numbers = (value: string | undefined, fallback: number[]) =>
  value ? value.split(',').map((item) => Number(item.trim())) : fallback;

const quick = process.argv.includes('--quick');
const options: BenchmarkOptions = {
  sizes: numbers(arg('sizes'), quick ? [4, 5, 20, 100] : DEFAULT_SIZES),
  seeds: numbers(arg('seeds'), DEFAULT_SEEDS),
  kinds: DEFAULT_KINDS,
  runs: Number(arg('runs') ?? (quick ? 1 : 5)),
  capacity: DEFAULT_ROUTE_CAPACITY,
};
if ([...options.sizes, ...options.seeds, options.runs].some((value) => !Number.isInteger(value) || value < 0) || options.runs < 1) {
  throw new Error('--sizes, --seeds y --runs deben ser enteros (runs >= 1)');
}
const outDir = resolve(arg('out') ?? 'reports/benchmark');

function git(command: string): string {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

console.log(`Benchmark Haversine + Clarke & Wright · tamaños ${options.sizes.join(', ')} · semillas ${options.seeds.join(', ')} · ${options.runs} corrida(s)`);
const started = performance.now();
const datasets = runDatasets(options);
const edgeCases = runEdgeCases();
const optimality = runOptimality(DEFAULT_KINDS, OPTIMALITY_SIZES, OPTIMALITY_INSTANCES);

const report: BenchmarkReport = {
  meta: {
    command: `pnpm run benchmark:routing${process.argv.slice(2).length ? ' ' + process.argv.slice(2).join(' ') : ''}`,
    generatedAt: new Date().toISOString(),
    commit: git('git rev-parse --short HEAD'),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    sizes: options.sizes,
    seeds: options.seeds,
    kinds: options.kinds,
    runs: options.runs,
    capacity: options.capacity,
    distance: `Haversine, radio terrestre 6371 km, misma función (${DISTANCE.name}) para línea base y heurística`,
    depot: DEPOT,
    uniformBoxHalfSideDegrees: BOX_DEGREES,
    clusterSigmaDegrees: CLUSTER_SIGMA_DEGREES,
    ordersPerCluster: ORDERS_PER_CLUSTER,
    optimalitySizes: OPTIMALITY_SIZES,
    optimalityInstancesPerSize: OPTIMALITY_INSTANCES,
    peakRssMb: Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10,
    gcExposed: typeof (globalThis as { gc?: unknown }).gc === 'function',
    elapsedSeconds: Math.round(((performance.now() - started) / 1000) * 10) / 10,
  },
  datasets,
  edgeCases,
  optimality,
  deterministicChecksum: checksumOf({ datasets, edgeCases, optimality }),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'routing-benchmark.json'), stringifyReport(report as unknown as Record<string, unknown>));
writeFileSync(
  join(outDir, 'routing-benchmark.csv'),
  csv(
    datasets.map((d) => ({
      datasetId: d.datasetId,
      kind: d.kind,
      seed: d.seed,
      ...d.deterministic,
      violations: d.violations.length,
      reproducible: d.reproducible,
      orderInvariant: d.orderInvariant,
      timeMsMedian: d.performance.timeMsMedian.toFixed(3),
      timeMsMin: d.performance.timeMsMin.toFixed(3),
      timeMsMax: d.performance.timeMsMax.toFixed(3),
      heapDeltaMb: d.performance.heapDeltaMb.toFixed(2),
      runs: d.performance.runs,
    })),
  ),
);
writeFileSync(join(outDir, 'routing-edge-cases.csv'), csv(edgeCases.map((e) => ({ ...e }))));
writeFileSync(join(outDir, 'routing-optimality.csv'), csv(optimality.map((o) => ({ ...o }))));

// Resumen en consola
const pad = (value: unknown, width: number) => String(value).padStart(width);
console.log('\nkind       orders seed   baseline km  planned km  ahorro %  rutas  util %   t mediana ms  ok');
for (const d of datasets) {
  const m = d.deterministic;
  const ok = d.violations.length === 0 && d.reproducible && d.orderInvariant;
  console.log(
    `${d.kind.padEnd(10)} ${pad(m.orders, 6)} ${pad(d.seed, 4)} ${pad(m.baselineKm.toFixed(2), 12)} ${pad(m.plannedKm.toFixed(2), 11)} ${pad(m.savingsPercent.toFixed(2), 9)} ${pad(m.routes, 6)} ${pad((m.utilization * 100).toFixed(1), 7)} ${pad(d.performance.timeMsMedian.toFixed(2), 13)}  ${ok ? 'OK' : 'FALLA'}`,
  );
}
const failedEdges = edgeCases.filter((e) => !e.pass);
console.log(`\nCasos de borde: ${edgeCases.length - failedEdges.length}/${edgeCases.length} cumplen lo esperado`);
for (const e of failedEdges) console.log(`  FALLA ${e.id}: esperado «${e.expected}», observado «${e.observed}»`);
console.log(`Brecha frente a la solución exacta (≤ 10 pedidos): ${optimality.map((o) => `${o.kind} n=${o.orders}: media ${o.meanGapPercent.toFixed(2)} %`).join(' · ')}`);
console.log(`\nChecksum determinista: ${report.deterministicChecksum}`);
console.log(`Artefactos en ${outDir}`);

const failedDatasets = datasets.filter((d) => d.violations.length || !d.reproducible || !d.orderInvariant);
if (failedDatasets.length || failedEdges.length) {
  console.error(`\n${failedDatasets.length} dataset(s) y ${failedEdges.length} caso(s) de borde con fallos`);
  process.exit(1);
}
