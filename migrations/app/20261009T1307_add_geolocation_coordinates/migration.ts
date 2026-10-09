#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/00d34ab56ae55b663a53148a126d233c0801ea6863ee0e3b22273a20d77d862e/contract';
import endContract from '../../snapshots/00d34ab56ae55b663a53148a126d233c0801ea6863ee0e3b22273a20d77d862e/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/ade716a5854bac9da24d9d458e813194b99fcacf7c156ace530749782dfead7f/contract';
import startContract from '../../snapshots/ade716a5854bac9da24d9d458e813194b99fcacf7c156ace530749782dfead7f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('deliveryLat', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('deliveryLng', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'zone',
        column: col('depotLat', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'zone',
        column: col('depotLng', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'order',
        constraint: 'order_delivery_coordinates_valid_84ff84b6',
        expression:
          '("deliveryLat" IS NULL AND "deliveryLng" IS NULL) OR ("deliveryLat" IS NOT NULL AND "deliveryLng" IS NOT NULL AND "deliveryLat" >= -90 AND "deliveryLat" <= 90 AND "deliveryLng" >= -180 AND "deliveryLng" <= 180)',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'zone',
        constraint: 'zone_depot_coordinates_valid_5c13ee7e',
        expression:
          '("depotLat" IS NULL AND "depotLng" IS NULL) OR ("depotLat" IS NOT NULL AND "depotLng" IS NOT NULL AND "depotLat" >= -90 AND "depotLat" <= 90 AND "depotLng" >= -180 AND "depotLng" <= 180)',
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
