#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/4f1c811137748b11cce955f4802840d44e900a662cca49432139410ca3195b57/contract';
import endContract from '../../snapshots/4f1c811137748b11cce955f4802840d44e900a662cca49432139410ca3195b57/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/defd240814f2524f7af9bf379253487edc9887ac231ea845a81baa9c7f768009/contract';
import startContract from '../../snapshots/defd240814f2524f7af9bf379253487edc9887ac231ea845a81baa9c7f768009/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'driver',
        column: col('vehicleCapacity', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'driver',
        constraint: 'driver_vehicle_capacity_positive_54f17fab',
        expression: '"vehicleCapacity" IS NULL OR "vehicleCapacity" >= 1',
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
