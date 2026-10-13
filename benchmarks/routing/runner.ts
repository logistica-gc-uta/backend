import { DEFAULT_ROUTE_CAPACITY } from '../../src/modules/routes/algorithms/clarke-wright.js';
import { DISTANCE, depotsFor, plan, shuffled, signature } from './common.js';
import { type DatasetKind, generateDataset } from './datasets.js';
import { verifyProposal } from './invariants.js';
import { type DeterministicMetrics, deterministicMetrics } from './metrics.js';

export interface BenchmarkOptions {
  sizes: number[];
  seeds: number[];
  kinds: DatasetKind[];
  runs: number;
  capacity?: number;
}

export interface PerformanceMetrics {
  runs: number;
  timeMsMedian: number;
  timeMsMin: number;
  timeMsMax: number;
  heapDeltaMb: number;
}

export interface DatasetResult {
  datasetId: string;
  kind: DatasetKind;
  seed: number;
  deterministic: DeterministicMetrics;
  violations: string[];
  reproducible: boolean;
  orderInvariant: boolean;
  performance: PerformanceMetrics;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function measure(fn: () => unknown, runs: number, innerReps: number): PerformanceMetrics {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  fn();
  const heapDelta = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    for (let k = 0; k < innerReps; k++) fn();
    times.push((performance.now() - start) / innerReps);
  }
  return {
    runs,
    timeMsMedian: median(times),
    timeMsMin: Math.min(...times),
    timeMsMax: Math.max(...times),
    heapDeltaMb: heapDelta / (1024 * 1024),
  };
}

export function runDatasets(options: BenchmarkOptions): DatasetResult[] {
  const capacity = options.capacity ?? DEFAULT_ROUTE_CAPACITY;
  const results: DatasetResult[] = [];
  for (const kind of options.kinds) {
    for (const size of options.sizes) {
      for (const seed of options.seeds) {
        const dataset = generateDataset(kind, size, seed);
        const depots = depotsFor(dataset.orders, dataset.depot);
        const routes = plan(dataset.orders, depots, capacity);
        const again = plan(dataset.orders, depots, capacity);
        const reordered = plan(shuffled(dataset.orders, seed), depots, capacity);
        results.push({
          datasetId: dataset.id,
          kind,
          seed,
          deterministic: deterministicMetrics(dataset.orders, routes, depots, DISTANCE, capacity),
          violations: verifyProposal({ orders: dataset.orders, routes, depots, distance: DISTANCE, capacity }),
          reproducible: signature(routes) === signature(again),
          orderInvariant: signature(routes) === signature(reordered),
          performance: measure(
            () => plan(dataset.orders, depots, capacity),
            options.runs,
            size <= 20 ? 200 : size <= 100 ? 10 : 1,
          ),
        });
      }
    }
  }
  return results;
}
