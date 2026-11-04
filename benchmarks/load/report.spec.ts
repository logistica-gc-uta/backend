import { barChart, lineChart, niceMax } from './charts.js';
import { buildCharts, buildMarkdown, coreEquivalent, findSaturation, type RunResults } from './report.js';
import type { StageResult } from './run.js';

const summary = (p95: number) => ({ count: 100, min: 1, mean: 50, p50: p95 / 2, p95, p99: p95 * 1.2, max: p95 * 2 });
const stage = (name: string, kind: 'load' | 'stress' | 'recovery', users: number, throughput: number, p95: number, extra: Partial<StageResult> = {}): StageResult => ({
  stage: { name, kind, users, rampupSeconds: 5, durationSeconds: 30 },
  startedAt: 0, endedAt: 1,
  http: {
    samples: 1000, errors: 0, errorRate: 0, durationSeconds: 30, throughput, maxThreads: users, overall: summary(p95),
    byLabel: [{ label: 'GET catalogo', ...summary(p95), errors: 0, errorRate: 0, throughput }], responseCodes: { '200': 1000 },
  },
  resources: { samples: 10, apiCpuAvg: 3, apiCpuMax: 4, apiRssMaxMb: 600, dbCpuAvg: 5, dbCpuMax: 9, dbMemMaxMb: 200, dbConnectionsMax: 12 },
  ...extra,
});
const results: RunResults = {
  environment: { date: '2026-11-04T00:00:00Z', commit: 'abcdef1234567890', dirty: false, cores: 32, cpu: 'CPU X', totalMemGb: 32, os: 'Win', node: 'v26', api: 'api', postgres: 'pg', jmeter: 'jm', loadVolume: 2000, cleanupVerified: true, note: 'Misma laptop.' },
  volumes: [{ size: 100, checksum: 'a'.repeat(64), theoreticalRoutes: 25, seedMs: 300, planningMs: [50, 52, 60], planningSummary: { candidateOrders: 100, plannedOrders: 100, excludedOrders: 0, routes: 26 }, adminListMs: 10 }],
  stages: [stage('carga-25', 'load', 25, 100, 200), stage('carga-50', 'load', 50, 180, 300), stage('estres-100', 'stress', 100, 185, 900, { stopReason: 'p95 alto' }), stage('recuperacion-10', 'recovery', 10, 90, 150)],
};

describe('gráficos SVG', () => {
  it('niceMax redondea hacia arriba a un valor legible', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(73)).toBe(100);
    expect(niceMax(180)).toBe(200);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });

  it('el gráfico de líneas trae título, etiquetas, una línea por serie y es XML bien formado', () => {
    const svg = lineChart({ title: 'Prueba <&>', yLabel: 'ms', xLabels: ['a', 'b'], series: [{ name: 'p95', values: [1, 2], color: '#000' }, { name: 'p50', values: [1, Number.NaN], color: '#111' }] });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Prueba &lt;&amp;&gt;');
    expect(svg.match(/<polyline/g)).toHaveLength(2);
    expect(svg).not.toContain('NaN');
  });

  it('el gráfico de barras dibuja una barra por valor finito', () => {
    const svg = barChart({ title: 'B', yLabel: 'x', xLabels: ['a', 'b', 'c'], series: [{ name: 's', values: [1, 2, Number.NaN], color: '#000' }] });
    expect(svg.match(/<rect x=/g)).toHaveLength(2);
    expect(svg).not.toContain('NaN');
  });

  it('genera los cuatro gráficos del reporte', () => {
    expect(Object.keys(buildCharts(results)).sort()).toEqual([
      'latencia-por-etapa.svg', 'planificacion-por-volumen.svg', 'recursos-por-etapa.svg', 'rendimiento-por-etapa.svg',
    ]);
  });
});

describe('reporte Markdown', () => {
  it('convierte el CPU normalizado a núcleos equivalentes', () => {
    expect(coreEquivalent(3.125, 32)).toBeCloseTo(1);
  });

  it('detecta la saturación cuando el rendimiento deja de crecer', () => {
    expect(findSaturation(results.stages)).toEqual({ stage: 'estres-100', reason: expect.stringContaining('casi no crece') });
    expect(findSaturation([stage('a', 'load', 1, 10, 100), stage('b', 'load', 2, 30, 120)])).toBeUndefined();
    expect(findSaturation([stage('a', 'load', 1, 10, 100), stage('b', 'load', 2, 30, 250)])?.reason).toContain('p95 se duplica');
  });

  it('incluye ambiente, metodología, tablas, gráficos, límite de parada y declara que no hay umbrales aprobados', () => {
    const md = buildMarkdown(results, '## Hallazgos\n\nTexto.');
    for (const text of ['## 1. Ambiente', '## 2. Metodología', '## 3. Volumen', '## 4. Carga, estrés y recuperación', 'no define umbrales de aprobación', 'abcdef123456', 'carga-25', '![Latencia por etapa](charts/latencia-por-etapa.svg)', 'Parada por límite seguro', 'Recuperación', '## Hallazgos', 'sí (0 filas marcadas)']) {
      expect(md).toContain(text);
    }
    expect(md).not.toContain('NaN');
  });

  it('marca como no verificada una limpieza que falló', () => {
    expect(buildMarkdown({ ...results, environment: { ...results.environment, cleanupVerified: false } })).toContain('**no**');
  });
});
