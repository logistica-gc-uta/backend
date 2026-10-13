import { DEFAULT_KINDS, DEFAULT_SEEDS, OPTIMALITY_INSTANCES, OPTIMALITY_SIZES } from './common.js';
import { runEdgeCases } from './edge-cases.js';
import { runOptimality } from './optimality.js';
import { checksumOf } from './report.js';
import { runDatasets } from './runner.js';

describe('checksum de referencia (regresión y reproducibilidad entre sistemas)', () => {
  // Es el mismo valor que imprime `pnpm run benchmark:routing --quick`. Si cambia el
  // algoritmo, la distancia, los datasets o las semillas, esta prueba falla a propósito:
  // revise el cambio y regenere la referencia con ese comando.
  const QUICK_REFERENCE_CHECKSUM = 'c51525f6e5505d266f6739f35a695cffb2456faf8540a31d5031513cabb9ac92';

  it('la configuración rápida reproduce exactamente la firma registrada', () => {
    const datasets = runDatasets({ sizes: [4, 5, 20, 100], seeds: DEFAULT_SEEDS, kinds: DEFAULT_KINDS, runs: 1 });
    const edgeCases = runEdgeCases();
    const optimality = runOptimality(DEFAULT_KINDS, OPTIMALITY_SIZES, OPTIMALITY_INSTANCES);
    expect(checksumOf({ datasets, edgeCases, optimality })).toBe(QUICK_REFERENCE_CHECKSUM);
  });
});
