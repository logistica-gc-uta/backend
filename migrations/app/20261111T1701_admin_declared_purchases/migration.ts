#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/5e11bbaf1302fbf1e4e29d9e035846311bccdefcfac729378b0e54068f139b98/contract';
import startContract from '../../snapshots/5e11bbaf1302fbf1e4e29d9e035846311bccdefcfac729378b0e54068f139b98/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d0d70e575dc12d82fbeab635c30dcd5aa849f52f9bccb3251a8e414bdd715ba8/contract';
import endContract from '../../snapshots/d0d70e575dc12d82fbeab635c30dcd5aa849f52f9bccb3251a8e414bdd715ba8/contract.json' with { type: 'json' };
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
        table: 'adminPurchaseAttempt',
        columns: [
          col('actorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('declarationId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('errorCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('errorDetails', 'json', { codecRef: { codecId: 'pg/json@1' } }),
          col('errorMessage', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('idempotencyKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('receiptId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('requestHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('PROCESSING'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('successSnapshot', 'json', { codecRef: { codecId: 'pg/json@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'admin_purchase_attempt_status_consistency_9872e924',
            'status IN (\'PROCESSING\', \'SUCCEEDED\', \'REJECTED\', \'FAILED\') AND length("idempotencyKey") BETWEEN 1 AND 128 AND length("requestHash") BETWEEN 1 AND 128 AND ((status = \'PROCESSING\' AND "orderId" IS NULL AND "receiptId" IS NULL AND "declarationId" IS NULL AND "errorCode" IS NULL AND "errorMessage" IS NULL AND "errorDetails" IS NULL AND "successSnapshot" IS NULL) OR (status = \'SUCCEEDED\' AND "orderId" IS NOT NULL AND "receiptId" IS NOT NULL AND "declarationId" IS NOT NULL AND "errorCode" IS NULL AND "errorMessage" IS NULL AND "errorDetails" IS NULL AND "successSnapshot" IS NOT NULL AND json_typeof("successSnapshot") = \'object\') OR (status IN (\'REJECTED\', \'FAILED\') AND "errorCode" IS NOT NULL AND length("errorCode") BETWEEN 1 AND 64 AND "orderId" IS NULL AND "receiptId" IS NULL AND "declarationId" IS NULL AND "successSnapshot" IS NULL))',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'externalPaymentDeclaration',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('declaredAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('declaredById', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('method', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'externalPaymentDeclaration_method_check_5587eb50',
            "\"method\" IN ('CASH', 'TRANSFER')",
          ),
          checkExpression(
            'external_payment_declaration_note_valid_9e947d08',
            '"note" IS NULL OR (length("note") BETWEEN 1 AND 200 AND "note" ~ \'[^[:space:]]\')',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'orderContactAudit',
        columns: [
          col('actorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('field', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('nextValue', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('previousValue', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'order_contact_audit_field_valid_c8d4a6a6',
            "\"field\" IN ('buyerName', 'buyerPhone', 'recipientName', 'recipientPhone')",
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('buyerName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('buyerPhone', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('contactRevision', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.dropNotNull({ schema: 'public', table: 'purchaseReceipt', column: 'buyerId' }),
      this.addUnique({
        schema: 'public',
        table: 'adminPurchaseAttempt',
        constraint: 'adminPurchaseAttempt_actorId_idempotencyKey_key',
        columns: ['actorId', 'idempotencyKey'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'externalPaymentDeclaration',
        constraint: 'externalPaymentDeclaration_orderId_key',
        columns: ['orderId'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'order',
        constraint: 'order_buyer_name_valid_b2bb714c',
        expression:
          '"buyerName" IS NULL OR ("buyerName" ~ \'[^[:space:]]\' AND length("buyerName") BETWEEN 1 AND 120)',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'order',
        constraint: 'order_buyer_phone_valid_19141dd8',
        expression:
          '"buyerPhone" IS NULL OR ("buyerPhone" ~ \'[^[:space:]]\' AND length("buyerPhone") BETWEEN 1 AND 40)',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'order',
        constraint: 'order_contact_revision_nonnegative_6e7938df',
        expression: '"contactRevision" >= 0',
      }),
      this.createIndex({
        schema: 'public',
        table: 'adminPurchaseAttempt',
        index: 'adminPurchaseAttempt_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'adminPurchaseAttempt',
        index: 'adminPurchaseAttempt_declarationId_idx_2758bd12',
        columns: ['declarationId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'adminPurchaseAttempt',
        index: 'adminPurchaseAttempt_orderId_idx_d284871b',
        columns: ['orderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'adminPurchaseAttempt',
        index: 'adminPurchaseAttempt_receiptId_idx_9b8e07be',
        columns: ['receiptId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'externalPaymentDeclaration',
        index: 'externalPaymentDeclaration_declaredById_idx_dd0c7dda',
        columns: ['declaredById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderContactAudit',
        index: 'orderContactAudit_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderContactAudit',
        index: 'orderContactAudit_orderId_createdAt_idx_cf5e070a',
        columns: ['orderId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderContactAudit',
        index: 'orderContactAudit_orderId_idx_d284871b',
        columns: ['orderId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'adminPurchaseAttempt',
        foreignKey: {
          name: 'adminPurchaseAttempt_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'adminPurchaseAttempt',
        foreignKey: {
          name: 'adminPurchaseAttempt_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'adminPurchaseAttempt',
        foreignKey: {
          name: 'adminPurchaseAttempt_receiptId_fkey',
          columns: ['receiptId'],
          references: { schema: 'public', table: 'purchaseReceipt', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'adminPurchaseAttempt',
        foreignKey: {
          name: 'adminPurchaseAttempt_declarationId_fkey',
          columns: ['declarationId'],
          references: { schema: 'public', table: 'externalPaymentDeclaration', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'externalPaymentDeclaration',
        foreignKey: {
          name: 'externalPaymentDeclaration_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'externalPaymentDeclaration',
        foreignKey: {
          name: 'externalPaymentDeclaration_declaredById_fkey',
          columns: ['declaredById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderContactAudit',
        foreignKey: {
          name: 'orderContactAudit_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderContactAudit',
        foreignKey: {
          name: 'orderContactAudit_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      rawSql({
        id: 'admin-purchase.integrity-guards',
        label: 'Enforce guest receipt ownership, payment XOR, and append-only contact audit',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { objectType: 'table', schema: 'public', name: 'purchaseReceipt' },
        },
        precheck: [
          {
            description: 'purchaseReceipt table exists',
            sql: 'SELECT EXISTS (SELECT 1 AS "one" FROM "information_schema"."tables" WHERE ("table_schema" = $1 AND "table_name" = $2)) AS "result"',
            params: ['public', 'purchaseReceipt'],
          },
        ],
        execute: [
          {
            description: 'receipt buyerId matches order.userId including both-null guests',
            sql: `
CREATE OR REPLACE FUNCTION public.admin_purchase_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  owner_id text;
  has_declaration boolean;
  has_card boolean;
BEGIN
  SELECT o."userId" INTO owner_id FROM public."order" o WHERE o.id = NEW."orderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt order does not exist' USING ERRCODE = '23514';
  END IF;
  IF NEW."buyerId" IS DISTINCT FROM owner_id THEN
    RAISE EXCEPTION 'Receipt buyerId must match order.userId' USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS(SELECT 1 FROM public."externalPaymentDeclaration" d WHERE d."orderId" = NEW."orderId") INTO has_declaration;
  SELECT EXISTS(SELECT 1 FROM public."paymentAttempt" p WHERE p."orderId" = NEW."orderId") INTO has_card;
  IF has_declaration AND has_card THEN
    RAISE EXCEPTION 'Order cannot have both declared external payment and simulated card payment' USING ERRCODE = '23514';
  END IF;
  IF NEW."buyerId" IS NULL AND NOT has_declaration THEN
    RAISE EXCEPTION 'Guest receipt requires an external payment declaration' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS admin_purchase_receipt_guard ON public."purchaseReceipt";
CREATE TRIGGER admin_purchase_receipt_guard
  BEFORE INSERT OR UPDATE ON public."purchaseReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.admin_purchase_receipt_guard();
`,
          },
          {
            description: 'declaration cannot coexist with simulated card payment',
            sql: `
CREATE OR REPLACE FUNCTION public.admin_purchase_declaration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public."paymentAttempt" p WHERE p."orderId" = NEW."orderId") THEN
    RAISE EXCEPTION 'Order cannot have both declared external payment and simulated card payment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS admin_purchase_declaration_guard ON public."externalPaymentDeclaration";
CREATE TRIGGER admin_purchase_declaration_guard
  BEFORE INSERT OR UPDATE ON public."externalPaymentDeclaration"
  FOR EACH ROW EXECUTE FUNCTION public.admin_purchase_declaration_guard();
`,
          },
          {
            description: 'simulated card payment cannot coexist with a declared external payment',
            sql: `
CREATE OR REPLACE FUNCTION public.admin_purchase_payment_xor_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public."externalPaymentDeclaration" d WHERE d."orderId" = NEW."orderId") THEN
    RAISE EXCEPTION 'Order cannot have both declared external payment and simulated card payment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS admin_purchase_payment_xor_guard ON public."paymentAttempt";
CREATE TRIGGER admin_purchase_payment_xor_guard
  BEFORE INSERT OR UPDATE ON public."paymentAttempt"
  FOR EACH ROW EXECUTE FUNCTION public.admin_purchase_payment_xor_guard();
`,
          },
          {
            description: 'contact audit rows cannot be rewritten or deleted',
            sql: `
CREATE OR REPLACE FUNCTION public.order_contact_audit_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Order contact audit is append-only' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS order_contact_audit_append_only ON public."orderContactAudit";
CREATE TRIGGER order_contact_audit_append_only
  BEFORE UPDATE OR DELETE ON public."orderContactAudit"
          FOR EACH ROW EXECUTE FUNCTION public.order_contact_audit_append_only();
`,
          },
        ],
        postcheck: [
          {
            description: 'receipt guard is installed',
            sql: "SELECT to_regprocedure('public.admin_purchase_receipt_guard()') IS NOT NULL AS \"result\"",
          },
          {
            description: 'declaration guard is installed',
            sql: "SELECT to_regprocedure('public.admin_purchase_declaration_guard()') IS NOT NULL AS \"result\"",
          },
          {
            description: 'payment XOR guard is installed',
            sql: "SELECT to_regprocedure('public.admin_purchase_payment_xor_guard()') IS NOT NULL AS \"result\"",
          },
          {
            description: 'contact audit append-only guard is installed',
            sql: "SELECT to_regprocedure('public.order_contact_audit_append_only()') IS NOT NULL AS \"result\"",
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
