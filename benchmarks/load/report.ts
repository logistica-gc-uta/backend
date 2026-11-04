import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PALETTE, barChart, lineChart } from './charts.js';
import { round } from './stats.js';
import type { StageResult, VolumeResult } from './run.js';

export interface RunResults {
  environment: Record<string, string | number | boolean | undefined>;
  volumes: VolumeResult[];
  stages: StageResult[];
}

const ms = (value: number) => (Number.isFinite(value) ? `${Math.round(value)}` : '—');
const pct = (value: number) => (Number.isFinite(value) ? `${round(value * 100, 2)} %` : '—');
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

/** Un núcleo completo ocupado = 100 %. El % de la herramienta está normalizado al total de núcleos. */
export const coreEquivalent = (cpuPctOfAllCores: number, cores: number) => (cpuPctOfAllCores / 100) * cores;

/**
 * Punto de saturación observado: primera etapa donde el rendimiento (req/s) deja de crecer más de un 10 %
 * respecto al mejor anterior, o el p95 se duplica. Es una observación de esta corrida, no un umbral aprobado.
 */
export function findSaturation(stages: readonly StageResult[]): { stage: string; reason: string } | undefined {
  let bestThroughput = 0;
  let previousP95 = Number.NaN;
  for (const result of stages) {
    if (result.stage.kind === 'recovery') continue;
    const { throughput, overall } = result.http;
    if (bestThroughput > 0 && throughput < bestThroughput * 1.1) {
      return { stage: result.stage.name, reason: `el rendimiento (${round(throughput)} req/s) casi no crece frente al mejor anterior (${round(bestThroughput)} req/s)` };
    }
    if (Number.isFinite(previousP95) && overall.p95 >= previousP95 * 2) {
      return { stage: result.stage.name, reason: `el p95 se duplica (${ms(previousP95)} → ${ms(overall.p95)} ms)` };
    }
    bestThroughput = Math.max(bestThroughput, throughput);
    previousP95 = overall.p95;
  }
  return undefined;
}

export function buildCharts(results: RunResults): Record<string, string> {
  const labels = results.stages.map((s) => `${s.stage.users} u.`);
  const cores = Number(results.environment['cores'] ?? 1);
  return {
    'latencia-por-etapa.svg': lineChart({
      title: 'Latencia por etapa (todas las operaciones)', yLabel: 'milisegundos', xLabels: labels,
      series: [
        { name: 'p50', values: results.stages.map((s) => s.http.overall.p50), color: PALETTE[0] },
        { name: 'p95', values: results.stages.map((s) => s.http.overall.p95), color: PALETTE[1] },
        { name: 'p99', values: results.stages.map((s) => s.http.overall.p99), color: PALETTE[2] },
      ],
    }),
    'rendimiento-por-etapa.svg': barChart({
      title: 'Rendimiento por etapa', yLabel: 'peticiones por segundo', xLabels: labels,
      series: [{ name: 'req/s', values: results.stages.map((s) => s.http.throughput), color: PALETTE[0] }],
    }),
    'recursos-por-etapa.svg': barChart({
      title: 'Uso de CPU por etapa (núcleos equivalentes)', yLabel: 'núcleos (1 = un núcleo completo)', xLabels: labels,
      series: [
        { name: 'API (máx.)', values: results.stages.map((s) => coreEquivalent(s.resources.apiCpuMax, cores)), color: PALETTE[1] },
        { name: 'PostgreSQL (máx.)', values: results.stages.map((s) => coreEquivalent(s.resources.dbCpuMax, cores)), color: PALETTE[2] },
      ],
    }),
    'planificacion-por-volumen.svg': barChart({
      title: 'Planificación Clarke & Wright por volumen (sin carga)', yLabel: 'milisegundos (mediana)', xLabels: results.volumes.map((v) => `${v.size} ped.`),
      series: [{ name: 'p50', values: results.volumes.map((v) => median(v.planningMs)), color: PALETTE[0] }],
    }),
  };
}

