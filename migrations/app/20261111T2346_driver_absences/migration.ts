#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/d0d70e575dc12d82fbeab635c30dcd5aa849f52f9bccb3251a8e414bdd715ba8/contract';
import startContract from '../../snapshots/d0d70e575dc12d82fbeab635c30dcd5aa849f52f9bccb3251a8e414bdd715ba8/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/e44d61fd753bd3404c42e85b9570cb95731fcf8b6f1659b4e254e2a4774adc70/contract';
import endContract from '../../snapshots/e44d61fd753bd3404c42e85b9570cb95731fcf8b6f1659b4e254e2a4774adc70/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'driverAbsence',
        columns: [
          col('cancelReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('cancelledAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('cancelledById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('createdById', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('driverId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('endDate', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('startDate', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'driver_absence_cancellation_consistent_63a24d0f',
            '("cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancelReason" IS NULL) OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND ("cancelReason" IS NULL OR length("cancelReason") BETWEEN 1 AND 300))',
          ),
          checkExpression(
            'driver_absence_valid_d56413e5',
            '"startDate" ~ \'^[0-9]{4}-[0-9]{2}-[0-9]{2}$\' AND "endDate" ~ \'^[0-9]{4}-[0-9]{2}-[0-9]{2}$\' AND "endDate" >= "startDate" AND (reason IS NULL OR length(reason) BETWEEN 1 AND 300)',
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverAbsence',
        index: 'driverAbsence_cancelledById_idx_03ce7bea',
        columns: ['cancelledById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverAbsence',
        index: 'driverAbsence_createdById_idx_8bf640ed',
        columns: ['createdById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverAbsence',
        index: 'driverAbsence_driverId_idx_8eed3317',
        columns: ['driverId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverAbsence',
        index: 'driverAbsence_driverId_startDate_endDate_idx_a101ef33',
        columns: ['driverId', 'startDate', 'endDate'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'driverAbsence',
        foreignKey: {
          name: 'driverAbsence_driverId_fkey',
          columns: ['driverId'],
          references: { schema: 'public', table: 'driver', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'driverAbsence',
        foreignKey: {
          name: 'driverAbsence_createdById_fkey',
          columns: ['createdById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'driverAbsence',
        foreignKey: {
          name: 'driverAbsence_cancelledById_fkey',
          columns: ['cancelledById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
