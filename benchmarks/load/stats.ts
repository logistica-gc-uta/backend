/** Percentil por rango más cercano (nearest-rank) sobre una lista ya ordenada de menor a mayor. */
export function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (p <= 0) return sorted[0]!;
  if (p >= 100) return sorted[sorted.length - 1]!;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

export interface LatencySummary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return { count: 0, min: Number.NaN, mean: Number.NaN, p50: Number.NaN, p95: Number.NaN, p99: Number.NaN, max: Number.NaN };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    mean: sum / sorted.length,
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
    max: sorted[sorted.length - 1]!,
  };
}

/** Redondeo a `digits` decimales para tablas y reportes. */
export const round = (value: number, digits = 1): number => {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
