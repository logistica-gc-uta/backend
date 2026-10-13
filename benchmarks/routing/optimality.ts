import { DEFAULT_ROUTE_CAPACITY } from '../../src/modules/routes/algorithms/clarke-wright.js';
import { DEFAULT_KINDS, DISTANCE, OPTIMALITY_INSTANCES, OPTIMALITY_SIZES, depotsFor, plan } from './common.js';
import { type DatasetKind, generateDataset } from './datasets.js';
import { round6 } from './metrics.js';
import { MAX_EXACT_ORDERS, optimalPlanKm } from './optimal.js';

export interface OptimalityRow {
  kind: DatasetKind;
  orders: number;
  instances: number;
  meanGapPercent: number;
  maxGapPercent: number;
  optimalInstances: number;
  meanHeuristicKm: number;
  meanOptimalKm: number;
}

export function runOptimality(
  kinds: DatasetKind[] = DEFAULT_KINDS,
  sizes: number[] = OPTIMALITY_SIZES,
  instances = OPTIMALITY_INSTANCES,
): OptimalityRow[] {
  const rows: OptimalityRow[] = [];
  for (const kind of kinds) {
    for (const size of sizes.filter((n) => n <= MAX_EXACT_ORDERS)) {
      const gaps: number[] = [];
      let heuristicSum = 0;
      let optimalSum = 0;
      let optimal = 0;
      for (let seed = 1; seed <= instances; seed++) {
        const dataset = generateDataset(kind, size, seed);
        const depots = depotsFor(dataset.orders, dataset.depot);
        const heuristic = plan(dataset.orders, depots).reduce((sum, route) => sum + route.totalDistance, 0);
        const exact = optimalPlanKm(dataset.orders, dataset.depot, DEFAULT_ROUTE_CAPACITY, DISTANCE);
        const gap = exact > 0 ? ((heuristic - exact) / exact) * 100 : 0;
        gaps.push(gap);
        heuristicSum += heuristic;
        optimalSum += exact;
        if (gap < 1e-9) optimal++;
      }
      rows.push({
        kind,
        orders: size,
        instances,
        meanGapPercent: round6(gaps.reduce((a, b) => a + b, 0) / gaps.length),
        maxGapPercent: round6(Math.max(...gaps)),
        optimalInstances: optimal,
        meanHeuristicKm: round6(heuristicSum / instances),
        meanOptimalKm: round6(optimalSum / instances),
      });
    }
  }
  return rows;
}
