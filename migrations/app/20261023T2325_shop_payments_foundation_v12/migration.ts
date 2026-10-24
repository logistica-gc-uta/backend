#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/70a695f73c329e3d06c6ee0a3d8b301de993c376613442e431adde1392ca8710/contract';
import endContract from '../../snapshots/70a695f73c329e3d06c6ee0a3d8b301de993c376613442e431adde1392ca8710/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d2724cd80d3f574f0e1fb083c0426dab7b696331f1ca7b50fb62a3473125576e/contract';
import startContract from '../../snapshots/d2724cd80d3f574f0e1fb083c0426dab7b696331f1ca7b50fb62a3473125576e/contract.json' with { type: 'json' };
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
        table: 'checkoutAttempt',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('errorCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('errorDetails', 'json', { codecRef: { codecId: 'pg/json@1' } }),
          col('errorMessage', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('idempotencyKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('paymentAttemptId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
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
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'checkout_attempt_status_consistency_c207fec0',
            'status IN (\'PROCESSING\', \'SUCCEEDED\', \'REJECTED\', \'FAILED\') AND length("idempotencyKey") BETWEEN 1 AND 128 AND length("requestHash") BETWEEN 1 AND 128 AND ((status = \'PROCESSING\' AND "orderId" IS NULL AND "receiptId" IS NULL AND "paymentAttemptId" IS NULL AND "errorCode" IS NULL AND "errorMessage" IS NULL AND "errorDetails" IS NULL AND "successSnapshot" IS NULL) OR (status = \'SUCCEEDED\' AND "orderId" IS NOT NULL AND "receiptId" IS NOT NULL AND "paymentAttemptId" IS NOT NULL AND "errorCode" IS NULL AND "errorMessage" IS NULL AND "errorDetails" IS NULL AND "successSnapshot" IS NOT NULL AND json_typeof("successSnapshot") = \'object\') OR (status IN (\'REJECTED\', \'FAILED\') AND "errorCode" IS NOT NULL AND length("errorCode") BETWEEN 1 AND 64 AND "orderId" IS NULL AND "receiptId" IS NULL AND "paymentAttemptId" IS NULL AND "successSnapshot" IS NULL))',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'paymentAttempt',
        columns: [
          col('amountCents', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('buyerId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('cardFixtureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('cardLast4', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
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
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reference', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('shippingAmountCents', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('APPROVED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('subtotalCents', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('taxAmountCents', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('taxEnabled', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('taxRateBps', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('totalCents', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'payment_attempt_valid_f05855ef',
            'status = \'APPROVED\' AND currency = \'USD\' AND "shippingAmountCents" = 0 AND "taxRateBps" BETWEEN 0 AND 10000 AND "subtotalCents" >= 0 AND "subtotalCents" <= 9007199254740991 AND "taxAmountCents" >= 0 AND "taxAmountCents" <= 9007199254740991 AND "totalCents" >= 0 AND "totalCents" <= 9007199254740991 AND "amountCents" >= 0 AND "amountCents" <= 9007199254740991 AND "totalCents" = "subtotalCents" + "taxAmountCents" AND "amountCents" = "totalCents" AND ((NOT "taxEnabled" AND "taxAmountCents" = 0) OR "taxEnabled") AND "cardLast4" ~ \'^[0-9]{4}$\' AND length(reference) BETWEEN 1 AND 64',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'purchaseReceipt',
        columns: [
          col('buyerId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('commercialOrderNumber', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
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
          col('disclaimer', 'text', {
            notNull: true,
            default: lit('COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('issuedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('merchantName', 'text', {
            notNull: true,
            default: lit('REGALÍA'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('number', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('shippingAmountCents', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('shippingStatus', 'text', {
            notNull: true,
            default: lit('FREE_INCLUDED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('snapshot', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('subtotalCents', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('taxAmountCents', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('taxEnabled', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('taxMode', 'text', {
            notNull: true,
            default: lit('SIMULATED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('taxRateBps', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('totalCents', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'purchase_receipt_valid_f8f867fb',
            'currency = \'USD\' AND "shippingStatus" = \'FREE_INCLUDED\' AND "shippingAmountCents" = 0 AND "taxMode" = \'SIMULATED\' AND "taxRateBps" BETWEEN 0 AND 10000 AND "subtotalCents" >= 0 AND "subtotalCents" <= 9007199254740991 AND "taxAmountCents" >= 0 AND "taxAmountCents" <= 9007199254740991 AND "totalCents" >= 0 AND "totalCents" <= 9007199254740991 AND "totalCents" = "subtotalCents" + "taxAmountCents" AND ((NOT "taxEnabled" AND "taxAmountCents" = 0) OR "taxEnabled") AND length(number) BETWEEN 1 AND 64 AND length("commercialOrderNumber") BETWEEN 1 AND 64 AND "merchantName" = \'REGALÍA\' AND disclaimer = \'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA\'',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'simulatedCard',
        columns: [
          col('active', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('balanceCents', 'int8', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/int8@1' },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('fixtureId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('last4', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'simulated_card_valid_9eb17fd5',
            '"balanceCents" >= 0 AND "balanceCents" <= 9007199254740991 AND "last4" ~ \'^[0-9]{4}$\' AND length("fixtureId") BETWEEN 1 AND 64',
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'checkoutAttempt',
        constraint: 'checkoutAttempt_userId_idempotencyKey_key',
        columns: ['userId', 'idempotencyKey'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'paymentAttempt',
        constraint: 'paymentAttempt_orderId_key',
        columns: ['orderId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'paymentAttempt',
        constraint: 'paymentAttempt_reference_key',
        columns: ['reference'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'purchaseReceipt',
        constraint: 'purchaseReceipt_orderId_key',
        columns: ['orderId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'purchaseReceipt',
        constraint: 'purchaseReceipt_number_key',
        columns: ['number'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'purchaseReceipt',
        constraint: 'purchaseReceipt_commercialOrderNumber_key',
        columns: ['commercialOrderNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'simulatedCard',
        constraint: 'simulatedCard_fixtureId_key',
        columns: ['fixtureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'checkoutAttempt',
        index: 'checkoutAttempt_orderId_idx_d284871b',
        columns: ['orderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'checkoutAttempt',
        index: 'checkoutAttempt_paymentAttemptId_idx_e668f17f',
        columns: ['paymentAttemptId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'checkoutAttempt',
        index: 'checkoutAttempt_receiptId_idx_9b8e07be',
        columns: ['receiptId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'checkoutAttempt',
        index: 'checkoutAttempt_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'paymentAttempt',
        index: 'paymentAttempt_buyerId_idx_80be0de9',
        columns: ['buyerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'paymentAttempt',
        index: 'paymentAttempt_cardFixtureId_idx_d02511e9',
        columns: ['cardFixtureId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'purchaseReceipt',
        index: 'purchaseReceipt_buyerId_idx_80be0de9',
        columns: ['buyerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'purchaseReceipt',
        index: 'purchaseReceipt_issuedAt_idx_a299a849',
        columns: ['issuedAt'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'checkoutAttempt',
        foreignKey: {
          name: 'checkoutAttempt_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'checkoutAttempt',
        foreignKey: {
          name: 'checkoutAttempt_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'checkoutAttempt',
        foreignKey: {
          name: 'checkoutAttempt_receiptId_fkey',
          columns: ['receiptId'],
          references: { schema: 'public', table: 'purchaseReceipt', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'checkoutAttempt',
        foreignKey: {
          name: 'checkoutAttempt_paymentAttemptId_fkey',
          columns: ['paymentAttemptId'],
          references: { schema: 'public', table: 'paymentAttempt', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'paymentAttempt',
        foreignKey: {
          name: 'paymentAttempt_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'paymentAttempt',
        foreignKey: {
          name: 'paymentAttempt_buyerId_fkey',
          columns: ['buyerId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'paymentAttempt',
        foreignKey: {
          name: 'paymentAttempt_cardFixtureId_fkey',
          columns: ['cardFixtureId'],
          references: { schema: 'public', table: 'simulatedCard', columns: ['fixtureId'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'purchaseReceipt',
        foreignKey: {
          name: 'purchaseReceipt_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'purchaseReceipt',
        foreignKey: {
          name: 'purchaseReceipt_buyerId_fkey',
          columns: ['buyerId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
