#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/2ba9059120d3e914cfd40c2b6f0520d25b2c6e26c198e93389573d9c48b1cfda/contract';
import endContract from '../../snapshots/2ba9059120d3e914cfd40c2b6f0520d25b2c6e26c198e93389573d9c48b1cfda/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/973c66fbba6fd6fb7bc1926da46af1dd3efe74ca17073eb430209d58d890e95c/contract';
import startContract from '../../snapshots/973c66fbba6fd6fb7bc1926da46af1dd3efe74ca17073eb430209d58d890e95c/contract.json' with { type: 'json' };
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
        table: 'driverStatusChange',
        columns: [
          col('active', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('actorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('driverId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'driver_status_change_reason_valid_6143bd85',
            '"reason" IS NULL OR length(trim("reason")) BETWEEN 1 AND 500',
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'driver',
        column: col('isActive', 'bool', {
          notNull: true,
          default: lit(true),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'driver',
        column: col('statusChangedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'driver',
        column: col('statusChangedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'driver',
        column: col('statusReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'driver',
        constraint: 'driver_inactive_has_actor_8cb6c091',
        expression:
          '"isActive" OR ("statusChangedAt" IS NOT NULL AND "statusChangedById" IS NOT NULL)',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'driver',
        constraint: 'driver_status_reason_valid_c6087cd6',
        expression: '"statusReason" IS NULL OR length(trim("statusReason")) BETWEEN 1 AND 500',
      }),
      this.createIndex({
        schema: 'public',
        table: 'driver',
        index: 'driver_statusChangedById_idx_e761b954',
        columns: ['statusChangedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverStatusChange',
        index: 'driverStatusChange_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverStatusChange',
        index: 'driverStatusChange_driverId_createdAt_idx_adf85faa',
        columns: ['driverId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverStatusChange',
        index: 'driverStatusChange_driverId_idx_8eed3317',
        columns: ['driverId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'driver',
        foreignKey: {
          name: 'driver_statusChangedById_fkey',
          columns: ['statusChangedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'driverStatusChange',
        foreignKey: {
          name: 'driverStatusChange_driverId_fkey',
          columns: ['driverId'],
          references: { schema: 'public', table: 'driver', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'driverStatusChange',
        foreignKey: {
          name: 'driverStatusChange_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      rawSql({
        id: 'driver.active-status-guards',
        label: 'Guard the driver status history and reject new reservations for an inactive driver (#82)',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { objectType: 'table', schema: 'public', name: 'driver' },
        },
        precheck: [
          {
            description: 'driver, driverReservation and route tables exist',
            sql: `SELECT to_regclass('public.driver') IS NOT NULL AND to_regclass('public."driverReservation"') IS NOT NULL AND to_regclass('public.route') IS NOT NULL AS result`,
          },
        ],
        execute: [
          {
            description: 'the status history is append-only',
            sql: `CREATE OR REPLACE FUNCTION public.driver_status_change_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Driver status history is append-only' USING ERRCODE = '23514';
END $$`,
          },
          {
            description: 'install the append-only trigger',
            sql: `DROP TRIGGER IF EXISTS driver_status_change_immutable ON public."driverStatusChange"`,
          },
          {
            description: 'install the append-only trigger',
            sql: `CREATE TRIGGER driver_status_change_immutable BEFORE UPDATE OR DELETE ON public."driverStatusChange"
FOR EACH ROW EXECUTE FUNCTION public.driver_status_change_immutable()`,
          },
          {
            description:
              'a new reservation or route assignment requires an active driver; FOR SHARE serializes against a concurrent deactivation, which updates the same row and waits for this transaction',
            sql: `CREATE OR REPLACE FUNCTION public.driver_requires_active_for_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  driver_id text;
  driver_active boolean;
BEGIN
  IF TG_TABLE_NAME = 'driverReservation' THEN
    IF NEW."releasedAt" IS NOT NULL THEN RETURN NEW; END IF;
    driver_id := NEW."driverId";
  ELSE
    IF NEW."driverId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."driverId" IS NOT DISTINCT FROM OLD."driverId") THEN RETURN NEW; END IF;
    driver_id := NEW."driverId";
  END IF;
  SELECT "isActive" INTO driver_active FROM public.driver WHERE id = driver_id FOR SHARE;
  IF NOT FOUND OR NOT driver_active THEN
    RAISE EXCEPTION 'An inactive driver cannot receive a new assignment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$`,
          },
          {
            description: 'reservation guard trigger',
            sql: `DROP TRIGGER IF EXISTS driver_reservation_requires_active_driver ON public."driverReservation"`,
          },
          {
            description: 'reservation guard trigger',
            sql: `CREATE TRIGGER driver_reservation_requires_active_driver BEFORE INSERT ON public."driverReservation"
FOR EACH ROW EXECUTE FUNCTION public.driver_requires_active_for_assignment()`,
          },
          {
            description: 'route assignment guard trigger',
            sql: `DROP TRIGGER IF EXISTS route_requires_active_driver ON public.route`,
          },
          {
            description: 'route assignment guard trigger',
            sql: `CREATE TRIGGER route_requires_active_driver BEFORE INSERT OR UPDATE OF "driverId" ON public.route
FOR EACH ROW EXECUTE FUNCTION public.driver_requires_active_for_assignment()`,
          },
        ],
        postcheck: [
          {
            description: 'the three guard triggers are installed and enabled',
            sql: `SELECT (
              EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='driver_status_change_immutable' AND tgenabled='O' AND tgrelid='public."driverStatusChange"'::regclass)
              AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='driver_reservation_requires_active_driver' AND tgenabled='O' AND tgrelid='public."driverReservation"'::regclass)
              AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='route_requires_active_driver' AND tgenabled='O' AND tgrelid='public.route'::regclass)
            ) AS result`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
