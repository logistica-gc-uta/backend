import { performance } from 'node:perf_hooks';
import { AdminOrdersDatabase } from './admin-guest-orders-migration.fixtures';
import { InventorySession } from './admin-guest-orders-inventory.fixtures';

// All objects live only in the owned disposable database. AFTER INSERT blocks
// after actual writes; nontransactional sequences prove execution after rollback.
export function installDeliveryBarrier(database: AdminOrdersDatabase) {
  database.sql('unit_b', `
    CREATE SCHEMA delivery_evidence;
    CREATE SEQUENCE delivery_evidence.stock_writes;
    CREATE SEQUENCE delivery_evidence.item_writes;
    CREATE FUNCTION delivery_evidence.stock_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('delivery_evidence.stock_writes'); RETURN NEW; END $$;
    CREATE TRIGGER delivery_stock_write AFTER UPDATE OF stock ON public.product
      FOR EACH ROW EXECUTE FUNCTION delivery_evidence.stock_write();
    CREATE FUNCTION delivery_evidence.item_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public."order" WHERE id=NEW."orderId" AND "deliveryAddress"='d-final-barrier') THEN
        PERFORM nextval('delivery_evidence.item_writes');
        PERFORM pg_advisory_xact_lock(110011);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER delivery_item_barrier AFTER INSERT ON public."orderItem"
      FOR EACH ROW EXECUTE FUNCTION delivery_evidence.item_barrier();
  `);
}

export async function futureDeadline(observer: InventorySession): Promise<string> {
  const result = await observer.query("SELECT to_char((clock_timestamp() + interval '2 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS deadline");
  return result.rows[0].deadline;
}

export async function waitForDeadline(observer: InventorySession, deadline: string) {
  const bound = performance.now() + 8000;
  while (performance.now() < bound) {
    const result = await observer.query('SELECT clock_timestamp() >= $1::timestamptz AS expired', [deadline]);
    if (result.rows[0].expired) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Database clock did not reach delivery deadline within 8s');
}

export async function waitForItemBarrier(observer: InventorySession) {
  const bound = performance.now() + 8000;
  while (performance.now() < bound) {
    const result = await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'
      AND query ILIKE '%orderItem%' AND pid <> pg_backend_pid()`);
    if (result.rows[0].n === 1) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Did not observe actual item INSERT advisory barrier within 8s');
}
