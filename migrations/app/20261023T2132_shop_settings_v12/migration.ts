#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/b263aff9f248d0da2ead5a0700a5b035ab3653ec79e1f8c651ab5f936e21e1ea/contract';
import startContract from '../../snapshots/b263aff9f248d0da2ead5a0700a5b035ab3653ec79e1f8c651ab5f936e21e1ea/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d2724cd80d3f574f0e1fb083c0426dab7b696331f1ca7b50fb62a3473125576e/contract';
import endContract from '../../snapshots/d2724cd80d3f574f0e1fb083c0426dab7b696331f1ca7b50fb62a3473125576e/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
  rawSql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'shopBusinessSettings',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('currency', 'text', {
            notNull: true,
            default: lit('USD'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('deliveryBoundariesInclusive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('deliveryEndTime', 'text', {
            notNull: true,
            default: lit('17:00'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('deliveryStartTime', 'text', {
            notNull: true,
            default: lit('07:00'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('deliveryTimeZone', 'text', {
            notNull: true,
            default: lit('America/Guayaquil'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('maxUnitsPerSkuPerOrder', 'int4', {
            notNull: true,
            default: lit(10),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('shippingAmountCents', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('shippingIncludedInPrices', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('shippingStatus', 'text', {
            notNull: true,
            default: lit('FREE_INCLUDED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('singletonKey', 'text', {
            notNull: true,
            default: lit('GLOBAL'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('taxEnabled', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('taxMode', 'text', {
            notNull: true,
            default: lit('SIMULATED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('taxRateBps', 'int4', {
            notNull: true,
            default: lit(1500),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('updatedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('version', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('shop_settings_singleton_23de2fff', '"singletonKey" = \'GLOBAL\''),
          checkExpression(
            'shop_settings_valid_abaee184',
            'version >= 1 AND currency = \'USD\' AND "shippingStatus" = \'FREE_INCLUDED\' AND "shippingAmountCents" = 0 AND "shippingIncludedInPrices" = true AND "taxMode" = \'SIMULATED\' AND "taxRateBps" BETWEEN 0 AND 10000 AND "maxUnitsPerSkuPerOrder" BETWEEN 1 AND 100 AND "deliveryTimeZone" = \'America/Guayaquil\' AND "deliveryBoundariesInclusive" = true AND "deliveryStartTime" ~ \'^([01][0-9]|2[0-3]):[0-5][0-9]$\' AND "deliveryEndTime" ~ \'^([01][0-9]|2[0-3]):[0-5][0-9]$\' AND "deliveryStartTime" < "deliveryEndTime"',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'shopSettingsAudit',
        columns: [
          col('actorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('changedFields', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('expectedVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('newVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('recordedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('settingsId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('snapshot', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'shop_settings_audit_version_step_ba9c3ee0',
            '"expectedVersion" >= 1 AND "newVersion" = "expectedVersion" + 1',
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'shopBusinessSettings',
        constraint: 'shopBusinessSettings_singletonKey_key',
        columns: ['singletonKey'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'shopBusinessSettings',
        index: 'shopBusinessSettings_updatedById_idx_d0517c24',
        columns: ['updatedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'shopSettingsAudit',
        index: 'shopSettingsAudit_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'shopSettingsAudit',
        index: 'shopSettingsAudit_recordedAt_idx_fd5b4732',
        columns: ['recordedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'shopSettingsAudit',
        index: 'shopSettingsAudit_settingsId_idx_6654474f',
        columns: ['settingsId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'shopBusinessSettings',
        foreignKey: {
          name: 'shopBusinessSettings_updatedById_fkey',
          columns: ['updatedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'shopSettingsAudit',
        foreignKey: {
          name: 'shopSettingsAudit_settingsId_fkey',
          columns: ['settingsId'],
          references: { schema: 'public', table: 'shopBusinessSettings', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'shopSettingsAudit',
        foreignKey: {
          name: 'shopSettingsAudit_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      rawSql({
        id: 'shop-settings-v12-seed-singleton',
        label: 'Seed idempotent singleton shop settings default row',
        operationClass: 'data',
        target: { id: 'postgres', details: { objectType: 'table', schema: 'public', name: 'shopBusinessSettings' } },
        precheck: [{
          description: 'shopBusinessSettings table exists',
          sql: `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shopBusinessSettings') AS result`,
        }],
        execute: [{
          description: 'Insert singleton settings row with explicit S4 defaults if not already present',
          sql: `INSERT INTO public."shopBusinessSettings" (
  id,
  "singletonKey",
  version,
  currency,
  "shippingStatus",
  "shippingAmountCents",
  "shippingIncludedInPrices",
  "taxMode",
  "taxEnabled",
  "taxRateBps",
  "maxUnitsPerSkuPerOrder",
  "deliveryTimeZone",
  "deliveryStartTime",
  "deliveryEndTime",
  "deliveryBoundariesInclusive",
  "updatedById",
  "createdAt",
  "updatedAt"
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'GLOBAL',
  1,
  'USD',
  'FREE_INCLUDED',
  0,
  true,
  'SIMULATED',
  true,
  1500,
  10,
  'America/Guayaquil',
  '07:00',
  '17:00',
  true,
  NULL,
  now(),
  now()
) ON CONFLICT ("singletonKey") DO NOTHING;`,
        }],
        postcheck: [{
          description: 'Exactly one singleton row exists in shopBusinessSettings',
          sql: `SELECT count(*) = 1 AS result FROM public."shopBusinessSettings" WHERE "singletonKey" = 'GLOBAL'`,
        }],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
