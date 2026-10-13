import { createHash } from 'node:crypto';
import type { EdgeCaseResult } from './edge-cases.js';
import type { OptimalityRow } from './optimality.js';
import type { DatasetResult } from './runner.js';

export interface BenchmarkReport {
  meta: Record<string, unknown>;
  datasets: DatasetResult[];
  edgeCases: EdgeCaseResult[];
  optimality: OptimalityRow[];
  deterministicChecksum: string;
}

/**
 * Firma SHA-256 de todo lo que NO depende de la máquina (métricas en km, rutas,
 * invariantes, casos de borde y brecha exacta). Dos ejecuciones con el mismo
 * código y las mismas semillas deben dar la misma firma; tiempo y memoria quedan fuera.
 */
export function checksumOf(report: Pick<BenchmarkReport, 'datasets' | 'edgeCases' | 'optimality'>): string {
  const payload = {
    datasets: report.datasets.map(({ datasetId, deterministic, violations, reproducible, orderInvariant }) => ({
      datasetId,
      deterministic,
      violations,
      reproducible,
      orderInvariant,
    })),
    edgeCases: report.edgeCases.map(({ id, pass, observed }) => ({ id, pass, observed })),
    optimality: report.optimality,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
