#!/usr/bin/env -S node
import type {
  Contract as End,
  Contract as Start,
} from '../../snapshots/b16467870b997eae482ffea8ef54bb526ddf4a16a3c587c2fc02a9db06d962c2/contract';
import endContract from '../../snapshots/b16467870b997eae482ffea8ef54bb526ddf4a16a3c587c2fc02a9db06d962c2/contract.json' with { type: 'json' };
import startContract from '../../snapshots/b16467870b997eae482ffea8ef54bb526ddf4a16a3c587c2fc02a9db06d962c2/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  rawSql,
} from '@prisma/orm-postgres/migration';

import postgres from '@prisma/orm-postgres/runtime';
const invariantDb = postgres<End>({ contractJson: endContract });
// Validate existing failure holds; never fabricate agreements or rewrite history.
const unresolvedFailures = () =>
  invariantDb.raw.sql`SELECT o.id FROM public."order" o
  JOIN public."routeStop" st ON st."orderId" = o.id
  JOIN public."deliveryAttempt" d ON d."stopId" = st.id AND d.outcome = 'FAILED'
  WHERE NOT o."requiresAdministrativeReview" AND NOT EXISTS (
    SELECT 1 FROM public."dispatchIntervention" a WHERE a.action = 'RESCHEDULE' AND a.outcome = 'APPLIED'
      AND a."orderId" = o.id AND a.result::jsonb ->> 'attemptId' = d.id
  ) LIMIT 1`
    .returnsRow({ id: 'pg/text@1' })
    .build();

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({
        id: 'dispatch.agreed-rescheduling-guards',
        label:
          'Authorize explicit failed-order resolution without rewriting visit history',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { objectType: 'table', schema: 'public', name: 'order' },
        },
        precheck: [
          {
            description: 'require audit foundation and no duplicate guard',
            sql: "SELECT to_regprocedure('public.dispatch_audit_actor_guard()') IS NOT NULL AND to_regprocedure('public.dispatch_review_resolution_guard()') IS NULL AS result",
          },
        ],
        execute: [
          {
            description:
              'install agreement resolution and retain historical failures',
            sql: `CREATE OR REPLACE FUNCTION public.t1e_claim_history_guard() RETURNS trigger
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
      WHERE a.action IN ('MOVE', 'RESCHEDULE') AND a.outcome = 'APPLIED' AND a."orderId" = OLD."orderId"
        AND (a.payload::jsonb ->> 'routeId' = OLD."routeId" OR (a.action = 'RESCHEDULE' AND a."routeId" = OLD."routeId"))
        AND a.xmin = pg_current_xact_id()::text::xid
    ) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Order claim may be released only at valid completion or pre-start draft stop removal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t1e_validate_stop_visit(p_stop_id text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  stop_row public."routeStop"%ROWTYPE;
  route_row public.route%ROWTYPE;
  order_row public."order"%ROWTYPE;
  attempt_count bigint;
BEGIN
  SELECT * INTO stop_row FROM public."routeStop" WHERE id = p_stop_id;
  IF NOT FOUND OR stop_row."isLegacy" OR stop_row.sequence IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO route_row FROM public.route WHERE id = stop_row."routeId";
  IF NOT FOUND OR route_row.status IS NULL OR route_row.status = 'DRAFT' THEN
    IF EXISTS (SELECT 1 FROM public."deliveryAttempt" WHERE "stopId" = p_stop_id) THEN
      RAISE EXCEPTION 'DRAFT or legacy stop cannot have a recorded visit attempt'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO order_row FROM public."order" WHERE id = stop_row."orderId";
  SELECT COUNT(*) INTO attempt_count
  FROM public."deliveryAttempt" WHERE "stopId" = p_stop_id;

  IF stop_row.outcome IS NULL OR stop_row.outcome = 'PENDING' THEN
    IF attempt_count <> 0 THEN
      RAISE EXCEPTION 'Pending stop cannot retain a completed visit attempt'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  IF route_row.status NOT IN ('IN_PROGRESS', 'COMPLETED') OR
     route_row."startedAt" IS NULL OR route_row."driverId" IS NULL OR
     attempt_count = 0 THEN
    RAISE EXCEPTION 'Resolved verified stop requires a visit attempt on its active route'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."deliveryAttempt" a
    WHERE a."stopId" = p_stop_id
      AND (a.outcome <> stop_row.outcome
        OR a."driverId" <> route_row."driverId"
        OR a."recordedAt" < route_row."startedAt"
        OR (route_row."completedAt" IS NOT NULL
          AND a."recordedAt" > route_row."completedAt"))
  ) THEN
    RAISE EXCEPTION 'Visit attempt must match the immutable stop outcome, route owner, and lifecycle time'
      USING ERRCODE = '23514';
  END IF;
  IF stop_row.outcome = 'FAILED' AND NOT order_row."requiresAdministrativeReview" AND NOT EXISTS (
    SELECT 1 FROM public."dispatchIntervention" a JOIN public."deliveryAttempt" d
      ON d.id = a.result::jsonb ->> 'attemptId'
    WHERE a.action = 'RESCHEDULE' AND a.outcome = 'APPLIED' AND a."orderId" = stop_row."orderId"
      AND d."stopId" = stop_row.id AND d.outcome = 'FAILED' AND route_row.status = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'Failed visit requires current administrative review flag'
      USING ERRCODE = '23514';
  END IF;
END $$;


CREATE FUNCTION public.dispatch_review_resolution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."requiresAdministrativeReview" AND (
    NOT NEW."requiresAdministrativeReview" OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('DELIVERED','CANCELLED','PENDING')) OR
    (NEW."scheduledDeliveryDate", NEW."deliveryWindowStart", NEW."deliveryWindowEnd", NEW."routeId")
    IS DISTINCT FROM (OLD."scheduledDeliveryDate", OLD."deliveryWindowStart", OLD."deliveryWindowEnd", OLD."routeId")
  ) AND NOT EXISTS (
    SELECT 1 FROM public."dispatchIntervention" a
    JOIN public."dispatchIntervention" c ON c.id = a.payload::jsonb ->> 'agreementId'
    JOIN public."deliveryAttempt" d ON d.id = c.payload::jsonb ->> 'attemptId'
    JOIN public."routeStop" st ON st.id = d."stopId"
    JOIN public.route r ON r.id = st."routeId"
    WHERE a.action = 'RESCHEDULE' AND a.outcome = 'APPLIED' AND a."orderId" = OLD.id
      AND a.xmin = pg_current_xact_id()::text::xid
      AND c.action = 'CONTACT' AND c.outcome = 'APPLIED' AND c."orderId" = OLD.id
      AND c.payload::jsonb -> 'agreementConfirmed' = 'true'::jsonb
      AND st."orderId" = OLD.id AND d.outcome = 'FAILED' AND r.status = 'COMPLETED'
      AND NEW.status = 'PENDING' AND NOT NEW."requiresAdministrativeReview" AND NEW."routeId" IS NULL AND NEW."stopOrder" IS NULL
      AND NEW."scheduledDeliveryDate" = (c.payload::jsonb ->> 'scheduledDeliveryDate')::timestamptz
      AND NEW."deliveryWindowStart" = (c.payload::jsonb ->> 'deliveryWindowStart')::timestamptz
      AND NEW."deliveryWindowEnd" = (c.payload::jsonb ->> 'deliveryWindowEnd')::timestamptz
      AND NEW."deliveryWindowStart" > clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM public."deliveryAttempt" later JOIN public."routeStop" lst ON lst.id = later."stopId"
        WHERE lst."orderId" = OLD.id AND later.outcome = 'FAILED' AND (later."recordedAt", later.id) > (d."recordedAt", d.id)
      )
  ) THEN
    RAISE EXCEPTION 'Failed order requires an explicit persisted agreement and audited resolution after completion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_review_resolution BEFORE UPDATE ON public."order" FOR EACH ROW EXECUTE FUNCTION public.dispatch_review_resolution_guard();
`,
          },
        ],
        postcheck: [
          {
            description: 'agreement guard enabled',
            sql: "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dispatch_review_resolution' AND tgenabled = 'O') AS result",
          },
        ],
      }),
      this.dataTransform(
        invariantDb.contract,
        'failed-visits-require-review-or-audited-agreement',
        {
          check: unresolvedFailures,
          // A violation remains a violation, so the runner fails closed and rolls back.
          run: unresolvedFailures,
        },
      ),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
