import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupOwnedResources, createOwnedDatabase, runPrismaMigrate, startOwnedContainer } from '../../test/geolocation-migration.fixtures.js';
import { VOLUME_SIZES, buildDataset, datasetChecksum, theoreticalRoutes } from './dataset.js';
import { type FixtureRow, buildFixtureCsv, mintJwt } from './fixture.js';
import { type JtlReport, parseJtl, summarizeJtl } from './jtl.js';
import { type ResourceSample, type ResourceSummary, startMonitor, summarizeResources } from './monitor.js';
import { cleanupPerf, countPerf, seedPerf, totalRows } from './seed.js';
import { DEFAULT_SAFETY_LIMITS, type Stage, loadStages, recoveryStage, safetyStop, stressStages } from './stages.js';

/**
 *   pnpm perf:run --jmeter <ruta a jmeter(.bat)> [--volume 2000] [--include-200] [--max-users 400] [--quick] [--out <dir>]
 *   Diagnóstico: [--no-planning] quita la propuesta de rutas de la mezcla; [--skip-volume]; [--only carga-25,carga-100]
 *
 * Todo ocurre en la máquina local: PostgreSQL desechable en Docker, API en 127.0.0.1 y JMeter en modo no GUI.
 * Nunca se conecta a un servidor público ni a datos reales. Ejecútalo con la laptop conectada a la corriente.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLAN = path.join(ROOT, 'benchmarks/load/api-load.jmx');
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;

const arg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface StageResult {
  stage: Stage;
  startedAt: number;
  endedAt: number;
  http: JtlReport;
  resources: ResourceSummary;
  stopReason?: string;
}
export interface VolumeResult {
  size: number;
  checksum: string;
  theoreticalRoutes: number;
  seedMs: number;
  planningMs: number[];
  planningSummary: { candidateOrders: number; plannedOrders: number; excludedOrders: number; routes: number };
  adminListMs: number;
}

async function timed<T>(action: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await action();
  return [value, performance.now() - start];
}

async function waitForApi(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${BASE}/api/v1/shop/products`)).ok) return;
    } catch {
      /* todavía arrancando */
    }
    await sleep(500);
  }
  throw new Error('La API no respondió en 60 s');
}

function runJmeter(jmeter: string, stage: Stage, dirs: { out: string; fixture: string }, date: string, planning: boolean): Promise<void> {
  const jtl = path.join(dirs.out, `${stage.name}.jtl`);
  const args = [
    '-n', '-t', PLAN, '-l', jtl, '-j', path.join(dirs.out, `${stage.name}.jmeter.log`),
    `-Jhost=127.0.0.1`, `-Jport=${PORT}`, `-Jusers=${stage.users}`, `-Jrampup=${stage.rampupSeconds}`,
    `-Jduration=${stage.durationSeconds}`, `-Jfixture=${dirs.fixture}`, `-Jdate=${date}`, `-Jplanning=${planning}`,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(`"${jmeter}"`, args.map((a) => (a.includes(' ') ? `"${a}"` : a)), {
      shell: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, HEAP: '-Xms512m -Xmx2g' },
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`JMeter terminó con código ${code} en ${stage.name}`))));
  });
}

