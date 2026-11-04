import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { type PerfDataset, PERF_TAG } from './dataset.js';

type Client = PrismaService['client'];
type Tx = Parameters<Parameters<Client['transaction']>[0]>[0];

/** Producto de carga: stock enorme para que POST /orders (que reserva inventario) no se agote. */
export const PERF_PRODUCT = { sku: 'PERF-LOAD-001', name: 'Regalo de prueba de carga', price: 10, stock: 1_000_000 } as const;
/** Valor que no corresponde a ninguna contraseña: estos usuarios nunca inician sesión (se firma su token). */
const NO_LOGIN_PASSWORD = 'perf-fixture-no-login';

export interface PerfCounts {
  zones: number;
  clients: number;
  drivers: number;
  driverRows: number;
  orders: number;
  orderItems: number;
  products: number;
}

export const totalRows = (counts: PerfCounts): number => Object.values(counts).reduce((sum, n) => sum + n, 0);

const affected = (stats: unknown): number =>
  typeof stats === 'number' ? stats : ((stats as { affectedRows?: number } | null)?.affectedRows ?? 0);

/** Cuenta, solo por marca, todo lo que el seeder crea o que las pruebas de carga dejan atrás. */
export async function countPerf(client: Client): Promise<PerfCounts> {
  return client.transaction(async (tx: Tx) => {
    const one = async (sql: { returnsRow: (shape: { n: 'pg/int4@1' }) => { build: () => unknown } }) =>
      ((await tx.query(sql.returnsRow({ n: 'pg/int4@1' }).build() as never))[0] as { n: number }).n;
    return {
      zones: await one(client.raw.sql`SELECT count(*)::int AS n FROM public.zone WHERE code LIKE ${`${PERF_TAG.zoneCodePrefix}%`}`),
      clients: await one(client.raw.sql`SELECT count(*)::int AS n FROM public."user" WHERE email LIKE ${`perf-client-%${PERF_TAG.emailDomain}`}`),
      drivers: await one(client.raw.sql`SELECT count(*)::int AS n FROM public."user" WHERE email LIKE ${`perf-driver-%${PERF_TAG.emailDomain}`}`),
      driverRows: await one(client.raw.sql`SELECT count(*)::int AS n FROM public.driver d JOIN public."user" u ON u.id = d."userId" WHERE u.email LIKE ${`%${PERF_TAG.emailDomain}`}`),
      orders: await one(client.raw.sql`SELECT count(*)::int AS n FROM public."order" WHERE "deliveryAddress" LIKE ${`${PERF_TAG.addressPrefix}%`}`),
      orderItems: await one(client.raw.sql`SELECT count(*)::int AS n FROM public."orderItem" i JOIN public."order" o ON o.id = i."orderId" WHERE o."deliveryAddress" LIKE ${`${PERF_TAG.addressPrefix}%`}`),
      products: await one(client.raw.sql`SELECT count(*)::int AS n FROM public.product WHERE sku LIKE 'PERF-%'`),
    };
  });
}

export interface SeedPerfResult {
  zonesCreated: number;
  clientsCreated: number;
  driversCreated: number;
  ordersCreated: number;
  ordersSkipped: number;
}

/**
 * Inserta el conjunto de datos de forma idempotente: lo que ya existe (por código de zona, correo o
 * dirección) se omite, así que repetir el comando con la misma semilla no duplica nada.
 */
