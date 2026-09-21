#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/ade716a5854bac9da24d9d458e813194b99fcacf7c156ace530749782dfead7f/contract';
import endContract from '../../snapshots/ade716a5854bac9da24d9d458e813194b99fcacf7c156ace530749782dfead7f/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d6f44c1bba6da74b308ffcb049cf2d87834547aeaf438b7e706ba21c4707bd47/contract';
import startContract from '../../snapshots/d6f44c1bba6da74b308ffcb049cf2d87834547aeaf438b7e706ba21c4707bd47/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';
import postgres from '@prisma/orm-postgres/runtime';

const { sql: db, contract } = postgres<End>({ contractJson: endContract });

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('scheduledDeliveryDate', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('stopOrder', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('deliveryAddress', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.dataTransform(contract, 'backfill-order-deliveryAddress', {
        check: () => db.public.order.select('id').where((f, fns) => fns.eq(f.deliveryAddress, null)).limit(1),
        run: () => db.public.order.update({ deliveryAddress: 'Sin dirección registrada' }).where((f, fns) => fns.eq(f.deliveryAddress, null)),
      }),
      this.setNotNull({ schema: 'public', table: 'order', column: 'deliveryAddress' }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

