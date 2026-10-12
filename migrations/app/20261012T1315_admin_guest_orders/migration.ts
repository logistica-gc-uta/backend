#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/15ef5b17c1444e1f37222de1c696766119c6c4494633f6c5fcb256dee13cba83/contract';
import startContract from '../../snapshots/15ef5b17c1444e1f37222de1c696766119c6c4494633f6c5fcb256dee13cba83/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/e357d1aa2fdc74464e729ec7cd8bb087b979a13b22e0f88aa005b60be4c16427/contract';
import endContract from '../../snapshots/e357d1aa2fdc74464e729ec7cd8bb087b979a13b22e0f88aa005b60be4c16427/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('createdById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('deliveryWindowEnd', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('deliveryWindowStart', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('recipientName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('recipientPhone', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('recipientType', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.dropNotNull({ schema: 'public', table: 'order', column: 'userId' }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'order',
        constraint: 'order_delivery_window_valid_f5c8ac7d',
        expression:
          'COALESCE(("deliveryWindowStart" IS NULL AND "deliveryWindowEnd" IS NULL) OR ("deliveryWindowStart" IS NOT NULL AND "deliveryWindowEnd" IS NOT NULL AND "scheduledDeliveryDate" IS NOT NULL AND "deliveryWindowStart" < "deliveryWindowEnd" AND "scheduledDeliveryDate" >= "deliveryWindowStart" AND "scheduledDeliveryDate" <= "deliveryWindowEnd" AND ("deliveryWindowStart" AT TIME ZONE \'America/Guayaquil\')::date = ("deliveryWindowEnd" AT TIME ZONE \'America/Guayaquil\')::date), false)',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'order',
        constraint: 'order_recipientType_check_42f2716e',
        expression: "\"recipientType\" IN ('REGISTERED_CLIENT', 'GUEST')",
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'order',
        constraint: 'order_recipient_identity_valid_34850a45',
        expression:
          'COALESCE(("recipientType" IS NULL AND "userId" IS NOT NULL) OR ("recipientType" = \'GUEST\' AND "userId" IS NULL AND "createdById" IS NOT NULL AND "recipientName" ~ \'[^[:space:]]\' AND "recipientPhone" ~ \'[^[:space:]]\') OR ("recipientType" = \'REGISTERED_CLIENT\' AND "userId" IS NOT NULL AND "createdById" IS NOT NULL AND "recipientName" ~ \'[^[:space:]]\'), false)',
      }),
      this.createIndex({
        schema: 'public',
        table: 'order',
        index: 'order_createdById_idx_8bf640ed',
        columns: ['createdById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'order',
        index: 'order_scheduledDeliveryDate_idx_f9ab4656',
        columns: ['scheduledDeliveryDate'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'order',
        index: 'order_zoneId_status_scheduledDeliveryDate_idx_2a0dd38d',
        columns: ['zoneId', 'status', 'scheduledDeliveryDate'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'order',
        foreignKey: {
          name: 'order_createdById_fkey',
          columns: ['createdById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
