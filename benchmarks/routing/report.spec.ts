import { runEdgeCases } from './edge-cases.js';
import { runOptimality } from './optimality.js';
import { checksumOf } from './report.js';
import { runDatasets } from './runner.js';

describe('checksum determinista', () => {
  const options = { sizes: [4, 5, 20, 100], seeds: [1, 2], kinds: ['uniform', 'clustered'] as const, runs: 1 };
  const datasets = runDatasets({ ...options, kinds: [...options.kinds] });

  it('el checksum determinista se repite y cambia si cambia un resultado', () => {
    const edgeCases = runEdgeCases();
    const optimality = runOptimality(['uniform'], [4, 5], 5);
    const again = runDatasets({ ...options, kinds: [...options.kinds] });
    const a = checksumOf({ datasets, edgeCases, optimality });
    expect(checksumOf({ datasets: again, edgeCases, optimality })).toBe(a);
    const tampered = structuredClone(datasets);
    tampered[0]!.deterministic.plannedKm += 1;
    expect(checksumOf({ datasets: tampered, edgeCases, optimality })).not.toBe(a);
  });

  it('el checksum ignora el tiempo y la memoria (dependen de la máquina)', () => {
    const edgeCases = runEdgeCases();
    const optimality = runOptimality(['uniform'], [4], 3);
    const slower = structuredClone(datasets);
    slower[0]!.performance.timeMsMedian += 1000;
    slower[0]!.performance.heapDeltaMb += 50;
    expect(checksumOf({ datasets: slower, edgeCases, optimality })).toBe(checksumOf({ datasets, edgeCases, optimality }));
  });
});
