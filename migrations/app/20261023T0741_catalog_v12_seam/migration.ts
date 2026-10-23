#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/9f73d985865e87ee2463db38ee9153132c0c6748c5ca43dda00b82d77a1685af/contract';
import endContract from '../../snapshots/9f73d985865e87ee2463db38ee9153132c0c6748c5ca43dda00b82d77a1685af/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/eb8ebd14b89f17eea5458cd12220be7bd572fa8f0e3771b68d2089c880e18f83/contract';
import startContract from '../../snapshots/eb8ebd14b89f17eea5458cd12220be7bd572fa8f0e3771b68d2089c880e18f83/contract.json' with { type: 'json' };
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
        table: 'category',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('isActive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('slug', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sortOrder', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'category_catalog_valid_a3d92e40',
            'length(name) BETWEEN 2 AND 80 AND length(slug) BETWEEN 2 AND 100 AND slug ~ \'^[a-z0-9]+(-[a-z0-9]+)*$\' AND (description IS NULL OR length(description) <= 300) AND "sortOrder" BETWEEN 0 AND 9999',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'productImage',
        columns: [
          col('altText', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('isPrimary', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('position', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('productId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('publicId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('secureUrl', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('uploadId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'product_image_valid_3fc3f514',
            'position BETWEEN 0 AND 5 AND length("altText") BETWEEN 1 AND 160 AND "secureUrl" LIKE \'https://%\'',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'uploadedAsset',
        columns: [
          col('actorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('attachedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('bytes', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('cleanupAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('cleanupAttempts', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('expiresAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('format', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('height', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('lastCleanupError', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('publicId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('secureUrl', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('UPLOADED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('width', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'upload_asset_valid_5f740ac4',
            "status IN ('UPLOADED', 'ATTACHED', 'CLEANUP_PENDING', 'DELETED') AND bytes BETWEEN 1 AND 5242880 AND width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192 AND format IN ('jpg', 'png', 'webp') AND \"cleanupAttempts\" >= 0 AND \"secureUrl\" LIKE 'https://%'",
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('subtotalCents', 'int8', { codecRef: { codecId: 'pg/int8@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'orderItem',
        column: col('unitPriceCents', 'int8', { codecRef: { codecId: 'pg/int8@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'product',
        column: col('categoryId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'product',
        column: col('isFeatured', 'bool', {
          notNull: true,
          default: lit(false),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'product',
        column: col('isPublished', 'bool', {
          notNull: true,
          default: lit(false),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'product',
        column: col('priceCents', 'int8', { codecRef: { codecId: 'pg/int8@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'product',
        column: col('sku', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'product',
        column: col('updatedAt', 'timestamptz', {
          notNull: true,
          default: fn('now()'),
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addUnique({
        schema: 'public',
        table: 'category',
        constraint: 'category_slug_key',
        columns: ['slug'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'product',
        constraint: 'product_catalog_amount_inventory_f7383703',
        expression:
          'stock >= 0 AND ("priceCents" IS NULL OR "priceCents" BETWEEN 1 AND 9007199254740991)',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'product',
        constraint: 'product_publish_fields_0565da4d',
        expression:
          'NOT "isPublished" OR ("categoryId" IS NOT NULL AND "priceCents" IS NOT NULL AND sku IS NOT NULL AND description IS NOT NULL AND length(description) BETWEEN 1 AND 2000 AND length(name) BETWEEN 3 AND 160)',
      }),
      this.addUnique({
        schema: 'public',
        table: 'product',
        constraint: 'product_sku_key',
        columns: ['sku'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'productImage',
        constraint: 'productImage_uploadId_key',
        columns: ['uploadId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'productImage',
        constraint: 'productImage_productId_position_key',
        columns: ['productId', 'position'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'uploadedAsset',
        constraint: 'uploadedAsset_publicId_key',
        columns: ['publicId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'category',
        index: 'category_isActive_sortOrder_name_idx_43d1bbe8',
        columns: ['isActive', 'sortOrder', 'name'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'product',
        index: 'product_categoryId_idx_15c304f2',
        columns: ['categoryId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'product',
        index: 'product_categoryId_isPublished_idx_00525e08',
        columns: ['categoryId', 'isPublished'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'product',
        index: 'product_isPublished_isFeatured_idx_7b878b80',
        columns: ['isPublished', 'isFeatured'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'productImage',
        index: 'one_primary_image_per_product_a7598f0a',
        columns: ['productId'],
        extras: { where: '("isPrimary" = true)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'uploadedAsset',
        index: 'uploadedAsset_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'uploadedAsset',
        index: 'uploadedAsset_status_expiresAt_idx_c206f415',
        columns: ['status', 'expiresAt'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'product',
        foreignKey: {
          name: 'product_categoryId_fkey',
          columns: ['categoryId'],
          references: { schema: 'public', table: 'category', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'productImage',
        foreignKey: {
          name: 'productImage_productId_fkey',
          columns: ['productId'],
          references: { schema: 'public', table: 'product', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'productImage',
        foreignKey: {
          name: 'productImage_uploadId_fkey',
          columns: ['uploadId'],
          references: { schema: 'public', table: 'uploadedAsset', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'uploadedAsset',
        foreignKey: {
          name: 'uploadedAsset_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      rawSql({
        id: 'catalog-v12-exact-legacy-backfill',
        label: 'Assign traceable legacy SKUs and backfill only exact representable cents',
        operationClass: 'data',
        target: { id: 'postgres', details: { objectType: 'table', schema: 'public', name: 'product' } },
        precheck: [{
          description: 'Legacy-derived SKU collisions must abort, not conflate rows',
          sql: `SELECT NOT EXISTS (SELECT 1 FROM public.product GROUP BY md5(id) HAVING count(*) > 1) AS result`,
        }],
        execute: [{
          description: 'Backfill without mutating Float or assigning categories; invalid amounts remain NULL',
          sql: `UPDATE public.product SET sku = 'LEGACY-' || md5(id) WHERE sku IS NULL;
UPDATE public.product SET "priceCents" = CASE
  WHEN price::text ~ '^[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
    AND price::text::numeric > 0
    AND price::text::numeric * 100 = trunc(price::text::numeric * 100)
    AND price::text::numeric * 100 <= 9007199254740991
  THEN (price::text::numeric * 100)::bigint ELSE NULL END;
UPDATE public."orderItem" SET "unitPriceCents" = CASE
  WHEN price::text ~ '^[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
    AND price::text::numeric > 0
    AND price::text::numeric * 100 = trunc(price::text::numeric * 100)
    AND price::text::numeric * 100 <= 9007199254740991
  THEN (price::text::numeric * 100)::bigint ELSE NULL END;
UPDATE public."order" SET "subtotalCents" = CASE
  WHEN total::text ~ '^[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
    AND total::text::numeric >= 0
    AND total::text::numeric * 100 = trunc(total::text::numeric * 100)
    AND total::text::numeric * 100 <= 9007199254740991
  THEN (total::text::numeric * 100)::bigint ELSE NULL END;`,
        }],
        postcheck: [{
          description: 'Every legacy product has its deterministic immutable SKU',
          sql: `SELECT NOT EXISTS (SELECT 1 FROM public.product WHERE sku IS DISTINCT FROM 'LEGACY-' || md5(id)) AS result`,
        }],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
