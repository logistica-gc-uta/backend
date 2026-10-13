import { runDatasets } from './runner.js';

describe('experimento (datasets)', () => {
  const options = { sizes: [4, 5, 20, 100], seeds: [1, 2], kinds: ['uniform', 'clustered'] as const, runs: 1 };
  const datasets = runDatasets({ ...options, kinds: [...options.kinds] });

  it('cubre cada combinación de tipo, tamaño y semilla', () => {
    expect(datasets).toHaveLength(2 * 4 * 2);
    expect(new Set(datasets.map((d) => d.datasetId)).size).toBe(datasets.length);
  });

  it('ninguna ruta supera 4, mezcla fecha/zona ni duplica pedidos', () => {
    for (const d of datasets) {
      expect(d.violations).toEqual([]);
      expect(d.deterministic.routes).toBeGreaterThanOrEqual(d.deterministic.minimumRoutes);
    }
  });

  it('es reproducible y no depende del orden de entrada', () => {
    for (const d of datasets) {
      expect(d.reproducible).toBe(true);
      expect(d.orderInvariant).toBe(true);
    }
  });

  it('el ahorro es finito, no negativo y menor que 100 %', () => {
    for (const { deterministic: m } of datasets) {
      expect(Number.isFinite(m.savingsPercent)).toBe(true);
      expect(m.savingsPercent).toBeGreaterThanOrEqual(0);
      expect(m.savingsPercent).toBeLessThan(100);
      expect(m.plannedKm).toBeLessThanOrEqual(m.baselineKm + 1e-9);
    }
  });

  it('registra tiempo y memoria sin afectar a las métricas deterministas', () => {
    for (const { performance } of datasets) {
      expect(performance.timeMsMedian).toBeGreaterThanOrEqual(0);
      expect(performance.timeMsMin).toBeLessThanOrEqual(performance.timeMsMax);
      expect(performance.heapDeltaMb).toBeGreaterThanOrEqual(0);
    }
  });
});
