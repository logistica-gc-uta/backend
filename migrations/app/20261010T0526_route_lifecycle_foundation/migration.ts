#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/00d34ab56ae55b663a53148a126d233c0801ea6863ee0e3b22273a20d77d862e/contract';
import startContract from '../../snapshots/00d34ab56ae55b663a53148a126d233c0801ea6863ee0e3b22273a20d77d862e/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452/contract';
import endContract from '../../snapshots/46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452/contract.json' with { type: 'json' };
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
        table: 'deliveryAttempt',
        columns: [
          col('context', 'json', {
            notNull: true,
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('driverId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('failureReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('idempotencyKey', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('outcome', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('recordedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('requestPayload', 'json', {
            notNull: true,
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('stopId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'deliveryAttempt_failureReason_check_847d09ed',
            "\"failureReason\" IN ('RECIPIENT_ABSENT', 'RECIPIENT_REFUSED')",
          ),
          checkExpression(
            'deliveryAttempt_outcome_check_abbc2848',
            "\"outcome\" IN ('SUCCESSFUL', 'FAILED')",
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'driverReservation',
        columns: [
          col('driverId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('releasedAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('reservedAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('routeId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'legacyRouteReconciliation',
        columns: [
          col('administratorId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('evidence', 'json', {
            notNull: true,
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('id', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('reason', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('recordedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('releaseDriverHold', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('routeId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'orderClaim',
        columns: [
          col('claimedAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('orderId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('releasedAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('routeId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'routeStop',
        columns: [
          col('createdAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('isLegacy', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('orderId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('outcome', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('routeId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('sequence', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'routeStop_outcome_check_a6b9dae5',
            "\"outcome\" IN ('PENDING', 'SUCCESSFUL', 'FAILED')",
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'order',
        column: col('requiresAdministrativeReview', 'bool', {
          notNull: true,
          default: lit(false),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('completedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('completedById', 'text', {
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('returnedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('returnedById', 'text', {
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('startedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('startedById', 'text', {
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('status', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.dropNotNull({
        schema: 'public',
        table: 'route',
        column: 'driverId',
      }),
      this.addUnique({
        schema: 'public',
        table: 'deliveryAttempt',
        constraint: 'deliveryAttempt_stopId_idempotencyKey_key',
        columns: ['stopId', 'idempotencyKey'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'route',
        constraint: 'route_status_check_16cb52d8',
        expression:
          "\"status\" IN ('DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED')",
      }),
      this.addUnique({
        schema: 'public',
        table: 'routeStop',
        constraint: 'routeStop_routeId_orderId_key',
        columns: ['routeId', 'orderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'deliveryAttempt',
        index: 'deliveryAttempt_driverId_idx_8eed3317',
        columns: ['driverId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'deliveryAttempt',
        index: 'deliveryAttempt_stopId_idx_8804d4e7',
        columns: ['stopId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverReservation',
        index: 'active_driver_reservation_4f166943',
        columns: ['driverId'],
        extras: { where: '("releasedAt" IS NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverReservation',
        index: 'driverReservation_routeId_idx_91ae2fd6',
        columns: ['routeId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'legacyRouteReconciliation',
        index: 'legacyRouteReconciliation_administratorId_idx_8bd4a5de',
        columns: ['administratorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'legacyRouteReconciliation',
        index: 'legacyRouteReconciliation_routeId_idx_91ae2fd6',
        columns: ['routeId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderClaim',
        index: 'active_order_claim_d230b8a8',
        columns: ['orderId'],
        extras: { where: '("releasedAt" IS NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderClaim',
        index: 'orderClaim_routeId_idx_91ae2fd6',
        columns: ['routeId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'route',
        index: 'route_completedById_idx_47fde12d',
        columns: ['completedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'route',
        index: 'route_returnedById_idx_c7b1121b',
        columns: ['returnedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'route',
        index: 'route_startedById_idx_a8358300',
        columns: ['startedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeStop',
        index: 'routeStop_orderId_idx_d284871b',
        columns: ['orderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeStop',
        index: 'routeStop_routeId_idx_91ae2fd6',
        columns: ['routeId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeStop',
        index: 'verified_route_stop_sequence_6a9c128a',
        columns: ['routeId', 'sequence'],
        extras: {
          where: '(NOT "isLegacy" AND sequence IS NOT NULL)',
          unique: true,
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'deliveryAttempt',
        foreignKey: {
          name: 'deliveryAttempt_stopId_fkey',
          columns: ['stopId'],
          references: { schema: 'public', table: 'routeStop', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'deliveryAttempt',
        foreignKey: {
          name: 'deliveryAttempt_driverId_fkey',
          columns: ['driverId'],
          references: { schema: 'public', table: 'driver', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'driverReservation',
        foreignKey: {
          name: 'driverReservation_driverId_fkey',
          columns: ['driverId'],
          references: { schema: 'public', table: 'driver', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'driverReservation',
        foreignKey: {
          name: 'driverReservation_routeId_fkey',
          columns: ['routeId'],
          references: { schema: 'public', table: 'route', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'legacyRouteReconciliation',
        foreignKey: {
          name: 'legacyRouteReconciliation_routeId_fkey',
          columns: ['routeId'],
          references: { schema: 'public', table: 'route', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'legacyRouteReconciliation',
        foreignKey: {
          name: 'legacyRouteReconciliation_administratorId_fkey',
          columns: ['administratorId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderClaim',
        foreignKey: {
          name: 'orderClaim_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderClaim',
        foreignKey: {
          name: 'orderClaim_routeId_fkey',
          columns: ['routeId'],
          references: { schema: 'public', table: 'route', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'route',
        foreignKey: {
          name: 'route_completedById_fkey',
          columns: ['completedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'route',
        foreignKey: {
          name: 'route_returnedById_fkey',
          columns: ['returnedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'route',
        foreignKey: {
          name: 'route_startedById_fkey',
          columns: ['startedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeStop',
        foreignKey: {
          name: 'routeStop_routeId_fkey',
          columns: ['routeId'],
          references: { schema: 'public', table: 'route', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeStop',
        foreignKey: {
          name: 'routeStop_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      // Preserve known links and raw positions without asserting execution history.
      rawSql({
        id: 'backfill.legacy-route-stops',
        label: 'Preserve legacy route/order associations',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', name: 'routeStop' },
        },
        precheck: [
          {
            description: 'allow empty and populated legacy databases',
            sql: 'SELECT true AS result',
          },
        ],
        execute: [
          {
            description:
              'copy exact legacy associations without guessed order or times',
            sql: `INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, "isLegacy")
            SELECT 'legacy:' || o.id, o."routeId", o.id, o."stopOrder", true
            FROM public."order" o WHERE o."routeId" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public."routeStop" s WHERE s."routeId" = o."routeId" AND s."orderId" = o.id)`,
          },
        ],
        postcheck: [
          {
            description:
              'verify all original links and positions were retained as unverified',
            sql: `SELECT NOT EXISTS (SELECT 1 FROM public."order" o WHERE o."routeId" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public."routeStop" s WHERE s."routeId" = o."routeId" AND s."orderId" = o.id
            AND s.sequence IS NOT DISTINCT FROM o."stopOrder" AND s.outcome IS NULL AND s."isLegacy")) AS result`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