export function buildMarkdown(results: RunResults, notes = ''): string {
  const env = results.environment;
  const cores = Number(env['cores'] ?? 1);
  const out: string[] = [];
  const row = (...cells: (string | number)[]) => `| ${cells.join(' | ')} |`;

  out.push('# Reporte no funcional — volumen, carga y estrés (Issue #15)', '');
  out.push(`Ejecutado el ${String(env['date']).slice(0, 10)} sobre el commit \`${String(env['commit']).slice(0, 12)}\`${env['dirty'] ? ' (árbol con cambios sin confirmar)' : ''}.`, '');
  out.push('> Este reporte **no define umbrales de aprobación**: presenta mediciones reales y las limitaciones del ambiente. Los números solo son comparables con corridas del mismo ambiente.', '');

  out.push('## 1. Ambiente', '', row('Elemento', 'Valor'), row('---', '---'));
  out.push(row('Sistema', String(env['os'])), row('CPU', `${env['cpu']} (${cores} hilos)`), row('Memoria', `${env['totalMemGb']} GB`));
  out.push(row('Node.js', String(env['node'])), row('API', String(env['api'])), row('Base de datos', String(env['postgres'])));
  out.push(row('Generador de carga', String(env['jmeter'])), row('Volumen bajo carga', `${env['loadVolume']} pedidos`));
  out.push(row('Limpieza verificada', env['cleanupVerified'] ? 'sí (0 filas marcadas)' : '**no**'), '');
  out.push(`**Limitación:** ${env['note']} Todo fue en \`127.0.0.1\` con una base desechable; no se tocó el VPS público ni datos reales.`, '');

  out.push('## 2. Metodología', '');
  out.push('- **Datos:** semilla fija; mismos pedidos en cada corrida (huella SHA-256 en la tabla de volumen). Todo lo creado lleva la marca `PERF` y se elimina al final con verificación.');
  out.push('- **Volumen:** se siembran 100, 500 y 2000 pedidos y se mide la planificación Clarke & Wright (`GET /route-proposals`) sin otra carga, repetida varias veces.');
  out.push('- **Carga:** JMeter en modo no GUI con 25, 50 y 100 usuarios concurrentes (rampa y duración en la tabla), mezcla aleatoria uniforme de 5 operaciones con 0–300 ms de reflexión.');
  out.push('- **Estrés:** escalones de +100 usuarios hasta el máximo o hasta un **límite seguro** (tasa de errores > 50 %, memoria de la API > 3000 MB o p95 > 30 s). Esos límites protegen el equipo; no son criterios de aprobación.');
  out.push('- **Recuperación:** tras el estrés, una carga baja de 10 usuarios para comparar contra las latencias de reposo.');
  out.push('- **Métricas:** p50/p95/p99 por rango más cercano, rendimiento = peticiones / ventana medida, errores = respuestas no 2xx; CPU y memoria de la API y de PostgreSQL cada ~2 s.', '');

  out.push('## 3. Volumen (sin carga concurrente)', '');
  out.push(row('Pedidos', 'Siembra (s)', 'Planificación p50 (ms)', 'Planificación máx. (ms)', 'Salidas propuestas', 'Salidas teóricas ×4', 'Listado ADMIN (ms)', 'Huella'));
  out.push(row('---', '---', '---', '---', '---', '---', '---', '---'));
  for (const v of results.volumes) {
    out.push(row(v.size, round(v.seedMs / 1000), ms(median(v.planningMs)), ms(Math.max(...v.planningMs)), v.planningSummary.routes, v.theoreticalRoutes, ms(v.adminListMs), `\`${v.checksum.slice(0, 12)}\``));
  }
  out.push('', '![Planificación por volumen](charts/planificacion-por-volumen.svg)', '');

  out.push('## 4. Carga, estrés y recuperación', '');
  out.push(row('Etapa', 'Usuarios', 'Peticiones', 'req/s', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'Errores', 'API CPU máx. (núcleos)', 'API RSS máx. (MB)', 'BD CPU máx. (núcleos)', 'Conexiones BD máx.'));
  out.push(row(...Array<string>(12).fill('---')));
  for (const s of results.stages) {
    out.push(row(s.stage.name, s.stage.users, s.http.samples, round(s.http.throughput), ms(s.http.overall.p50), ms(s.http.overall.p95), ms(s.http.overall.p99), pct(s.http.errorRate),
      round(coreEquivalent(s.resources.apiCpuMax, cores), 2), ms(s.resources.apiRssMaxMb), round(coreEquivalent(s.resources.dbCpuMax, cores), 2), s.resources.dbConnectionsMax));
  }
  out.push('', '![Latencia por etapa](charts/latencia-por-etapa.svg)', '', '![Rendimiento por etapa](charts/rendimiento-por-etapa.svg)', '', '![CPU por etapa](charts/recursos-por-etapa.svg)', '');

  const stopped = results.stages.find((s) => s.stopReason);
  const saturation = findSaturation(results.stages);
  out.push('### Saturación y límites', '');
  out.push(saturation ? `- **Saturación observada:** en \`${saturation.stage}\`, ${saturation.reason}.` : '- No se observó saturación en los escalones ejecutados.');
  out.push(stopped ? `- **Parada por límite seguro:** \`${stopped.stage.name}\` — ${stopped.stopReason}.` : '- No se activó ningún límite seguro: se completaron todos los escalones previstos.');
  const recovery = results.stages.find((s) => s.stage.kind === 'recovery');
  const reference = results.stages.find((s) => s.stage.kind === 'load');
  if (recovery) out.push(`- **Recuperación:** con ${recovery.stage.users} usuarios, p95 ${ms(recovery.http.overall.p95)} ms y ${pct(recovery.http.errorRate)} de errores tras el estrés${reference ? ` (la carga más baja, ${reference.stage.users} usuarios, tuvo p95 ${ms(reference.http.overall.p95)} ms)` : ''}.`);
  out.push('');

  out.push('### Latencia p95 por operación (ms)', '');
  const labels = [...new Set(results.stages.flatMap((s) => s.http.byLabel.map((l) => l.label)))].sort();
  out.push(row('Operación', ...results.stages.map((s) => s.stage.name)), row(...Array<string>(results.stages.length + 1).fill('---')));
  for (const label of labels) out.push(row(label, ...results.stages.map((s) => ms(s.http.byLabel.find((l) => l.label === label)?.p95 ?? Number.NaN))));
  out.push('');

  if (notes.trim()) out.push(notes.trim(), '');
  return out.join('\n');
}

/** Escribe el reporte y sus gráficos bajo `docs/perf/` y devuelve las rutas generadas. */
export function writeReport(results: RunResults, outDir: string, notes = ''): string[] {
  const chartsDir = path.join(outDir, 'charts');
  mkdirSync(chartsDir, { recursive: true });
  const written: string[] = [];
  for (const [name, svg] of Object.entries(buildCharts(results))) {
    const file = path.join(chartsDir, name);
    writeFileSync(file, svg);
    written.push(file);
  }
  const markdown = path.join(outDir, 'REPORT.md');
  writeFileSync(markdown, buildMarkdown(results, notes));
  written.push(markdown);
  return written;
}

if (process.argv[1]?.endsWith('report.ts')) {
  const input = process.argv[2];
  const outDir = process.argv[3];
  const notesPath = process.argv[4];
  if (!input || !outDir || !existsSync(input)) {
    console.error('Uso: report.ts <results.json> <carpeta-de-salida> [notas.md]');
    process.exit(1);
  }
  const files = writeReport(JSON.parse(readFileSync(input, 'utf8')) as RunResults, outDir, notesPath ? readFileSync(notesPath, 'utf8') : '');
  console.log(files.join('\n'));
}
