#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/1749c53799fc77a70513636955c4c1b5a1668789c3d6dcb5017d4647b1ab9677/contract';
import endContract from '../../snapshots/1749c53799fc77a70513636955c4c1b5a1668789c3d6dcb5017d4647b1ab9677/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/44b4bf8ae3b74cff9e5e2d8511cfe996e38809941f914594e5b4cf2d17f1e0a2/contract';
import startContract from '../../snapshots/44b4bf8ae3b74cff9e5e2d8511cfe996e38809941f914594e5b4cf2d17f1e0a2/contract.json' with { type: 'json' };
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
      this.dropCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_4c96a65c',
      }),
      this.createTable({
        schema: 'public',
        table: 'orderItemLoss',
        columns: [
          col('attemptId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('declarationRequestId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('declaredAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('declaredById', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orderItemId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('productId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('recoveredAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('recoveredById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('recoveryCondition', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('recoveryRequestId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('replacementPreparedAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('replacementPreparedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('replacementRequestId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('unitNumber', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'order_item_loss_recovery_consistent_6470312d',
            '("recoveredAt" IS NULL AND "recoveredById" IS NULL AND "recoveryCondition" IS NULL AND "recoveryRequestId" IS NULL) OR ("recoveredAt" IS NOT NULL AND "recoveredById" IS NOT NULL AND "recoveryCondition" IN (\'SELLABLE\', \'DAMAGED\') AND "recoveryRequestId" IS NOT NULL AND "recoveredAt" >= "declaredAt")',
          ),
          checkExpression(
            'order_item_loss_replacement_consistent_90323337',
            '("replacementPreparedAt" IS NULL AND "replacementPreparedById" IS NULL AND "replacementRequestId" IS NULL) OR ("replacementPreparedAt" IS NOT NULL AND "replacementPreparedById" IS NOT NULL AND "replacementRequestId" IS NOT NULL AND "replacementPreparedAt" >= "declaredAt")',
          ),
          checkExpression('order_item_loss_unit_positive_861d7482', '"unitNumber" >= 1'),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'productStockMovement',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('createdById', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('delta', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('lossId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('productId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('stockAfter', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('product_stock_movement_after_nonnegative_df9a1fe7', '"stockAfter" >= 0'),
          checkExpression(
            'product_stock_movement_valid_50f99fc3',
            "(kind = 'REPLACEMENT_OUT' AND delta = -1) OR (kind = 'RECOVERY_IN' AND delta = 1)",
          ),
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_3cf23df8',
        expression:
          "action IN ('CONFIRM', 'REJECT', 'REORDER', 'MOVE', 'REASSIGN_DRIVER', 'PRIORITIZE', 'CONTACT', 'RESCHEDULE', 'PICKUP_AGREE', 'PICKUP_DECLINE', 'PICKUP_CONFIRM', 'RELEASE_DRAFT', 'LOSS_DECLARE', 'REPLACEMENT_PREPARE', 'ORIGINAL_RECOVER') AND outcome IN ('APPLIED', 'REJECTED', 'FAILED') AND length(trim(reason)) BETWEEN 1 AND 500",
      }),
      this.addUnique({
        schema: 'public',
        table: 'orderItemLoss',
        constraint: 'orderItemLoss_declarationRequestId_key',
        columns: ['declarationRequestId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'orderItemLoss',
        constraint: 'orderItemLoss_replacementRequestId_key',
        columns: ['replacementRequestId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'orderItemLoss',
        constraint: 'orderItemLoss_recoveryRequestId_key',
        columns: ['recoveryRequestId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'orderItemLoss',
        constraint: 'orderItemLoss_orderItemId_unitNumber_key',
        columns: ['orderItemId', 'unitNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'productStockMovement',
        constraint: 'productStockMovement_lossId_kind_key',
        columns: ['lossId', 'kind'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'orderItemLoss_declaredById_idx_dd0c7dda',
        columns: ['declaredById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'orderItemLoss_orderId_idx_d284871b',
        columns: ['orderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'orderItemLoss_orderItemId_idx_99e2d9f7',
        columns: ['orderItemId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'orderItemLoss_productId_idx_5858600a',
        columns: ['productId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'orderItemLoss_recoveredById_idx_2e510b5c',
        columns: ['recoveredById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'orderItemLoss_replacementPreparedById_idx_7117e726',
        columns: ['replacementPreparedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'productStockMovement',
        index: 'productStockMovement_createdById_idx_8bf640ed',
        columns: ['createdById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'productStockMovement',
        index: 'productStockMovement_lossId_idx_644dfa54',
        columns: ['lossId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'productStockMovement',
        index: 'productStockMovement_productId_createdAt_idx_58d1a09b',
        columns: ['productId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'productStockMovement',
        index: 'productStockMovement_productId_idx_5858600a',
        columns: ['productId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderItemLoss',
        foreignKey: {
          name: 'orderItemLoss_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderItemLoss',
        foreignKey: {
          name: 'orderItemLoss_orderItemId_fkey',
          columns: ['orderItemId'],
          references: { schema: 'public', table: 'orderItem', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderItemLoss',
        foreignKey: {
          name: 'orderItemLoss_productId_fkey',
          columns: ['productId'],
          references: { schema: 'public', table: 'product', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderItemLoss',
        foreignKey: {
          name: 'orderItemLoss_declaredById_fkey',
          columns: ['declaredById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderItemLoss',
        foreignKey: {
          name: 'orderItemLoss_replacementPreparedById_fkey',
          columns: ['replacementPreparedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderItemLoss',
        foreignKey: {
          name: 'orderItemLoss_recoveredById_fkey',
          columns: ['recoveredById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'productStockMovement',
        foreignKey: {
          name: 'productStockMovement_productId_fkey',
          columns: ['productId'],
          references: { schema: 'public', table: 'product', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'productStockMovement',
        foreignKey: {
          name: 'productStockMovement_lossId_fkey',
          columns: ['lossId'],
          references: { schema: 'public', table: 'orderItemLoss', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'productStockMovement',
        foreignKey: {
          name: 'productStockMovement_createdById_fkey',
          columns: ['createdById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
