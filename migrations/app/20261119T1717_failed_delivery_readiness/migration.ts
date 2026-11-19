#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/1b4e7632062d3ea2fdbb235d224cf37ae0a5daaddd961bcce901eb985e47d9a6/contract';
import startContract from '../../snapshots/1b4e7632062d3ea2fdbb235d224cf37ae0a5daaddd961bcce901eb985e47d9a6/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/973c66fbba6fd6fb7bc1926da46af1dd3efe74ca17073eb430209d58d890e95c/contract';
import endContract from '../../snapshots/973c66fbba6fd6fb7bc1926da46af1dd3efe74ca17073eb430209d58d890e95c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_70314cc0',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_9d94133a',
        expression:
          "action IN ('CONFIRM', 'REJECT', 'REORDER', 'MOVE', 'REASSIGN_DRIVER', 'PRIORITIZE', 'CONTACT', 'RESCHEDULE', 'PICKUP_AGREE', 'PICKUP_DECLINE', 'PICKUP_CONFIRM', 'CONFIRM_INCIDENT_READY', 'RELEASE_DRAFT', 'CANCEL_ROUTE', 'LOSS_DECLARE', 'REPLACEMENT_PREPARE', 'ORIGINAL_RECOVER', 'LOSS_CANCEL', 'EMERGENCY_DECLARE', 'UNIT_RECOVERY_CONFIRM', 'EMERGENCY_CLOSE', 'EMERGENCY_DRIVER_RELEASE', 'EMERGENCY_REQUEUE') AND outcome IN ('APPLIED', 'REJECTED', 'FAILED') AND length(trim(reason)) BETWEEN 1 AND 500",
      }),
      rawSql({
        id: 'failed-delivery-readiness.lifecycle-and-resolution-guards',
        label:
          'Allow canonical FAILED-stop claim release, require CONFIRM_INCIDENT_READY for ordinary failed resolution, and permit historical route completion',
        operationClass: 'widening',
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
            description:
              'require lifecycle coherence, stop visit, claim history, and review resolution guard functions before updating them',
            sql: `SELECT (
              to_regprocedure('public.t1e_validate_route_coherence(text)') IS NOT NULL
              AND to_regprocedure('public.t1e_validate_stop_visit(text)') IS NOT NULL
              AND to_regprocedure('public.t1e_claim_history_guard()') IS NOT NULL
              AND to_regprocedure('public.dispatch_review_resolution_guard()') IS NOT NULL
            ) AS result`,
          },
        ],
        execute: [
          {
            description:
              'update claim history, route coherence, stop visit, review resolution, and readiness audit guards for early failed-claim release and store readiness',
            sql: `CREATE OR REPLACE FUNCTION public.t1e_validate_route_coherence(p_route_id text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  route_row public.route%ROWTYPE;
  stop_count bigint;
  active_claim_count bigint;
  active_reservation_count bigint;
BEGIN
  SELECT * INTO route_row
  FROM public.route
  WHERE id = p_route_id
  FOR UPDATE;
  IF NOT FOUND OR route_row.status IS NULL THEN
    RETURN;
  END IF;

  SELECT COUNT(*) INTO stop_count
  FROM public."routeStop"
  WHERE "routeId" = p_route_id AND NOT "isLegacy" AND sequence IS NOT NULL;
  SELECT COUNT(*) INTO active_claim_count
  FROM public."orderClaim"
  WHERE "routeId" = p_route_id AND "releasedAt" IS NULL;
  SELECT COUNT(*) INTO active_reservation_count
  FROM public."driverReservation"
  WHERE "routeId" = p_route_id AND "releasedAt" IS NULL;

  IF route_row.status = 'DRAFT' THEN
    IF EXISTS (
      SELECT 1 FROM public."driverReservation"
      WHERE "routeId" = p_route_id AND "releasedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'DRAFT route cannot hold an active driver reservation'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public."order"
      WHERE "routeId" = p_route_id
    ) THEN
      RAISE EXCEPTION 'DRAFT route cannot own an order route pointer'
        USING ERRCODE = '23514';
    END IF;
  ELSIF route_row.status IN ('ASSIGNED', 'IN_PROGRESS') THEN
    IF route_row."driverId" IS NULL OR active_reservation_count <> 1 OR NOT EXISTS (
      SELECT 1 FROM public."driverReservation" d
      WHERE d."routeId" = p_route_id
        AND d."driverId" = route_row."driverId"
        AND d."reservedAt" IS NOT NULL
        AND d."releasedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'Assigned or in-progress route requires one matching active driver reservation'
        USING ERRCODE = '23514';
    END IF;
  ELSIF route_row.status IN ('COMPLETED', 'INTERRUPTED') THEN
    IF active_claim_count <> 0 THEN
      RAISE EXCEPTION 'COMPLETED or INTERRUPTED route cannot retain active order claims'
        USING ERRCODE = '23514';
    END IF;
    IF route_row."returnedAt" IS NULL THEN
      IF route_row."driverId" IS NULL OR active_reservation_count <> 1 OR NOT EXISTS (
        SELECT 1 FROM public."driverReservation" d
        WHERE d."routeId" = p_route_id
          AND d."driverId" = route_row."driverId"
          AND d."reservedAt" IS NOT NULL
          AND d."releasedAt" IS NULL
      ) THEN
        RAISE EXCEPTION 'Completed or interrupted route remains held until one matching physical-return reservation is released'
          USING ERRCODE = '23514';
      END IF;
    ELSIF active_reservation_count <> 0 OR NOT EXISTS (
      SELECT 1 FROM public."driverReservation" d
      WHERE d."routeId" = p_route_id
        AND d."driverId" = route_row."driverId"
        AND d."reservedAt" IS NOT NULL
        AND d."releasedAt" = route_row."returnedAt"
    ) THEN
      RAISE EXCEPTION 'Returned route requires its matching reservation release at the recorded return time'
        USING ERRCODE = '23514';
    END IF;
  ELSIF route_row.status = 'CANCELLED' THEN
    IF route_row."driverId" IS NULL OR route_row."cancelledAt" IS NULL OR
       route_row."cancelledById" IS NULL OR route_row."cancelReason" IS NULL OR
       route_row."startedAt" IS NOT NULL OR route_row."completedAt" IS NOT NULL OR
       route_row."returnedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Cancelled route requires cancellation audit, driver association, and no execution events'
        USING ERRCODE = '23514';
    END IF;
    IF active_claim_count <> 0 THEN
      RAISE EXCEPTION 'CANCELLED route cannot retain active order claims'
        USING ERRCODE = '23514';
    END IF;
    IF active_reservation_count <> 0 OR NOT EXISTS (
      SELECT 1 FROM public."driverReservation" d
      WHERE d."routeId" = p_route_id
        AND d."driverId" = route_row."driverId"
        AND d."reservedAt" IS NOT NULL
        AND d."releasedAt" = route_row."cancelledAt"
    ) THEN
      RAISE EXCEPTION 'Cancelled route requires its matching reservation release at the recorded cancellation time'
        USING ERRCODE = '23514';
    END IF;
    IF stop_count < 1 OR stop_count > 4 THEN
      RAISE EXCEPTION 'Cancelled route must preserve one to four original stops'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public."order"
      WHERE "routeId" = p_route_id
    ) THEN
      RAISE EXCEPTION 'CANCELLED route cannot retain order route pointers'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public."routeStop" s
      WHERE s."routeId" = p_route_id
        AND (s.outcome IS DISTINCT FROM 'PENDING'
          OR EXISTS (SELECT 1 FROM public."deliveryAttempt" a WHERE a."stopId" = s.id))
    ) THEN
      RAISE EXCEPTION 'Cancelled route cannot contain resolved stops or delivery attempts'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      WHERE a.action = 'CANCEL_ROUTE' AND a.outcome = 'APPLIED'
        AND a."routeId" = p_route_id
        AND a."actorId" = route_row."cancelledById"
    ) THEN
      RAISE EXCEPTION 'Cancelled route requires a persisted CANCEL_ROUTE audit record'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF route_row.status IN ('DRAFT', 'ASSIGNED') THEN
    IF active_claim_count <> stop_count OR EXISTS (
      SELECT 1
      FROM public."orderClaim" c
      LEFT JOIN public."routeStop" s
        ON s."routeId" = c."routeId" AND s."orderId" = c."orderId"
       AND NOT s."isLegacy" AND s.sequence IS NOT NULL
      WHERE c."routeId" = p_route_id AND c."releasedAt" IS NULL
        AND (s.id IS NULL OR c."claimedAt" IS NULL)
    ) OR EXISTS (
      SELECT 1
      FROM public."routeStop" s
      LEFT JOIN public."orderClaim" c
        ON c."routeId" = s."routeId" AND c."orderId" = s."orderId"
       AND c."releasedAt" IS NULL
      WHERE s."routeId" = p_route_id
        AND (c.id IS NULL OR c."claimedAt" IS NULL)
    ) THEN
      RAISE EXCEPTION 'Verified route stops require exactly matching active order claims'
        USING ERRCODE = '23514';
    END IF;
  ELSIF route_row.status = 'IN_PROGRESS' THEN
    IF EXISTS (
      SELECT 1
      FROM public."orderClaim" c
      LEFT JOIN public."routeStop" s
        ON s."routeId" = c."routeId" AND s."orderId" = c."orderId"
       AND NOT s."isLegacy" AND s.sequence IS NOT NULL
      WHERE c."routeId" = p_route_id AND c."releasedAt" IS NULL
        AND (s.id IS NULL OR c."claimedAt" IS NULL)
    ) OR EXISTS (
      SELECT 1
      FROM public."routeStop" s
      WHERE s."routeId" = p_route_id
        AND NOT s."isLegacy" AND s.sequence IS NOT NULL
        AND s.outcome IS DISTINCT FROM 'FAILED'
        AND NOT EXISTS (
          SELECT 1
          FROM public."orderClaim" c
          WHERE c."routeId" = p_route_id
            AND c."orderId" = s."orderId"
            AND c."claimedAt" IS NOT NULL
            AND c."releasedAt" IS NULL
        )
    ) OR EXISTS (
      SELECT 1
      FROM public."routeStop" s
      WHERE s."routeId" = p_route_id
        AND NOT s."isLegacy" AND s.sequence IS NOT NULL
        AND s.outcome = 'FAILED'
        AND NOT (
          (
            NOT EXISTS (
              SELECT 1
              FROM public."orderClaim" ca
              WHERE ca."routeId" = p_route_id
                AND ca."orderId" = s."orderId"
                AND ca."releasedAt" IS NULL
            )
            AND EXISTS (
              SELECT 1
              FROM public."orderClaim" cr
              JOIN public."deliveryAttempt" d
                ON d."stopId" = s.id
               AND d.outcome = 'FAILED'
               AND d."failureReason" IS NOT NULL
               AND d."driverId" = route_row."driverId"
               AND route_row."startedAt" IS NOT NULL
               AND d."recordedAt" >= route_row."startedAt"
              WHERE cr."routeId" = p_route_id
                AND cr."orderId" = s."orderId"
                AND cr."claimedAt" IS NOT NULL
                AND cr."releasedAt" = d."recordedAt"
            )
          )
          OR (
            EXISTS (
              SELECT 1
              FROM public."orderClaim" ca
              WHERE ca."routeId" = p_route_id
                AND ca."orderId" = s."orderId"
                AND ca."claimedAt" IS NOT NULL
                AND ca."releasedAt" IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public."orderClaim" cr
              JOIN public."deliveryAttempt" d
                ON d."stopId" = s.id
               AND d.outcome = 'FAILED'
               AND d."failureReason" IS NOT NULL
              WHERE cr."routeId" = p_route_id
                AND cr."orderId" = s."orderId"
                AND cr."releasedAt" IS NOT NULL
                AND cr."releasedAt" >= d."recordedAt"
            )
          )
        )
    ) THEN
      RAISE EXCEPTION 'Verified route stops require exactly matching active order claims'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF route_row.status IN ('ASSIGNED', 'IN_PROGRESS') AND EXISTS (
    SELECT 1
    FROM public."routeStop" s
    JOIN public."order" o ON o.id = s."orderId"
    WHERE s."routeId" = p_route_id
      AND NOT s."isLegacy" AND s.sequence IS NOT NULL
      AND o."routeId" IS DISTINCT FROM p_route_id
      AND NOT (
        route_row.status = 'IN_PROGRESS'
        AND s.outcome = 'FAILED'
        AND NOT EXISTS (
          SELECT 1
          FROM public."orderClaim" ca
          WHERE ca."routeId" = p_route_id
            AND ca."orderId" = s."orderId"
            AND ca."releasedAt" IS NULL
        )
        AND EXISTS (
          SELECT 1
          FROM public."orderClaim" cr
          JOIN public."deliveryAttempt" d
            ON d."stopId" = s.id
           AND d.outcome = 'FAILED'
           AND d."failureReason" IS NOT NULL
           AND d."driverId" = route_row."driverId"
           AND route_row."startedAt" IS NOT NULL
           AND d."recordedAt" >= route_row."startedAt"
          WHERE cr."routeId" = p_route_id
            AND cr."orderId" = s."orderId"
            AND cr."claimedAt" IS NOT NULL
            AND cr."releasedAt" = d."recordedAt"
        )
      )
  ) THEN
    RAISE EXCEPTION 'Assigned or in-progress verified stops require their current order route pointer'
      USING ERRCODE = '23514';
  END IF;
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
  IF route_row.status = 'CANCELLED' THEN
    IF stop_row.outcome IS DISTINCT FROM 'PENDING' OR
       EXISTS (SELECT 1 FROM public."deliveryAttempt" WHERE "stopId" = p_stop_id) THEN
      RAISE EXCEPTION 'CANCELLED route stop cannot be resolved or have a visit attempt'
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
  IF route_row.status NOT IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') OR
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
    SELECT 1
    FROM public."dispatchIntervention" a
    JOIN public."deliveryAttempt" d
      ON d.id = a.result::jsonb ->> 'attemptId'
    WHERE a.action IN ('RESCHEDULE', 'PICKUP_AGREE')
      AND a.outcome = 'APPLIED'
      AND a."orderId" = stop_row."orderId"
      AND d."stopId" = stop_row.id
      AND d.outcome = 'FAILED'
      AND (
        route_row.status IN ('COMPLETED', 'INTERRUPTED')
        OR (
          route_row.status = 'IN_PROGRESS'
          AND NOT EXISTS (
            SELECT 1 FROM public."orderClaim" ca
            WHERE ca."routeId" = route_row.id
              AND ca."orderId" = stop_row."orderId"
              AND ca."releasedAt" IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM public."orderClaim" cr
            WHERE cr."routeId" = route_row.id
              AND cr."orderId" = stop_row."orderId"
              AND cr."claimedAt" IS NOT NULL
              AND cr."releasedAt" = d."recordedAt"
          )
          AND EXISTS (
            SELECT 1 FROM public."dispatchIntervention" ready
            WHERE ready.action = 'CONFIRM_INCIDENT_READY'
              AND ready.outcome = 'APPLIED'
              AND ready."orderId" = stop_row."orderId"
              AND ready.payload::jsonb ->> 'attemptId' = d.id
              AND ready.result::jsonb ->> 'attemptId' = d.id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Failed visit requires current administrative review flag'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.t1e_claim_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  route_status text;
  completed_at timestamptz;
  cancelled_at timestamptz;
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
    SELECT status::text, "completedAt", "cancelledAt" INTO route_status, completed_at, cancelled_at
    FROM public.route WHERE id = OLD."routeId";
    IF route_status = 'COMPLETED' AND completed_at = NEW."releasedAt" THEN
      RETURN NEW;
    END IF;
    IF route_status = 'IN_PROGRESS' AND EXISTS (
      SELECT 1
      FROM public."routeStop" s
      JOIN public."deliveryAttempt" d ON d."stopId" = s.id
      JOIN public."order" o ON o.id = s."orderId"
      JOIN public.route r ON r.id = s."routeId"
      WHERE s."routeId" = OLD."routeId"
        AND s."orderId" = OLD."orderId"
        AND NOT s."isLegacy"
        AND s.sequence IS NOT NULL
        AND s.outcome = 'FAILED'
        AND r.status = 'IN_PROGRESS'
        AND r."startedAt" IS NOT NULL
        AND r."driverId" IS NOT NULL
        AND d.outcome = 'FAILED'
        AND d."failureReason" IS NOT NULL
        AND d."driverId" = r."driverId"
        AND d."recordedAt" >= r."startedAt"
        AND d."recordedAt" = NEW."releasedAt"
        AND d.xmin = pg_current_xact_id()::text::xid
        AND o."requiresAdministrativeReview" = true
    ) THEN
      RETURN NEW;
    END IF;
    IF route_status = 'CANCELLED' AND cancelled_at = NEW."releasedAt" AND EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      WHERE a.action = 'CANCEL_ROUTE' AND a.outcome = 'APPLIED' AND a."routeId" = OLD."routeId"
        AND a.xmin = pg_current_xact_id()::text::xid
    ) THEN
      RETURN NEW;
    END IF;
    IF route_status = 'INTERRUPTED' AND EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      JOIN public."routeEmergency" e ON e."routeId" = OLD."routeId" AND e."declarationRequestId" = a."requestId"
      WHERE a.action = 'EMERGENCY_DECLARE' AND a.outcome = 'APPLIED' AND a."routeId" = OLD."routeId"
        AND a.xmin = pg_current_xact_id()::text::xid
        AND NEW."releasedAt" = e."declaredAt"
    ) THEN
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
      WHERE a.action IN ('MOVE', 'RESCHEDULE', 'PICKUP_AGREE') AND a.outcome = 'APPLIED' AND a."orderId" = OLD."orderId"
        AND (a.payload::jsonb ->> 'routeId' = OLD."routeId" OR (a.action IN ('RESCHEDULE', 'PICKUP_AGREE') AND a."routeId" = OLD."routeId"))
        AND a.xmin = pg_current_xact_id()::text::xid
    ) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Order claim may be released only at valid failure, completion, cancellation, emergency declaration, or pre-start stop removal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_review_resolution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."requiresAdministrativeReview" AND (
    NOT NEW."requiresAdministrativeReview" OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('DELIVERED','CANCELLED','PENDING')) OR
    (NEW."scheduledDeliveryDate", NEW."deliveryWindowStart", NEW."deliveryWindowEnd", NEW."routeId")
    IS DISTINCT FROM (OLD."scheduledDeliveryDate", OLD."deliveryWindowStart", OLD."deliveryWindowEnd", OLD."routeId")
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public."routeUnitRecovery" u
      WHERE u."orderId" = OLD.id
        AND u."recoveredAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public."orderItemLoss" l
          WHERE l."orderItemId" = u."orderItemId"
            AND l."unitNumber" = u."unitNumber"
            AND l."cancelledAt" IS NULL
            AND l."replacementPreparedAt" IS NOT NULL
        )
    ) THEN
      RAISE EXCEPTION 'Order with pending emergency unit recovery cannot be released from administrative review' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      JOIN public."dispatchIntervention" c ON c.id = a.payload::jsonb ->> 'agreementId'
      JOIN public."deliveryAttempt" d ON d.id = c.payload::jsonb ->> 'attemptId'
      JOIN public."routeStop" st ON st.id = d."stopId"
      JOIN public.route r ON r.id = st."routeId"
      WHERE a.action = 'RESCHEDULE' AND a.outcome = 'APPLIED' AND a."orderId" = OLD.id
        AND a.xmin = pg_current_xact_id()::text::xid
        AND c.action = 'CONTACT' AND c.outcome = 'APPLIED' AND c."orderId" = OLD.id
        AND c.payload::jsonb -> 'agreementConfirmed' = 'true'::jsonb
        AND st."orderId" = OLD.id AND NOT st."isLegacy" AND st.sequence IS NOT NULL
        AND d.outcome = 'FAILED' AND d."failureReason" IS NOT NULL
        AND r.status IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED')
        AND NEW.status = 'PENDING' AND NOT NEW."requiresAdministrativeReview" AND NEW."routeId" IS NULL AND NEW."stopOrder" IS NULL
        AND NEW."scheduledDeliveryDate" = (c.payload::jsonb ->> 'scheduledDeliveryDate')::timestamptz
        AND NEW."deliveryWindowStart" = (c.payload::jsonb ->> 'deliveryWindowStart')::timestamptz
        AND NEW."deliveryWindowEnd" = (c.payload::jsonb ->> 'deliveryWindowEnd')::timestamptz
        AND NEW."deliveryWindowStart" > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM public."orderPickup" op WHERE op."orderId" = OLD.id)
        AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
        AND EXISTS (
          SELECT 1 FROM public."orderClaim" fc
          WHERE fc."routeId" = r.id
            AND fc."orderId" = OLD.id
            AND fc."claimedAt" IS NOT NULL
            AND fc."releasedAt" IS NOT NULL
            AND (
              (r.status = 'IN_PROGRESS' AND fc."releasedAt" = d."recordedAt")
              OR (r.status IN ('COMPLETED', 'INTERRUPTED') AND fc."releasedAt" >= d."recordedAt")
            )
        )
        AND EXISTS (
          SELECT 1 FROM public."dispatchIntervention" ready
          WHERE ready.action = 'CONFIRM_INCIDENT_READY'
            AND ready.outcome = 'APPLIED'
            AND ready."orderId" = OLD.id
            AND ready.payload::jsonb ->> 'attemptId' = d.id
            AND ready.result::jsonb ->> 'attemptId' = d.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public."routeUnitRecovery" u
          JOIN public."routeEmergency" e ON e.id = u."emergencyId"
          WHERE u."orderId" = OLD.id AND e."declaredAt" >= d."recordedAt"
        )
        AND NOT EXISTS (
          SELECT 1 FROM public."deliveryAttempt" later JOIN public."routeStop" lst ON lst.id = later."stopId"
          WHERE lst."orderId" = OLD.id AND later.outcome = 'FAILED' AND (later."recordedAt", later.id) > (d."recordedAt", d.id)
        )
    ) AND NOT EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      JOIN public."dispatchIntervention" c ON c.id = a.payload::jsonb ->> 'agreementId'
      JOIN public."routeEmergency" e ON e.id = c.payload::jsonb ->> 'emergencyId'
      WHERE a.action = 'RESCHEDULE' AND a.outcome = 'APPLIED' AND a."orderId" = OLD.id
        AND a.xmin = pg_current_xact_id()::text::xid
        AND c.action = 'CONTACT' AND c.outcome = 'APPLIED' AND c."orderId" = OLD.id
        AND c.payload::jsonb -> 'agreementConfirmed' = 'true'::jsonb
        AND EXISTS (SELECT 1 FROM public."routeUnitRecovery" u WHERE u."emergencyId" = e.id AND u."orderId" = OLD.id)
        AND NEW.status = 'PENDING' AND NOT NEW."requiresAdministrativeReview" AND NEW."routeId" IS NULL AND NEW."stopOrder" IS NULL
        AND NEW."scheduledDeliveryDate" = (c.payload::jsonb ->> 'scheduledDeliveryDate')::timestamptz
        AND NEW."deliveryWindowStart" = (c.payload::jsonb ->> 'deliveryWindowStart')::timestamptz
        AND NEW."deliveryWindowEnd" = (c.payload::jsonb ->> 'deliveryWindowEnd')::timestamptz
        AND NEW."deliveryWindowStart" > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM public."orderPickup" op WHERE op."orderId" = OLD.id)
        AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM public."deliveryAttempt" later JOIN public."routeStop" lst ON lst.id = later."stopId"
          WHERE lst."orderId" = OLD.id AND later.outcome = 'FAILED' AND later."recordedAt" >= e."declaredAt"
        )
    ) AND NOT EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      JOIN public."orderPickup" p ON p."orderId" = a."orderId" AND p."agreementRequestId" = a."requestId"
      JOIN public."deliveryAttempt" d ON d.id = a.payload::jsonb ->> 'attemptId'
      JOIN public."routeStop" st ON st.id = d."stopId"
      JOIN public.route r ON r.id = st."routeId"
      WHERE a.action = 'PICKUP_AGREE' AND a.outcome = 'APPLIED' AND a."orderId" = OLD.id
        AND a.xmin = pg_current_xact_id()::text::xid
        AND p."confirmedAt" IS NULL
        AND st."orderId" = OLD.id AND NOT st."isLegacy" AND st.sequence IS NOT NULL
        AND d.outcome = 'FAILED' AND d."failureReason" IS NOT NULL
        AND r.status IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED')
        AND NEW.status = 'PENDING' AND NEW."requiresAdministrativeReview" AND NEW."routeId" IS NULL AND NEW."stopOrder" IS NULL
        AND (NEW."scheduledDeliveryDate", NEW."deliveryWindowStart", NEW."deliveryWindowEnd")
          IS NOT DISTINCT FROM (OLD."scheduledDeliveryDate", OLD."deliveryWindowStart", OLD."deliveryWindowEnd")
        AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
        AND EXISTS (
          SELECT 1 FROM public."orderClaim" fc
          WHERE fc."routeId" = r.id
            AND fc."orderId" = OLD.id
            AND fc."claimedAt" IS NOT NULL
            AND fc."releasedAt" IS NOT NULL
            AND (
              (r.status = 'IN_PROGRESS' AND fc."releasedAt" = d."recordedAt")
              OR (r.status IN ('COMPLETED', 'INTERRUPTED') AND fc."releasedAt" >= d."recordedAt")
            )
        )
        AND EXISTS (
          SELECT 1 FROM public."dispatchIntervention" ready
          WHERE ready.action = 'CONFIRM_INCIDENT_READY'
            AND ready.outcome = 'APPLIED'
            AND ready."orderId" = OLD.id
            AND ready.payload::jsonb ->> 'attemptId' = d.id
            AND ready.result::jsonb ->> 'attemptId' = d.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public."routeUnitRecovery" u
          JOIN public."routeEmergency" e ON e.id = u."emergencyId"
          WHERE u."orderId" = OLD.id AND e."declaredAt" >= d."recordedAt"
        )
        AND NOT EXISTS (
          SELECT 1 FROM public."deliveryAttempt" later JOIN public."routeStop" lst ON lst.id = later."stopId"
          WHERE lst."orderId" = OLD.id AND later.outcome = 'FAILED' AND (later."recordedAt", later.id) > (d."recordedAt", d.id)
        )
    ) AND NOT EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      JOIN public."orderPickup" p ON p."orderId" = a."orderId" AND p."agreementRequestId" = a."requestId"
      JOIN public."routeEmergency" e ON e.id = a.payload::jsonb ->> 'emergencyId'
      WHERE a.action = 'PICKUP_AGREE' AND a.outcome = 'APPLIED' AND a."orderId" = OLD.id
        AND a.xmin = pg_current_xact_id()::text::xid
        AND p."confirmedAt" IS NULL
        AND EXISTS (SELECT 1 FROM public."routeUnitRecovery" u WHERE u."emergencyId" = e.id AND u."orderId" = OLD.id)
        AND NEW.status = 'PENDING' AND NEW."requiresAdministrativeReview" AND NEW."routeId" IS NULL AND NEW."stopOrder" IS NULL
        AND (NEW."scheduledDeliveryDate", NEW."deliveryWindowStart", NEW."deliveryWindowEnd")
          IS NOT DISTINCT FROM (OLD."scheduledDeliveryDate", OLD."deliveryWindowStart", OLD."deliveryWindowEnd")
        AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM public."deliveryAttempt" later JOIN public."routeStop" lst ON lst.id = later."stopId"
          WHERE lst."orderId" = OLD.id AND later.outcome = 'FAILED' AND later."recordedAt" >= e."declaredAt"
        )
    ) AND NOT EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      JOIN public."orderPickup" p ON p."orderId" = a."orderId" AND p."confirmationRequestId" = a."requestId"
      WHERE a.action = 'PICKUP_CONFIRM' AND a.outcome = 'APPLIED' AND a."orderId" = OLD.id
        AND a.xmin = pg_current_xact_id()::text::xid
        AND p."confirmedAt" IS NOT NULL AND p."confirmedById" = a."actorId"
        AND OLD.status = 'PENDING' AND OLD."routeId" IS NULL AND NEW."routeId" IS NULL
        AND NEW.status = 'DELIVERED' AND NOT NEW."requiresAdministrativeReview"
        AND (NEW."scheduledDeliveryDate", NEW."deliveryWindowStart", NEW."deliveryWindowEnd")
          IS NOT DISTINCT FROM (OLD."scheduledDeliveryDate", OLD."deliveryWindowStart", OLD."deliveryWindowEnd")
        AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
    ) AND NOT EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      JOIN public."routeEmergency" e ON e.id = a.payload::jsonb ->> 'emergencyId'
      WHERE a.action = 'EMERGENCY_REQUEUE' AND a.outcome = 'APPLIED' AND a."orderId" = OLD.id
        AND a.xmin = pg_current_xact_id()::text::xid
        AND EXISTS (SELECT 1 FROM public."routeUnitRecovery" u WHERE u."emergencyId" = e.id AND u."orderId" = OLD.id)
        AND NEW.status = 'PENDING' AND NOT NEW."requiresAdministrativeReview" AND NEW."routeId" IS NULL AND NEW."stopOrder" IS NULL
        AND (NEW."scheduledDeliveryDate", NEW."deliveryWindowStart", NEW."deliveryWindowEnd")
          IS NOT DISTINCT FROM (OLD."scheduledDeliveryDate", OLD."deliveryWindowStart", OLD."deliveryWindowEnd")
        AND NOT EXISTS (SELECT 1 FROM public."orderPickup" op WHERE op."orderId" = OLD.id)
        AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM public."deliveryAttempt" later JOIN public."routeStop" lst ON lst.id = later."stopId"
          WHERE lst."orderId" = OLD.id AND later.outcome = 'FAILED' AND later."recordedAt" >= e."declaredAt"
        )
    ) THEN
      RAISE EXCEPTION 'Failed order requires store readiness confirmation and an explicit persisted agreement or emergency resolution after claim release or recovery' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_incident_ready_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  attempt_id text;
  result_attempt_id text;
  order_row public."order"%ROWTYPE;
  attempt_row public."deliveryAttempt"%ROWTYPE;
  stop_row public."routeStop"%ROWTYPE;
  route_row public.route%ROWTYPE;
BEGIN
  attempt_id := NEW.payload::jsonb ->> 'attemptId';
  result_attempt_id := NEW.result::jsonb ->> 'attemptId';
  IF NEW."orderId" IS NULL OR attempt_id IS NULL OR result_attempt_id IS NULL OR attempt_id <> result_attempt_id OR NEW.payload ->> 'attemptId' IS DISTINCT FROM attempt_id THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY requires matching orderId and attemptId in payload and result'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO order_row FROM public."order" WHERE id = NEW."orderId" FOR SHARE;
  IF NOT FOUND OR NOT order_row."requiresAdministrativeReview" OR order_row.status IN ('DELIVERED', 'CANCELLED') THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY requires an unresolved order under administrative review'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (SELECT 1 FROM public."orderPickup" WHERE "orderId" = NEW."orderId") THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY is not allowed when store pickup is already agreed'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO attempt_row FROM public."deliveryAttempt" WHERE id = attempt_id;
  IF NOT FOUND OR attempt_row.outcome <> 'FAILED' OR attempt_row."failureReason" IS NULL THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY requires a canonical FAILED delivery attempt'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO stop_row FROM public."routeStop" WHERE id = attempt_row."stopId";
  IF NOT FOUND OR stop_row."orderId" <> NEW."orderId" OR stop_row."isLegacy" OR stop_row.sequence IS NULL OR stop_row.outcome <> 'FAILED' THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY attempt must belong to a verified FAILED stop of the order'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO route_row FROM public.route WHERE id = stop_row."routeId";
  IF NOT FOUND OR route_row.status NOT IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') OR
     route_row."startedAt" IS NULL OR route_row."driverId" IS NULL OR
     attempt_row."driverId" <> route_row."driverId" OR
     attempt_row."recordedAt" < route_row."startedAt" THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY requires verified route execution evidence'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."deliveryAttempt" later
    JOIN public."routeStop" lst ON lst.id = later."stopId"
    WHERE lst."orderId" = NEW."orderId"
      AND NOT lst."isLegacy"
      AND lst.sequence IS NOT NULL
      AND lst.outcome = 'FAILED'
      AND later.outcome = 'FAILED'
      AND later."failureReason" IS NOT NULL
      AND (later."recordedAt", later.id) > (attempt_row."recordedAt", attempt_row.id)
  ) THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY must attest the latest canonical failed attempt'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."routeUnitRecovery" u
    JOIN public."routeEmergency" e ON e.id = u."emergencyId"
    WHERE u."orderId" = NEW."orderId"
      AND (
        e."declaredAt" >= attempt_row."recordedAt"
        OR (
          u."recoveredAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public."orderItemLoss" l
            WHERE l."orderItemId" = u."orderItemId"
              AND l."unitNumber" = u."unitNumber"
              AND l."cancelledAt" IS NULL
              AND l."replacementPreparedAt" IS NOT NULL
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY cannot be granted for emergency custody orders'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public."orderClaim"
    WHERE "orderId" = NEW."orderId" AND "releasedAt" IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public."orderClaim" fc
    WHERE fc."routeId" = route_row.id
      AND fc."orderId" = NEW."orderId"
      AND fc."claimedAt" IS NOT NULL
      AND fc."releasedAt" IS NOT NULL
      AND (
        (route_row.status = 'IN_PROGRESS' AND fc."releasedAt" = attempt_row."recordedAt")
        OR (route_row.status IN ('COMPLETED', 'INTERRUPTED') AND fc."releasedAt" >= attempt_row."recordedAt")
      )
  ) THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY requires the failed stop claim to be released'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public."dispatchIntervention" existing
    WHERE existing.action = 'CONFIRM_INCIDENT_READY'
      AND existing.outcome = 'APPLIED'
      AND existing."orderId" = NEW."orderId"
      AND existing.payload::jsonb ->> 'attemptId' = attempt_id
      AND existing.result::jsonb ->> 'attemptId' = attempt_id
  ) THEN
    RAISE EXCEPTION 'CONFIRM_INCIDENT_READY has already been recorded for this failed attempt'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS dispatch_incident_ready ON public."dispatchIntervention";
CREATE TRIGGER dispatch_incident_ready
BEFORE INSERT ON public."dispatchIntervention"
FOR EACH ROW
WHEN (NEW.action = 'CONFIRM_INCIDENT_READY' AND NEW.outcome = 'APPLIED')
EXECUTE FUNCTION public.dispatch_incident_ready_guard();

CREATE UNIQUE INDEX IF NOT EXISTS dispatch_incident_ready_unique_attempt_idx
  ON public."dispatchIntervention" ("orderId", (payload ->> 'attemptId'))
  WHERE action = 'CONFIRM_INCIDENT_READY' AND outcome = 'APPLIED';

CREATE OR REPLACE FUNCTION public.dispatch_pickup_conflict_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."orderId" IS NOT NULL THEN
    PERFORM 1 FROM public."order" WHERE id = NEW."orderId" FOR SHARE;
    IF EXISTS (
      SELECT 1 FROM public."orderPickup" op WHERE op."orderId" = NEW."orderId"
    ) THEN
      RAISE EXCEPTION 'CONTACT and RESCHEDULE are not allowed when a store pickup already exists for this order'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS dispatch_pickup_conflict ON public."dispatchIntervention";
CREATE TRIGGER dispatch_pickup_conflict
BEFORE INSERT ON public."dispatchIntervention"
FOR EACH ROW
WHEN (NEW.action IN ('CONTACT', 'RESCHEDULE') AND NEW.outcome = 'APPLIED')
EXECUTE FUNCTION public.dispatch_pickup_conflict_guard();

CREATE OR REPLACE FUNCTION public.failed_attempt_claim_release_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  stop_row public."routeStop"%ROWTYPE;
  route_row public.route%ROWTYPE;
BEGIN
  IF NEW.outcome <> 'FAILED' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO stop_row FROM public."routeStop" WHERE id = NEW."stopId";
  IF NOT FOUND OR stop_row."isLegacy" OR stop_row.sequence IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO route_row FROM public.route WHERE id = stop_row."routeId";
  IF NOT FOUND OR route_row.status IS NULL THEN
    RETURN NULL;
  END IF;

  IF route_row.status IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') THEN
    IF EXISTS (
      SELECT 1
      FROM public."orderClaim" ca
      WHERE ca."routeId" = stop_row."routeId"
        AND ca."orderId" = stop_row."orderId"
        AND ca."releasedAt" IS NULL
    ) OR NOT EXISTS (
      SELECT 1
      FROM public."orderClaim" cr
      WHERE cr."routeId" = stop_row."routeId"
        AND cr."orderId" = stop_row."orderId"
        AND cr."claimedAt" IS NOT NULL
        AND cr."releasedAt" = NEW."recordedAt"
        AND cr.xmin = pg_current_xact_id()::text::xid
    ) THEN
      RAISE EXCEPTION 'New canonical FAILED delivery attempt must atomically release its matching order claim in the same transaction'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS t1e_failed_attempt_claim_release ON public."deliveryAttempt";
CREATE CONSTRAINT TRIGGER t1e_failed_attempt_claim_release
AFTER INSERT ON public."deliveryAttempt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.outcome = 'FAILED')
EXECUTE FUNCTION public.failed_attempt_claim_release_guard();`,
          },
        ],
        postcheck: [
          {
            description:
              'all updated route coherence, stop visit, claim history, review resolution, pickup conflict, deferred failed-attempt release, and readiness uniqueness guards are active',
            sql: `SELECT (
              (SELECT position('CONFIRM_INCIDENT_READY' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_validate_stop_visit' AND pronamespace='public'::regnamespace)
              AND (SELECT position('CONFIRM_INCIDENT_READY' in prosrc) > 0 FROM pg_proc WHERE proname='dispatch_review_resolution_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('orderPickup' in prosrc) > 0 FROM pg_proc WHERE proname='dispatch_review_resolution_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('valid failure, completion, cancellation' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_claim_history_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('cr."releasedAt" >= d."recordedAt"' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_validate_route_coherence' AND pronamespace='public'::regnamespace)
              AND to_regprocedure('public.dispatch_incident_ready_guard()') IS NOT NULL
              AND to_regprocedure('public.dispatch_pickup_conflict_guard()') IS NOT NULL
              AND to_regprocedure('public.failed_attempt_claim_release_guard()') IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgname = 'dispatch_incident_ready'
                  AND tgrelid = 'public."dispatchIntervention"'::regclass
                  AND tgenabled = 'O'
              )
              AND EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgname = 'dispatch_pickup_conflict'
                  AND tgrelid = 'public."dispatchIntervention"'::regclass
                  AND tgenabled = 'O'
              )
              AND EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgname = 't1e_failed_attempt_claim_release'
                  AND tgrelid = 'public."deliveryAttempt"'::regclass
                  AND tgenabled = 'O'
              )
              AND EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public'
                  AND tablename = 'dispatchIntervention'
                  AND indexname = 'dispatch_incident_ready_unique_attempt_idx'
              )
            ) AS result`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