export async function seedPerf(client: Client, dataset: PerfDataset): Promise<SeedPerfResult> {
  const result: SeedPerfResult = { zonesCreated: 0, clientsCreated: 0, driversCreated: 0, ordersCreated: 0, ordersSkipped: 0 };
  const scheduled = Temporal.PlainDate.from(dataset.date, { overflow: 'reject' })
    .toZonedDateTime({ timeZone: 'America/Guayaquil', plainTime: '10:00' })
    .toInstant();

  await client.transaction(async (tx: Tx) => {
    const idOf = async (plan: unknown): Promise<string | undefined> =>
      ((await tx.query(plan as never)) as { id: string }[])[0]?.id;

    for (const zone of dataset.zones) {
      result.zonesCreated += affected(await tx.execute(client.raw.sql`
        INSERT INTO public.zone ("id", "name", "code", "depotLat", "depotLng", "createdAt")
        VALUES (${randomUUID()}, ${zone.name}, ${zone.code}, ${zone.depotLat}, ${zone.depotLng}, clock_timestamp())
        ON CONFLICT DO NOTHING`.affectedCount().build()));
    }

    for (const [users, role] of [[dataset.clients, 'CLIENT'], [dataset.drivers, 'DRIVER']] as const) {
      for (const user of users) {
        const created = affected(await tx.execute(client.raw.sql`
          INSERT INTO public."user" ("id", "name", "email", "password", "role", "createdAt")
          VALUES (${randomUUID()}, ${user.name}, ${user.email}, ${NO_LOGIN_PASSWORD}, ${role}, clock_timestamp())
          ON CONFLICT ("email") DO NOTHING`.affectedCount().build()));
        if (role === 'CLIENT') result.clientsCreated += created;
        else {
          result.driversCreated += created;
          await tx.execute(client.raw.sql`
            INSERT INTO public.driver ("id", "userId", "vehicle", "isAvailable", "createdAt")
            SELECT ${randomUUID()}, u.id, 'Vehículo de prueba de carga', true, clock_timestamp()
            FROM public."user" u WHERE u.email = ${user.email}
            ON CONFLICT ("userId") DO NOTHING`.affectedCount().build());
        }
      }
    }

    await tx.execute(client.raw.sql`
      INSERT INTO public.product ("id", "name", "description", "price", "sku", "stock", "isPublished", "isFeatured", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${PERF_PRODUCT.name}, 'Producto sintético para pruebas de rendimiento', ${PERF_PRODUCT.price},
              ${PERF_PRODUCT.sku}, ${PERF_PRODUCT.stock}, false, false, clock_timestamp(), clock_timestamp())
      ON CONFLICT ("sku") DO NOTHING`.affectedCount().build());
    const productId = await idOf(client.raw.sql`SELECT id FROM public.product WHERE sku = ${PERF_PRODUCT.sku}`.returnsRow({ id: 'pg/text@1' }).build());

    const existing = new Set(
      ((await tx.query(client.raw.sql`SELECT "deliveryAddress" AS a FROM public."order" WHERE "deliveryAddress" LIKE ${`${PERF_TAG.addressPrefix}%`}`
        .returnsRow({ a: 'pg/text@1' }).build())) as { a: string }[]).map((row) => row.a),
    );

    for (const order of dataset.orders) {
      if (existing.has(order.deliveryAddress)) {
        result.ordersSkipped++;
        continue;
      }
      const orderId = randomUUID();
      result.ordersCreated += affected(await tx.execute(client.raw.sql`
        INSERT INTO public."order" ("id", "userId", "zoneId", "status", "total", "deliveryAddress", "scheduledDeliveryDate",
                                    "deliveryLat", "deliveryLng", "createdAt")
        SELECT ${orderId}, u.id, z.id, 'PENDING', ${PERF_PRODUCT.price}, ${order.deliveryAddress}, ${scheduled.toString()}::timestamptz,
               ${order.lat}, ${order.lng}, clock_timestamp()
        FROM public."user" u, public.zone z WHERE u.email = ${order.clientEmail} AND z.code = ${order.zoneCode}`.affectedCount().build()));
      await tx.execute(client.raw.sql`
        INSERT INTO public."orderItem" ("id", "orderId", "productId", "quantity", "price")
        VALUES (${randomUUID()}, ${orderId}, ${productId!}, 1, ${PERF_PRODUCT.price})`.affectedCount().build());
    }
  });
  return result;
}

/** Borra SOLO lo marcado (zonas PERF-, correos @perf.test, direcciones PERF/, producto PERF-). */
export async function cleanupPerf(client: Client): Promise<PerfCounts> {
  const before = await countPerf(client);
  await client.transaction(async (tx: Tx) => {
    const run = (plan: unknown) => tx.execute(plan as never);
    const address = `${PERF_TAG.addressPrefix}%`;
    const email = `%${PERF_TAG.emailDomain}`;
    await run(client.raw.sql`DELETE FROM public."orderItem" WHERE "orderId" IN (SELECT id FROM public."order" WHERE "deliveryAddress" LIKE ${address})`.affectedCount().build());
    await run(client.raw.sql`DELETE FROM public."order" WHERE "deliveryAddress" LIKE ${address}`.affectedCount().build());
    await run(client.raw.sql`DELETE FROM public.driver WHERE "userId" IN (SELECT id FROM public."user" WHERE email LIKE ${email})`.affectedCount().build());
    await run(client.raw.sql`DELETE FROM public."user" WHERE email LIKE ${email}`.affectedCount().build());
    await run(client.raw.sql`DELETE FROM public.zone WHERE code LIKE ${`${PERF_TAG.zoneCodePrefix}%`}`.affectedCount().build());
    await run(client.raw.sql`DELETE FROM public.product WHERE sku LIKE 'PERF-%'`.affectedCount().build());
  });
  return before;
}
