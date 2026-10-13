#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/b16467870b997eae482ffea8ef54bb526ddf4a16a3c587c2fc02a9db06d962c2/contract';
import endContract from '../../snapshots/b16467870b997eae482ffea8ef54bb526ddf4a16a3c587c2fc02a9db06d962c2/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e357d1aa2fdc74464e729ec7cd8bb087b979a13b22e0f88aa005b60be4c16427/contract';
import startContract from '../../snapshots/e357d1aa2fdc74464e729ec7cd8bb087b979a13b22e0f88aa005b60be4c16427/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  rawSql,
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
        table: 'dispatchIntervention',
        columns: [
          col('action', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('actorId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('orderId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('outcome', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('payload', 'json', {
            notNull: true,
            codecRef: { codecId: 'pg/json@1' },
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
          col('requestId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('result', 'json', {
            notNull: true,
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('routeId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'dispatch_audit_valid_f083b472',
            "action IN ('CONFIRM', 'REJECT', 'REORDER', 'MOVE', 'REASSIGN_DRIVER', 'PRIORITIZE', 'CONTACT', 'RESCHEDULE') AND outcome IN ('APPLIED', 'REJECTED', 'FAILED') AND length(trim(reason)) BETWEEN 1 AND 500",
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatchIntervention_requestId_key',
        columns: ['requestId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'dispatchIntervention',
        index: 'dispatchIntervention_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'dispatchIntervention',
        index: 'dispatchIntervention_orderId_idx_d284871b',
        columns: ['orderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'dispatchIntervention',
        index: 'dispatchIntervention_routeId_idx_91ae2fd6',
        columns: ['routeId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'dispatchIntervention',
        foreignKey: {
          name: 'dispatchIntervention_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'dispatchIntervention',
        foreignKey: {
          name: 'dispatchIntervention_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'dispatchIntervention',
        foreignKey: {
          name: 'dispatchIntervention_routeId_fkey',
          columns: ['routeId'],
          references: { schema: 'public', table: 'route', columns: ['id'] },
        },
      }),
      rawSql({
        id: 'dispatch.audit-and-prestart-release',
        label:
          'Append-only ADMIN audit and narrowly audited pre-start releases',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: {
            objectType: 'table',
            schema: 'public',
            name: 'dispatchIntervention',
          },
        },
        precheck: [
          {
            description: 'require existing coherence guards',
            sql: "SELECT to_regprocedure('public.t1e_claim_history_guard()') IS NOT NULL AND to_regprocedure('public.dispatch_audit_actor_guard()') IS NULL AS result",
          },
        ],
        execute: [
          {
            description:
              'install audit guards and preserve frozen-route release rules',
            sql: `CREATE FUNCTION public.dispatch_audit_actor_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE actor_role text;
BEGIN
  SELECT role::text INTO actor_role FROM public."user" WHERE id = NEW."actorId" FOR SHARE;
  IF actor_role IS DISTINCT FROM 'ADMIN' OR NEW."recordedAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'Current ADMIN and valid instant required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_audit_actor BEFORE INSERT ON public."dispatchIntervention" FOR EACH ROW EXECUTE FUNCTION public.dispatch_audit_actor_guard();
CREATE TRIGGER dispatch_audit_append_only BEFORE UPDATE OR DELETE ON public."dispatchIntervention" FOR EACH ROW EXECUTE FUNCTION public.route_history_append_only();
CREATE TRIGGER dispatch_audit_no_truncate BEFORE TRUNCATE ON public."dispatchIntervention" FOR EACH STATEMENT EXECUTE FUNCTION public.route_history_append_only();
CREATE OR REPLACE FUNCTION public.t1e_claim_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  route_status text;
  completed_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Order claim history is immutable and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW."routeId" IS DISTINCT FROM OLD."routeId" OR
     NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
     NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt" THEN
    RAISE EXCEPTION 'Order claim identity and claim time are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" THEN
    RAISE EXCEPTION 'Released order claim history is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."releasedAt" IS NULL AND NEW."releasedAt" IS NOT NULL THEN
    SELECT status::text, "completedAt" INTO route_status, completed_at
    FROM public.route WHERE id = OLD."routeId";
    IF route_status = 'COMPLETED' AND completed_at = NEW."releasedAt" THEN
      RETURN NEW;
    END IF;
    IF route_status = 'DRAFT' AND NOT EXISTS (
      SELECT 1 FROM public."routeStop" s
      WHERE s."routeId" = OLD."routeId" AND s."orderId" = OLD."orderId"
    ) THEN
      RETURN NEW;
    END IF;
    IF route_status = 'ASSIGNED' AND NOT EXISTS (
      SELECT 1 FROM public."routeStop" WHERE "routeId" = OLD."routeId" AND "orderId" = OLD."orderId"
    ) AND EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      WHERE a.action = 'MOVE' AND a.outcome = 'APPLIED' AND a."orderId" = OLD."orderId"
        AND a.payload::jsonb ->> 'routeId' = OLD."routeId"
        AND a.xmin = pg_current_xact_id()::text::xid
    ) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Order claim may be released only at valid completion or pre-start draft stop removal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t1e_reservation_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  route_status text;
  returned_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Driver reservation history is immutable and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW."routeId" IS DISTINCT FROM OLD."routeId" OR
     NEW."driverId" IS DISTINCT FROM OLD."driverId" OR
     NEW."reservedAt" IS DISTINCT FROM OLD."reservedAt" THEN
    RAISE EXCEPTION 'Driver reservation identity and reserve time are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" THEN
    RAISE EXCEPTION 'Released driver reservation history is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."releasedAt" IS NULL AND NEW."releasedAt" IS NOT NULL THEN
    SELECT status::text, "returnedAt" INTO route_status, returned_at
    FROM public.route WHERE id = OLD."routeId";
    IF route_status = 'COMPLETED' AND returned_at = NEW."releasedAt" THEN
      RETURN NEW;
    END IF;
    IF route_status IS NULL THEN
      RETURN NEW;
    END IF;
    IF route_status = 'ASSIGNED' AND EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a JOIN public.route r ON r.id = a."routeId"
      WHERE a.action = 'REASSIGN_DRIVER' AND a.outcome = 'APPLIED' AND a."routeId" = OLD."routeId"
        AND a.payload::jsonb ->> 'driverId' = r."driverId" AND r."driverId" <> OLD."driverId"
        AND a.xmin = pg_current_xact_id()::text::xid
    ) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Verified driver reservation may be released only at physical return'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

`,
          },
        ],
        postcheck: [
          {
            description: 'three audit guards enabled',
            sql: "SELECT COUNT(*) = 3 AS result FROM pg_trigger WHERE tgenabled = 'O' AND tgname IN ('dispatch_audit_actor', 'dispatch_audit_append_only', 'dispatch_audit_no_truncate')",
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
