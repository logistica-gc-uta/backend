import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { AdminOrdersDatabase } from './admin-guest-orders-migration.fixtures';

// Resolve the installed Prisma driver's pg, without adding a dependency.
const driverRequire = createRequire(`${process.cwd()}/package.json`);
const pg = driverRequire(driverRequire.resolve('pg', { paths: [driverRequire.resolve('@prisma/orm-postgres/runtime')] })) as {
  Client: new (options: { connectionString: string; application_name: string }) => InventorySession;
};
export interface InventorySession {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>;
  end(): Promise<void>;
}
export async function session(database: AdminOrdersDatabase, name: string) {
  const client = new pg.Client({ connectionString: database.ownedUrl('unit_b'), application_name: name });
  await client.connect();
  await client.query("SET statement_timeout = '10s'");
  return client;
}

// Observe PostgreSQL's actual lock waits, not request launch timing or sleeps.
export async function waitForProductWaiters(observer: InventorySession, count: number) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const result = await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
      AND query ILIKE '%product%' AND pid <> pg_backend_pid()`);
    if (result.rows[0].n >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Did not observe ${count} product lock waiters within 8s`);
}

export function installRollbackEvidence(database: AdminOrdersDatabase) {
  database.sql('unit_b', `
    CREATE SCHEMA inventory_evidence;
    CREATE SEQUENCE inventory_evidence.stock_writes;
    CREATE FUNCTION inventory_evidence.stock_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('inventory_evidence.stock_writes'); RETURN NEW; END $$;
    CREATE TRIGGER inventory_stock_write AFTER UPDATE OF stock ON public.product
      FOR EACH ROW EXECUTE FUNCTION inventory_evidence.stock_write();
    CREATE FUNCTION inventory_evidence.fail_order() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."deliveryAddress"='c-fail-order' THEN RAISE EXCEPTION 'owned order failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER inventory_fail_order BEFORE INSERT ON public."order"
      FOR EACH ROW EXECUTE FUNCTION inventory_evidence.fail_order();
    CREATE FUNCTION inventory_evidence.fail_line() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF EXISTS (SELECT 1 FROM public."order" WHERE id=NEW."orderId" AND "deliveryAddress"='c-fail-line')
      THEN RAISE EXCEPTION 'owned line failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER inventory_fail_line BEFORE INSERT ON public."orderItem"
      FOR EACH ROW EXECUTE FUNCTION inventory_evidence.fail_line();
  `);
}
