#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/70a695f73c329e3d06c6ee0a3d8b301de993c376613442e431adde1392ca8710/contract';
import startContract from '../../snapshots/70a695f73c329e3d06c6ee0a3d8b301de993c376613442e431adde1392ca8710/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/e22e1c24292de6991987b5543666555d140b3af27a2da3628aa3eac1e5109e0f/contract';
import endContract from '../../snapshots/e22e1c24292de6991987b5543666555d140b3af27a2da3628aa3eac1e5109e0f/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'storeCoverage',
        columns: [
          col('coverage', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('lat', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('lng', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('singletonKey', 'text', {
            notNull: true,
            default: lit('GLOBAL'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('updatedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('store_coverage_singleton_23de2fff', '"singletonKey" = \'GLOBAL\''),
          checkExpression(
            'store_coverage_valid_cf74cd43',
            '"lat" >= -90 AND "lat" <= 90 AND "lng" >= -180 AND "lng" <= 180 AND json_typeof("coverage") = \'object\'',
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'storeCoverage',
        constraint: 'storeCoverage_singletonKey_key',
        columns: ['singletonKey'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'storeCoverage',
        index: 'storeCoverage_updatedById_idx_d0517c24',
        columns: ['updatedById'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'storeCoverage',
        foreignKey: {
          name: 'storeCoverage_updatedById_fkey',
          columns: ['updatedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