async function main() {
  const jmeter = arg('jmeter') ?? process.env['JMETER_BIN'];
  if (!jmeter || !existsSync(jmeter)) throw new Error('Indica --jmeter <ruta> (o JMETER_BIN) con la ruta a jmeter / jmeter.bat');
  if (!existsSync(path.join(ROOT, 'dist/main.js'))) throw new Error('Falta dist/main.js: ejecuta `pnpm build` primero');
  const quick = flag('quick');
  const volume = Number(arg('volume', '2000'));
  if (!(VOLUME_SIZES as readonly number[]).includes(volume)) throw new Error(`--volume debe ser uno de ${VOLUME_SIZES.join(', ')}`);

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(arg('out') ?? path.join(ROOT, 'test-results/perf', `${stamp}-${commit.slice(0, 8)}`));
  mkdirSync(out, { recursive: true });

  if (process.env['DATABASE_URL']) log('Se ignora el DATABASE_URL del entorno: se usa solo la base desechable de la corrida');
  const secret = randomBytes(32).toString('hex');
  const container = startOwnedContainer();
  const dbName = `perf_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const dbUrl = createOwnedDatabase(dbName);
  runPrismaMigrate(dbUrl);
  process.env['DATABASE_URL'] = dbUrl;
  process.env['JWT_SECRET'] = secret;
  const { db } = await import('../../src/prisma/db.js');

  let api: ChildProcess | undefined;
  let monitor: ReturnType<typeof startMonitor> | undefined;
  const stages: StageResult[] = [];
  const volumes: VolumeResult[] = [];
  let cleanupVerified = false;

  try {
    const adminId = randomUUID();
    // La limpieza borra todo lo marcado @perf.test (incluido este ADMIN), así que se recrea con el mismo id.
    const ensureAdmin = () => db.transaction((tx) => tx.execute(db.raw.sql`
      INSERT INTO public."user" ("id", "name", "email", "password", "role", "createdAt")
      VALUES (${adminId}, 'Admin Perf', 'perf-admin@perf.test', 'perf-fixture-no-login', 'ADMIN', clock_timestamp())
      ON CONFLICT ("email") DO NOTHING`.affectedCount().build()));
    await ensureAdmin();
    const adminToken = mintJwt(secret, { sub: adminId, email: 'perf-admin@perf.test', role: 'ADMIN' }, 6 * 3600);

    api = spawn(process.execPath, ['dist/main.js'], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, PORT: String(PORT), DATABASE_URL: dbUrl, JWT_SECRET: secret, NODE_ENV: 'production' },
    });
    await waitForApi();
    log(`API arriba (pid ${api.pid}) en ${BASE}; base ${dbName}`);
    monitor = startMonitor({ apiPid: api.pid!, dbContainer: container.containerId, dbName, dbUser: container.user });
    const authed = { headers: { Authorization: `Bearer ${adminToken}` } };

    // ── Volumen: 100 / 500 / 2000 pedidos, sin carga concurrente ───────────────────────────
    for (const size of flag('skip-volume') ? [] : VOLUME_SIZES) {
      await cleanupPerf(db);
      await ensureAdmin();
      const dataset = buildDataset(size);
      const [, seedMs] = await timed(() => seedPerf(db, dataset));
      const planningMs: number[] = [];
      let summary = { candidateOrders: 0, plannedOrders: 0, excludedOrders: 0, routes: 0 };
      for (let run = 0; run < (quick ? 2 : 5); run++) {
        const [res, ms] = await timed(() => fetch(`${BASE}/api/v1/route-proposals?date=${dataset.date}`, authed));
        const body = (await res.json()) as { summary?: typeof summary; message?: string };
        if (!res.ok || !body.summary) throw new Error(`La planificación de ${size} pedidos falló (${res.status}): ${body.message ?? ''}`);
        planningMs.push(ms);
        summary = body.summary;
      }
      const [list, adminListMs] = await timed(() => fetch(`${BASE}/api/v1/orders?date=${dataset.date}&page=1&pageSize=20`, authed));
      if (!list.ok) throw new Error(`El listado ADMIN de ${size} pedidos falló (${list.status})`);
      volumes.push({ size, checksum: datasetChecksum(dataset), theoreticalRoutes: theoreticalRoutes(dataset), seedMs, planningMs, planningSummary: summary, adminListMs });
      log(`Volumen ${size}: siembra ${(seedMs / 1000).toFixed(1)} s · planificación p50 ${[...planningMs].sort((a, b) => a - b)[Math.floor(planningMs.length / 2)]!.toFixed(0)} ms · ${summary.routes} salidas`);
    }

    // ── Fixture de JMeter sobre el volumen de carga ────────────────────────────────────────
    await cleanupPerf(db);
    await ensureAdmin();
    await seedPerf(db, buildDataset(volume));
    const clients = await db.transaction((tx) => tx.query(db.raw.sql`SELECT id, email FROM public."user" WHERE email LIKE 'perf-client-%@perf.test' ORDER BY email`
      .returnsRow({ id: 'pg/text@1', email: 'pg/text@1' }).build()));
    const zones = await db.transaction((tx) => tx.query(db.raw.sql`SELECT id, "depotLat" AS lat, "depotLng" AS lng FROM public.zone WHERE code LIKE 'PERF-%' ORDER BY code`
      .returnsRow({ id: 'pg/text@1', lat: 'pg/float8@1', lng: 'pg/float8@1' }).build()));
    const products = await db.transaction((tx) => tx.query(db.raw.sql`SELECT id FROM public.product WHERE sku LIKE 'PERF-LOAD-%' ORDER BY sku`.returnsRow({ id: 'pg/text@1' }).build()));
    const rows: FixtureRow[] = [];
    for (const client of clients) {
      const clientToken = mintJwt(secret, { sub: client.id, email: client.email, role: 'CLIENT' }, 6 * 3600);
      for (const zone of zones) {
        rows.push({ adminToken, clientToken, zoneId: zone.id, productId: products[rows.length % products.length]!.id, lat: zone.lat, lng: zone.lng });
      }
    }
    const fixture = path.join(out, 'fixture.csv'); // contiene tokens de la corrida: NO se versiona (test-results/ está ignorado)
    writeFileSync(fixture, buildFixtureCsv(rows));

    // ── Carga, estrés y recuperación ───────────────────────────────────────────────────────
    const duration = quick ? 15 : undefined;
    const plan: Stage[] = [
      ...loadStages({ include200: flag('include-200'), durationSeconds: duration }),
      ...stressStages({ maxUsers: Number(arg('max-users', '400')), durationSeconds: quick ? 15 : 45 }),
    ];
    let stopReason: string | undefined;
    const only = arg('only')?.split(',');
    for (const stage of [...plan, recoveryStage(10, quick ? 15 : 30)]) {
      if (only && !only.includes(stage.name)) continue;
      if (stopReason && stage.kind === 'stress') continue;
      const startedAt = Date.now();
      log(`Etapa ${stage.name}: ${stage.users} usuarios, ${stage.durationSeconds} s`);
      await runJmeter(jmeter, stage, { out, fixture }, buildDataset(volume).date, !flag('no-planning'));
      const endedAt = Date.now();
      const http = summarizeJtl(parseJtl(readFileSync(path.join(out, `${stage.name}.jtl`), 'utf8')));
      const slice: ResourceSample[] = monitor.samples.filter((s) => s.t >= startedAt && s.t <= endedAt + 2000);
      const resources = summarizeResources(slice);
      const result: StageResult = { stage, startedAt, endedAt, http, resources };
      if (stage.kind !== 'recovery') {
        stopReason = safetyStop(DEFAULT_SAFETY_LIMITS, { errorRate: http.errorRate, apiRssMb: resources.apiRssMaxMb, p95Ms: http.overall.p95 });
        if (stopReason) result.stopReason = stopReason;
      }
      stages.push(result);
      log(`  → ${http.samples} peticiones · ${http.throughput.toFixed(1)} req/s · p95 ${http.overall.p95} ms · errores ${(http.errorRate * 100).toFixed(2)} %${stopReason ? ` · PARADA: ${stopReason}` : ''}`);
      if (!api || api.exitCode !== null) throw new Error('La API se cayó durante la corrida');
      await sleep(3000); // respiro entre etapas
    }
  } finally {
    await monitor?.stop().catch(() => undefined);
    api?.kill();
    try {
      await cleanupPerf(db);
      cleanupVerified = totalRows(await countPerf(db)) === 0;
    } catch (error) {
      log(`Limpieza fallida: ${error instanceof Error ? error.message : String(error)}`);
    }
    await db.close().catch(() => undefined);
    cleanupOwnedResources();
  }

  const environment = {
    commit, dirty, date: new Date().toISOString(),
    os: `${os.type()} ${os.release()} (${os.arch()})`, cpu: os.cpus()[0]?.model.trim(), cores: os.cpus().length,
    totalMemGb: Math.round((os.totalmem() / 1073741824) * 10) / 10, node: process.version,
    postgres: 'postgres:16-alpine (Docker, contenedor desechable, tmpfs)', jmeter: path.basename(path.dirname(path.dirname(jmeter))),
    api: 'node dist/main.js (un solo proceso, sin clúster)', loadVolume: volume, quick, cleanupVerified,
    note: 'API, PostgreSQL, JMeter y el monitor comparten la misma laptop; JMeter compite por CPU con la API.',
    planningInMix: !flag('no-planning'),
  };
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ environment, volumes, stages }, null, 2));
  log(`Resultados en ${out}`);
  if (!cleanupVerified) throw new Error('La limpieza no pudo verificarse');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
