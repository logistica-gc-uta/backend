import { type LatencySummary, summarizeLatencies } from './stats.js';

/** Una fila del resultado de JMeter (JTL en CSV). */
export interface JtlSample {
  timeStamp: number;
  elapsed: number;
  label: string;
  responseCode: string;
  success: boolean;
  bytes: number;
  allThreads: number;
}

/** Divide una línea CSV respetando comillas dobles y comillas escapadas (""). */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index++;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(current);
      current = '';
    } else current += char;
  }
  fields.push(current);
  return fields;
}

const REQUIRED = ['timeStamp', 'elapsed', 'label', 'responseCode', 'success', 'bytes', 'allThreads'] as const;

/** Lee el texto de un JTL CSV con cabecera. Lanza un error claro si falta alguna columna. */
export function parseJtl(text: string): JtlSample[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]!);
  const column = new Map(header.map((name, index) => [name, index]));
  const missing = REQUIRED.filter((name) => !column.has(name));
  if (missing.length > 0) throw new Error(`El JTL no tiene las columnas: ${missing.join(', ')}`);
  const at = (fields: string[], name: (typeof REQUIRED)[number]) => fields[column.get(name)!] ?? '';

  return lines.slice(1).map((line, row) => {
    const fields = splitCsvLine(line);
    const timeStamp = Number(at(fields, 'timeStamp'));
    const elapsed = Number(at(fields, 'elapsed'));
    if (!Number.isFinite(timeStamp) || !Number.isFinite(elapsed)) {
      throw new Error(`Fila ${row + 2} del JTL con tiempo inválido`);
    }
    return {
      timeStamp,
      elapsed,
      label: at(fields, 'label'),
      responseCode: at(fields, 'responseCode'),
      success: at(fields, 'success') === 'true',
      bytes: Number(at(fields, 'bytes')) || 0,
      allThreads: Number(at(fields, 'allThreads')) || 0,
    };
  });
}

export interface LabelStats extends LatencySummary {
  label: string;
  errors: number;
  errorRate: number;
  /** Peticiones por segundo sobre la ventana medida. */
  throughput: number;
}

export interface JtlReport {
  samples: number;
  errors: number;
  errorRate: number;
  durationSeconds: number;
  throughput: number;
  maxThreads: number;
  overall: LatencySummary;
  byLabel: LabelStats[];
  /** Códigos de respuesta con su conteo, para ver qué tipo de error ocurrió. */
  responseCodes: Record<string, number>;
}

/**
 * Resume una corrida. La duración va del primer arranque al último fin de petición, de modo que el
 * rendimiento (throughput) no se infla con tiempos muertos antes o después de la carga.
 */
export function summarizeJtl(samples: readonly JtlSample[]): JtlReport {
  if (samples.length === 0) {
    return {
      samples: 0, errors: 0, errorRate: 0, durationSeconds: 0, throughput: 0, maxThreads: 0,
      overall: summarizeLatencies([]), byLabel: [], responseCodes: {},
    };
  }
  const start = Math.min(...samples.map((s) => s.timeStamp));
  const end = Math.max(...samples.map((s) => s.timeStamp + s.elapsed));
  const durationSeconds = Math.max((end - start) / 1000, 0.001);
  const errors = samples.filter((s) => !s.success).length;

  const labels = new Map<string, JtlSample[]>();
  const responseCodes: Record<string, number> = {};
  for (const sample of samples) {
    const bucket = labels.get(sample.label) ?? [];
    bucket.push(sample);
    labels.set(sample.label, bucket);
    responseCodes[sample.responseCode] = (responseCodes[sample.responseCode] ?? 0) + 1;
  }

  const byLabel: LabelStats[] = [...labels.entries()]
    .map(([label, items]) => {
      const failed = items.filter((s) => !s.success).length;
      return {
        label,
        ...summarizeLatencies(items.map((s) => s.elapsed)),
        errors: failed,
        errorRate: failed / items.length,
        throughput: items.length / durationSeconds,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    samples: samples.length,
    errors,
    errorRate: errors / samples.length,
    durationSeconds,
    throughput: samples.length / durationSeconds,
    maxThreads: Math.max(...samples.map((s) => s.allThreads)),
    overall: summarizeLatencies(samples.map((s) => s.elapsed)),
    byLabel,
    responseCodes,
  };
}
