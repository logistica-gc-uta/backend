import { randomUUID } from 'node:crypto';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';

jest.setTimeout(240_000);

describe('Seeder de volumen (#15) sobre PostgreSQL real: reproducible, idempotente y con limpieza verificable', () => {
  let client: any;
  let close: () => Promise<void>;
  let modules: {
    seed: typeof import('../benchmarks/load/seed.js');
    dataset: typeof import('../benchmarks/load/dataset.js');
  };
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);

  const countRows = async (table: 'zone' | 'user' | 'order'): Promise<number> => {
    const sql = {
      zone: client.raw.sql`SELECT count(*)::int AS n FROM public.zone`,
      user: client.raw.sql`SELECT count(*)::int AS n FROM public."user"`,
      order: client.raw.sql`SELECT count(*)::int AS n FROM public."order"`,
    }[table];
    return (await client.transaction((tx: any) => tx.query(sql.returnsRow({ n: 'pg/int4@1' }).build())))[0].n;
  };

  beforeAll(async () => {
    startOwnedContainer();
    const dbUrl = createOwnedDatabase(`perf_seed_${suffix}`);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    const { db } = await import('../src/prisma/db.js');
    client = db;
    close = () => db.close();
    modules = {
      seed: await import('../benchmarks/load/seed.js'),
      dataset: await import('../benchmarks/load/dataset.js'),
    };
    // Un dato "real" que ni el seeder ni la limpieza pueden tocar.
    await client.transaction((tx: any) =>
      tx.execute(client.raw.sql`INSERT INTO public.zone ("id", "name", "code", "createdAt") VALUES (${randomUUID()}, 'Zona real', 'REAL-01', clock_timestamp())`.affectedCount().build()),
    );
  });

  afterAll(async () => {
    if (close) await close();
    cleanupOwnedResources();
  });

  it('crea el volumen pedido y queda contado por marca', async () => {
    const dataset = modules.dataset.buildDataset(100);
    const result = await modules.seed.seedPerf(client, dataset);

    expect(result).toMatchObject({ zonesCreated: 5, clientsCreated: 10, driversCreated: 20, ordersCreated: 100, ordersSkipped: 0 });
    expect(await modules.seed.countPerf(client)).toEqual({
      zones: 5, clients: 10, drivers: 20, driverRows: 20, orders: 100, orderItems: 100, products: 1,
    });
  });

  it('repetirlo con la misma semilla no duplica nada', async () => {
    const result = await modules.seed.seedPerf(client, modules.dataset.buildDataset(100));

    expect(result).toMatchObject({ zonesCreated: 0, clientsCreated: 0, driversCreated: 0, ordersCreated: 0, ordersSkipped: 100 });
    expect((await modules.seed.countPerf(client)).orders).toBe(100);
  });

  it('el volumen de 2000 pedidos se carga y la planificación real propone las salidas esperadas', async () => {
    const dataset = modules.dataset.buildDataset(2000);
    const result = await modules.seed.seedPerf(client, dataset);

    expect(result.ordersCreated).toBe(2000 - 0); // los 100 anteriores usan otra marca de tamaño (PERF/100/...)
    expect((await modules.seed.countPerf(client)).orders).toBe(2100);
  });

  it('la limpieza deja exactamente cero filas marcadas y respeta los datos reales', async () => {
    const removed = await modules.seed.cleanupPerf(client);

    expect(removed.orders).toBe(2100);
    expect(modules.seed.totalRows(await modules.seed.countPerf(client))).toBe(0);
    expect(await countRows('zone')).toBe(1); // sigue 'Zona real'
    expect(await countRows('order')).toBe(0);
    expect(await countRows('user')).toBe(0);
  });

  it('se puede sembrar de nuevo después de limpiar', async () => {
    const result = await modules.seed.seedPerf(client, modules.dataset.buildDataset(500));
    expect(result.ordersCreated).toBe(500);
    await modules.seed.cleanupPerf(client);
    expect(modules.seed.totalRows(await modules.seed.countPerf(client))).toBe(0);
  });
});
