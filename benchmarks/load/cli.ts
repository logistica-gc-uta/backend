import 'dotenv/config';
import { db } from '../../src/prisma/db.js';
import { DEFAULT_DATE, DEFAULT_SEED, VOLUME_SIZES, buildDataset, datasetChecksum, theoreticalRoutes } from './dataset.js';
import { cleanupPerf, countPerf, seedPerf, totalRows } from './seed.js';

/**
 *   pnpm perf:seed --size 500 [--seed 20261104] [--date 2030-02-14]
 *   pnpm perf:cleanup
 *   pnpm perf:status
 *
 * Solo para bases LOCALES o aisladas. Se niega a correr si DATABASE_URL no apunta a localhost/127.0.0.1
 * (nunca contra el VPS público ni contra datos reales).
 */
function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

export function assertLocalDatabase(url: string | undefined): void {
  let host = '';
  try {
    host = new URL(url ?? '').hostname;
  } catch {
    throw new Error('DATABASE_URL ausente o inválida');
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
    throw new Error(`Rechazado: la base (${host}) no es local. Las pruebas de rendimiento solo corren en entornos aislados.`);
  }
}

async function main() {
  assertLocalDatabase(process.env['DATABASE_URL']);
  const command = process.argv[2];
  if (command === 'seed') {
    const size = Number(arg('size', '500'));
    if (!(VOLUME_SIZES as readonly number[]).includes(size)) throw new Error(`--size debe ser uno de ${VOLUME_SIZES.join(', ')}`);
    const dataset = buildDataset(size, Number(arg('seed', String(DEFAULT_SEED))), arg('date', DEFAULT_DATE));
    const result = await seedPerf(db, dataset);
    console.log(`Dataset ${size} pedidos · semilla ${dataset.seed} · huella ${datasetChecksum(dataset).slice(0, 16)}`);
    console.log(`Salidas teóricas de cuatro en cuatro: ${theoreticalRoutes(dataset)}`);
    console.log('Resultado:', result);
  } else if (command === 'cleanup') {
    const removed = await cleanupPerf(db);
    const after = await countPerf(db);
    console.log('Eliminado:', removed);
    if (totalRows(after) !== 0) throw new Error(`La limpieza no dejó cero filas marcadas: ${JSON.stringify(after)}`);
    console.log('Verificado: 0 filas marcadas PERF restantes.');
  } else if (command === 'status') {
    console.log(await countPerf(db));
  } else {
    throw new Error('Uso: cli.ts seed|cleanup|status');
  }
}

if (process.argv[1]?.endsWith('cli.ts')) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
