#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/1b4e7632062d3ea2fdbb235d224cf37ae0a5daaddd961bcce901eb985e47d9a6/contract';
import endContract from '../../snapshots/1b4e7632062d3ea2fdbb235d224cf37ae0a5daaddd961bcce901eb985e47d9a6/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/4f1c811137748b11cce955f4802840d44e900a662cca49432139410ca3195b57/contract';
import startContract from '../../snapshots/4f1c811137748b11cce955f4802840d44e900a662cca49432139410ca3195b57/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_11fbfe53',
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'route',
        constraint: 'route_status_check_736c4cf9',
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('cancelReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('cancelledAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'route',
        column: col('cancelledById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_70314cc0',
        expression:
          "action IN ('CONFIRM', 'REJECT', 'REORDER', 'MOVE', 'REASSIGN_DRIVER', 'PRIORITIZE', 'CONTACT', 'RESCHEDULE', 'PICKUP_AGREE', 'PICKUP_DECLINE', 'PICKUP_CONFIRM', 'RELEASE_DRAFT', 'CANCEL_ROUTE', 'LOSS_DECLARE', 'REPLACEMENT_PREPARE', 'ORIGINAL_RECOVER', 'LOSS_CANCEL', 'EMERGENCY_DECLARE', 'UNIT_RECOVERY_CONFIRM', 'EMERGENCY_CLOSE', 'EMERGENCY_DRIVER_RELEASE', 'EMERGENCY_REQUEUE') AND outcome IN ('APPLIED', 'REJECTED', 'FAILED') AND length(trim(reason)) BETWEEN 1 AND 500",
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'route',
        constraint: 'route_cancellation_consistent_02c529e8',
        expression:
          '(status IS DISTINCT FROM \'CANCELLED\' AND "cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancelReason" IS NULL) OR (status = \'CANCELLED\' AND "driverId" IS NOT NULL AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(trim("cancelReason")) BETWEEN 1 AND 500 AND "startedAt" IS NULL AND "startedById" IS NULL AND "completedAt" IS NULL AND "completedById" IS NULL AND "returnedAt" IS NULL AND "returnedById" IS NULL)',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'route',
        constraint: 'route_status_check_2ae0f5f1',
        expression:
          "\"status\" IN ('DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'INTERRUPTED', 'CANCELLED')",
      }),
      this.createIndex({
        schema: 'public',
        table: 'route',
        index: 'route_cancelledById_idx_03ce7bea',
        columns: ['cancelledById'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'route',
        foreignKey: {
          name: 'route_cancelledById_fkey',
          columns: ['cancelledById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      rawSql({
        id: 'route-cancellation.lifecycle-coherence-guards',
        label:
          'Widen route, stop, visit, claim, and reservation guards for audited pre-start CANCELLED routes',
        operationClass: 'widening',
        target: {
          id: 'postgres',
          details: { objectType: 'table', schema: 'public', name: 'route' },
        },
        precheck: [
          {
            description:
              'require lifecycle coherence and history guard functions before replacing them',
            sql: `SELECT (
              to_regprocedure('public.route_integrity_guard()') IS NOT NULL
              AND to_regprocedure('public.route_stop_integrity_guard()') IS NOT NULL
              AND to_regprocedure('public.t1e_validate_route_coherence(text)') IS NOT NULL
              AND to_regprocedure('public.t1e_validate_stop_visit(text)') IS NOT NULL
              AND to_regprocedure('public.t1e_claim_history_guard()') IS NOT NULL
              AND to_regprocedure('public.t1e_reservation_history_guard()') IS NOT NULL
            ) AS result`,
          },
        ],
        execute: [
          {
            description:
              'update route, stop, coherence, visit, claim, and reservation guard functions to enforce terminal pre-start CANCELLED invariants while preserving INTERRUPTED and RELEASE_DRAFT rules',
            sql: `CREATE OR REPLACE FUNCTION public.route_integrity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IS NULL OR OLD.status IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED', 'CANCELLED') THEN
      RAISE EXCEPTION 'Route structure is frozen or unverified legacy history' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Route cannot be inserted directly as CANCELLED' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NULL AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Unverified legacy route cannot be rewritten' USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'Route history identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF (OLD.status IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED', 'CANCELLED') OR
        (OLD.status = 'ASSIGNED' AND NEW.status = 'CANCELLED')) AND
      (NEW."driverId", NEW."zoneId", NEW.date) IS DISTINCT FROM (OLD."driverId", OLD."zoneId", OLD.date) THEN
      RAISE EXCEPTION 'Route structure is frozen' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('COMPLETED', 'INTERRUPTED', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status OR
      OLD.status = 'IN_PROGRESS' AND NEW.status NOT IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') OR
      NEW.status = 'CANCELLED' AND OLD.status NOT IN ('ASSIGNED', 'CANCELLED') THEN
      RAISE EXCEPTION 'Frozen lifecycle cannot regress to a mutable state' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IS NOT NULL AND NEW.status IS NULL THEN
      RAISE EXCEPTION 'Verified lifecycle cannot become unverified' USING ERRCODE = '23514';
    END IF;
    IF (OLD."startedAt" IS NOT NULL OR OLD."startedById" IS NOT NULL) AND
      (NEW."startedAt", NEW."startedById") IS DISTINCT FROM (OLD."startedAt", OLD."startedById") OR
      (OLD."completedAt" IS NOT NULL OR OLD."completedById" IS NOT NULL) AND
      (NEW."completedAt", NEW."completedById") IS DISTINCT FROM (OLD."completedAt", OLD."completedById") OR
      (OLD."returnedAt" IS NOT NULL OR OLD."returnedById" IS NOT NULL) AND
      (NEW."returnedAt", NEW."returnedById") IS DISTINCT FROM (OLD."returnedAt", OLD."returnedById") OR
      (OLD."cancelledAt" IS NOT NULL OR OLD."cancelledById" IS NOT NULL OR OLD."cancelReason" IS NOT NULL) AND
      (NEW."cancelledAt", NEW."cancelledById", NEW."cancelReason") IS DISTINCT FROM (OLD."cancelledAt", OLD."cancelledById", OLD."cancelReason") THEN
      RAISE EXCEPTION 'Recorded lifecycle event evidence is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'ASSIGNED' AND NEW.status = 'CANCELLED' AND NOT EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      WHERE a.action = 'CANCEL_ROUTE' AND a.outcome = 'APPLIED'
        AND a."routeId" = NEW.id
        AND a."actorId" = NEW."cancelledById"
        AND trim(a.reason) = trim(NEW."cancelReason")
        AND a.xmin = pg_current_xact_id()::text::xid
    ) THEN
      RAISE EXCEPTION 'Route cancellation requires an audited ADMIN CANCEL_ROUTE intervention in the same transaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (NEW."startedAt" IS NULL) <> (NEW."startedById" IS NULL) OR
     (NEW."completedAt" IS NULL) <> (NEW."completedById" IS NULL) OR
     (NEW."returnedAt" IS NULL) <> (NEW."returnedById" IS NULL) OR
     (NEW."cancelledAt" IS NULL) <> (NEW."cancelledById" IS NULL) OR
     (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL) THEN
    RAISE EXCEPTION 'Lifecycle events require paired timestamps and actors' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS NULL AND (
    NEW."startedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL OR
    NEW."returnedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Unverified legacy route cannot invent events' USING ERRCODE = '23514';
  END IF;
  IF NEW."startedAt" IS NOT NULL AND NEW.status NOT IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') OR
    NEW."completedAt" IS NOT NULL AND NEW.status <> 'COMPLETED' OR
    NEW."returnedAt" IS NOT NULL AND NEW.status NOT IN ('COMPLETED', 'INTERRUPTED') OR
    NEW."cancelledAt" IS NOT NULL AND NEW.status <> 'CANCELLED' OR
    NEW.status = 'CANCELLED' AND (
      NEW."cancelledAt" IS NULL OR NEW."cancelledById" IS NULL OR
      NEW."cancelReason" IS NULL OR length(trim(NEW."cancelReason")) NOT BETWEEN 1 AND 500
    ) THEN
    RAISE EXCEPTION 'Recorded event is incompatible with lifecycle state' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('IN_PROGRESS', 'INTERRUPTED', 'CANCELLED') AND NEW."driverId" IS NULL THEN
    RAISE EXCEPTION 'IN_PROGRESS, INTERRUPTED, or CANCELLED requires an assigned driver' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public."routeStop" s JOIN public."order" o ON o.id = s."orderId"
      WHERE s."routeId" = NEW.id AND (s."isLegacy" OR s.sequence IS NULL OR s.sequence NOT BETWEEN 1 AND 4
        OR (NEW."zoneId" IS NOT NULL AND o."zoneId" IS NOT NULL AND o."zoneId" IS DISTINCT FROM NEW."zoneId"))) THEN
      RAISE EXCEPTION 'Verified route requires valid nonlegacy sequence and same zone' USING ERRCODE = '23514';
    END IF;
    IF (SELECT COUNT(*) FROM public."routeStop" WHERE "routeId" = NEW.id) > 4 THEN
      RAISE EXCEPTION 'Route maximum is four stops' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.route_stop_integrity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  route_ids text[];
  route_row record;
  old_stop_id text;
  structural boolean;
  order_zone text;
  destination_zone text;
  destination_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    route_ids := ARRAY[NEW."routeId"];
    structural := true;
  ELSIF TG_OP = 'DELETE' THEN
    route_ids := ARRAY[OLD."routeId"];
    structural := true;
  ELSE
    route_ids := ARRAY[OLD."routeId", NEW."routeId"];
    old_stop_id := OLD.id;
    structural := (NEW.id, NEW."routeId", NEW."orderId", NEW.sequence, NEW."isLegacy", NEW."createdAt")
      IS DISTINCT FROM (OLD.id, OLD."routeId", OLD."orderId", OLD.sequence, OLD."isLegacy", OLD."createdAt");
  END IF;
  FOR route_row IN SELECT id, status, "zoneId" FROM public.route
    WHERE id = ANY(route_ids) ORDER BY id FOR UPDATE LOOP
    IF route_row.status IS NULL THEN
      RAISE EXCEPTION 'Unverified legacy stop history cannot be rewritten' USING ERRCODE = '23514';
    END IF;
    IF structural AND route_row.status IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED', 'CANCELLED') THEN
      RAISE EXCEPTION 'Route stop structure is frozen' USING ERRCODE = '23514';
    END IF;
    IF TG_OP <> 'DELETE' AND route_row.id = NEW."routeId" THEN
      destination_zone := route_row."zoneId";
      destination_status := route_row.status;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND NEW.outcome IS DISTINCT FROM OLD.outcome AND destination_status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'Visit outcome changes require IN_PROGRESS' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.outcome IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'New verified visit outcome must be PENDING' USING ERRCODE = '23514';
  END IF;
  IF NEW."isLegacy" OR NEW.sequence IS NULL OR NEW.sequence NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'Verified stop requires nonlegacy sequence 1 through 4' USING ERRCODE = '23514';
  END IF;
  SELECT "zoneId" INTO order_zone FROM public."order" WHERE id = NEW."orderId" FOR SHARE;
  IF destination_zone IS NOT NULL AND order_zone IS NOT NULL AND order_zone IS DISTINCT FROM destination_zone THEN
    RAISE EXCEPTION 'Route stop order must belong to the same zone' USING ERRCODE = '23514';
  END IF;
  IF (SELECT COUNT(*) FROM public."routeStop" WHERE "routeId" = NEW."routeId" AND (old_stop_id IS NULL OR id <> old_stop_id)) >= 4 THEN
    RAISE EXCEPTION 'Route maximum is four stops' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t1e_validate_route_coherence(p_route_id text) RETURNS void
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

  IF route_row.status IN ('DRAFT', 'ASSIGNED', 'IN_PROGRESS') THEN
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
  END IF;

  IF route_row.status IN ('ASSIGNED', 'IN_PROGRESS') AND EXISTS (
    SELECT 1
    FROM public."routeStop" s
    JOIN public."order" o ON o.id = s."orderId"
    WHERE s."routeId" = p_route_id
      AND NOT s."isLegacy" AND s.sequence IS NOT NULL
      AND o."routeId" IS DISTINCT FROM p_route_id
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
    SELECT 1 FROM public."dispatchIntervention" a JOIN public."deliveryAttempt" d
      ON d.id = a.result::jsonb ->> 'attemptId'
    WHERE a.action IN ('RESCHEDULE', 'PICKUP_AGREE') AND a.outcome = 'APPLIED' AND a."orderId" = stop_row."orderId"
      AND d."stopId" = stop_row.id AND d.outcome = 'FAILED' AND route_row.status IN ('COMPLETED', 'INTERRUPTED')
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
    RAISE EXCEPTION 'Order claim may be released only at valid completion, cancellation, emergency declaration, or pre-start stop removal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t1e_reservation_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  route_status text;
  returned_at timestamptz;
  cancelled_at timestamptz;
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
    SELECT status::text, "returnedAt", "cancelledAt" INTO route_status, returned_at, cancelled_at
    FROM public.route WHERE id = OLD."routeId";
    IF route_status IN ('COMPLETED', 'INTERRUPTED') AND returned_at = NEW."releasedAt" THEN
      RETURN NEW;
    END IF;
    IF route_status = 'CANCELLED' AND cancelled_at = NEW."releasedAt" AND EXISTS (
      SELECT 1 FROM public."dispatchIntervention" a
      WHERE a.action = 'CANCEL_ROUTE' AND a.outcome = 'APPLIED' AND a."routeId" = OLD."routeId"
        AND a.xmin = pg_current_xact_id()::text::xid
    ) THEN
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
    RAISE EXCEPTION 'Verified driver reservation may be released only at physical return, audited cancellation, or driver reassignment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.route_cancellation_order_restoration_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."routeStop" s
    JOIN public."order" o ON o.id = s."orderId"
    WHERE s."routeId" = NEW.id
      AND (
        o.status IS DISTINCT FROM 'PENDING'
        OR o."routeId" IS NOT NULL
        OR o."stopOrder" IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Route cancellation must restore all affected original orders to PENDING with null routeId and stopOrder'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS route_cancellation_order_restoration ON public.route;
CREATE CONSTRAINT TRIGGER route_cancellation_order_restoration
AFTER UPDATE OF status ON public.route
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.status = 'ASSIGNED' AND NEW.status = 'CANCELLED')
EXECUTE FUNCTION public.route_cancellation_order_restoration_guard();`,
          },
        ],
        postcheck: [
          {
            description:
              'all 6 updated route, stop, coherence, visit, claim, and reservation guard functions plus the deferred ASSIGNED->CANCELLED order-restoration constraint trigger reflect CANCELLED and CANCEL_ROUTE rules',
            sql: `SELECT (
              (SELECT position('CANCEL_ROUTE' in prosrc) > 0 AND position('OLD.status = ''ASSIGNED'' AND NEW.status = ''CANCELLED''' in prosrc) > 0 FROM pg_proc WHERE proname='route_integrity_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('CANCELLED' in prosrc) > 0 FROM pg_proc WHERE proname='route_stop_integrity_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('CANCEL_ROUTE' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_validate_route_coherence' AND pronamespace='public'::regnamespace)
              AND (SELECT position('CANCELLED' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_validate_stop_visit' AND pronamespace='public'::regnamespace)
              AND (SELECT position('CANCEL_ROUTE' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_claim_history_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('CANCEL_ROUTE' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_reservation_history_guard' AND pronamespace='public'::regnamespace)
              AND to_regprocedure('public.route_cancellation_order_restoration_guard()') IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgname = 'route_cancellation_order_restoration'
                  AND tgrelid = 'public.route'::regclass
                  AND tgenabled = 'O'
                  AND tgdeferrable
                  AND tginitdeferred
              )
            ) AS result`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
