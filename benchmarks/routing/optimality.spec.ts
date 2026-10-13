import { OPTIMALITY_SIZES } from './common.js';
import { MAX_EXACT_ORDERS } from './optimal.js';
import { runOptimality } from './optimality.js';

describe('brecha frente a la solución exacta', () => {
  it('la heurística nunca es mejor que el óptimo (gap >= 0) y a veces lo alcanza', () => {
    const rows = runOptimality(['uniform', 'clustered'], [4, 6, 8], 20);
    for (const row of rows) {
      expect(row.meanGapPercent).toBeGreaterThanOrEqual(0);
      expect(row.maxGapPercent).toBeGreaterThanOrEqual(row.meanGapPercent);
      expect(row.meanHeuristicKm).toBeGreaterThanOrEqual(row.meanOptimalKm - 1e-9);
    }
    expect(rows.some((row) => row.optimalInstances > 0)).toBe(true);
  });

  it('ignora tamaños por encima del tope exacto', () => {
    expect(runOptimality(['uniform'], [4, 11, 50], 3).map((row) => row.orders)).toEqual([4]);
    expect(OPTIMALITY_SIZES.every((n) => n <= MAX_EXACT_ORDERS)).toBe(true);
  });
});
