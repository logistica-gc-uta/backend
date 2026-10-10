#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/15ef5b17c1444e1f37222de1c696766119c6c4494633f6c5fcb256dee13cba83/contract';
import endContract from '../../snapshots/15ef5b17c1444e1f37222de1c696766119c6c4494633f6c5fcb256dee13cba83/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/c98b76b8c2f003d377fd1882031490290222be3a85b69a682ff58da04f9c590a/contract';
import startContract from '../../snapshots/c98b76b8c2f003d377fd1882031490290222be3a85b69a682ff58da04f9c590a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({
        id: 'route-lifecycle.coherence-guards',
        label:
          'Install deferred lifecycle coherence and insert-time audit guards',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', name: 'route_lifecycle_coherence_guard' },
        },
        precheck: [
          {
            description:
              'fail closed when existing routes have duplicate active reservations',
            sql: `SELECT NOT EXISTS (
  SELECT 1 FROM public."driverReservation"
  WHERE "releasedAt" IS NULL
  GROUP BY "routeId" HAVING COUNT(*) > 1
) AS result`,
          },
          {
            description:
              'fail closed when existing routes have duplicate reconciliation audits',
            sql: `SELECT NOT EXISTS (
  SELECT 1 FROM public."legacyRouteReconciliation"
  GROUP BY "routeId" HAVING COUNT(*) > 1
) AS result`,
          },
          {
            description:
              'ensure these coherence functions are not already installed',
            sql: "SELECT to_regprocedure('public.t1e_validate_route_coherence(text)') IS NULL AS result",
          },
        ],
        execute: [
          {
            description:
              'install row-locked route, visit, claim, and hold consistency checks',
            sql: `
CREATE FUNCTION public.t1e_validate_route_coherence(p_route_id text) RETURNS void
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
  ELSIF route_row.status = 'COMPLETED' THEN
    IF active_claim_count <> 0 THEN
      RAISE EXCEPTION 'COMPLETED route cannot retain active order claims'
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
        RAISE EXCEPTION 'Completed route remains held until one matching physical-return reservation is released'
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

CREATE FUNCTION public.t1e_validate_stop_visit(p_stop_id text) RETURNS void
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
  IF stop_row.outcome = 'FAILED' AND NOT order_row."requiresAdministrativeReview" THEN
    RAISE EXCEPTION 'Failed visit requires current administrative review flag'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION public.t1e_attempt_capture_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  route_row public.route%ROWTYPE;
  stop_row public."routeStop"%ROWTYPE;
  order_row public."order"%ROWTYPE;
BEGIN
  SELECT * INTO stop_row FROM public."routeStop" WHERE id = NEW."stopId";
  IF NOT FOUND OR stop_row."isLegacy" OR stop_row.sequence IS NULL THEN
    RAISE EXCEPTION 'Delivery attempt requires a stable verified route stop'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO route_row FROM public.route WHERE id = stop_row."routeId";
  IF NOT FOUND OR route_row.status <> 'IN_PROGRESS' OR
     route_row."startedAt" IS NULL OR route_row."driverId" <> NEW."driverId" OR
     NEW."recordedAt" < route_row."startedAt" OR
     NEW."recordedAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'Delivery attempt requires the current route driver and a valid in-progress lifecycle time'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO order_row FROM public."order" WHERE id = stop_row."orderId";
  IF NEW.outcome = 'FAILED' AND order_row.status IN ('DELIVERED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Failed visit cannot manufacture a delivered or cancelled order'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.t1e_route_constraint_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  old_row jsonb := '{}'::jsonb;
  new_row jsonb := '{}'::jsonb;
  route_ids text[];
  route_key text;
  stop_key text;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'deliveryAttempt' THEN
    stop_key := COALESCE(new_row ->> 'stopId', old_row ->> 'stopId');
    PERFORM public.t1e_validate_stop_visit(stop_key);
    RETURN NULL;
  ELSIF TG_TABLE_NAME = 'routeStop' THEN
    stop_key := COALESCE(new_row ->> 'id', old_row ->> 'id');
    PERFORM public.t1e_validate_stop_visit(stop_key);
    route_ids := ARRAY(SELECT DISTINCT value FROM unnest(ARRAY[
      old_row ->> 'routeId', new_row ->> 'routeId'
    ]) AS value WHERE value IS NOT NULL ORDER BY value);
  ELSIF TG_TABLE_NAME = 'route' THEN
    route_ids := ARRAY(SELECT DISTINCT value FROM unnest(ARRAY[
      old_row ->> 'id', new_row ->> 'id'
    ]) AS value WHERE value IS NOT NULL ORDER BY value);
  ELSIF TG_TABLE_NAME = 'order' THEN
    route_ids := ARRAY(SELECT DISTINCT value FROM unnest(ARRAY[
      old_row ->> 'routeId', new_row ->> 'routeId'
    ]) AS value WHERE value IS NOT NULL ORDER BY value);
  ELSE
    route_ids := ARRAY(SELECT DISTINCT value FROM unnest(ARRAY[
      old_row ->> 'routeId', new_row ->> 'routeId'
    ]) AS value WHERE value IS NOT NULL ORDER BY value);
  END IF;
  FOREACH route_key IN ARRAY route_ids LOOP
    PERFORM public.t1e_validate_route_coherence(route_key);
  END LOOP;
  RETURN NULL;
END $$;

CREATE FUNCTION public.t1e_claim_history_guard() RETURNS trigger
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
    RAISE EXCEPTION 'Order claim may be released only at valid completion or pre-start draft stop removal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.t1e_reservation_history_guard() RETURNS trigger
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
    RAISE EXCEPTION 'Verified driver reservation may be released only at physical return'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.t1e_reconciliation_admin_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  actor_role text;
BEGIN
  SELECT role::text INTO actor_role FROM public."user"
  WHERE id = NEW."administratorId"
  FOR SHARE;
  IF actor_role IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'Legacy reconciliation requires a current ADMIN authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.t1e_legacy_release_audit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  route_status text;
BEGIN
  IF OLD."releasedAt" IS NULL AND NEW."releasedAt" IS NOT NULL THEN
    SELECT status::text INTO route_status FROM public.route WHERE id = NEW."routeId";
    IF route_status IS NULL AND NOT EXISTS (
      SELECT 1 FROM public."legacyRouteReconciliation" a
      WHERE a."routeId" = NEW."routeId"
        AND a."releaseDriverHold"
        AND a."recordedAt" = NEW."releasedAt"
    ) THEN
      RAISE EXCEPTION 'Legacy driver hold release requires its matching route reconciliation audit'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER t1e_delivery_attempt_capture
BEFORE INSERT ON public."deliveryAttempt"
FOR EACH ROW EXECUTE FUNCTION public.t1e_attempt_capture_guard();

CREATE TRIGGER t1e_order_claim_history
BEFORE UPDATE OR DELETE ON public."orderClaim"
FOR EACH ROW EXECUTE FUNCTION public.t1e_claim_history_guard();

CREATE TRIGGER t1e_driver_reservation_history
BEFORE UPDATE OR DELETE ON public."driverReservation"
FOR EACH ROW EXECUTE FUNCTION public.t1e_reservation_history_guard();

CREATE TRIGGER t1e_reconciliation_admin
BEFORE INSERT ON public."legacyRouteReconciliation"
FOR EACH ROW EXECUTE FUNCTION public.t1e_reconciliation_admin_guard();

CREATE CONSTRAINT TRIGGER t1e_route_coherence
AFTER INSERT OR UPDATE ON public.route
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.t1e_route_constraint_guard();

CREATE CONSTRAINT TRIGGER t1e_stop_coherence
AFTER INSERT OR UPDATE OR DELETE ON public."routeStop"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.t1e_route_constraint_guard();

CREATE CONSTRAINT TRIGGER t1e_claim_coherence
AFTER INSERT OR UPDATE OR DELETE ON public."orderClaim"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.t1e_route_constraint_guard();

CREATE CONSTRAINT TRIGGER t1e_reservation_coherence
AFTER INSERT OR UPDATE OR DELETE ON public."driverReservation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.t1e_route_constraint_guard();

CREATE CONSTRAINT TRIGGER t1e_reconciliation_coherence
AFTER INSERT ON public."legacyRouteReconciliation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.t1e_route_constraint_guard();

CREATE CONSTRAINT TRIGGER t1e_order_route_pointer_coherence
AFTER UPDATE OF "routeId" ON public."order"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.t1e_route_constraint_guard();

CREATE CONSTRAINT TRIGGER t1e_attempt_coherence
AFTER INSERT ON public."deliveryAttempt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.t1e_route_constraint_guard();

CREATE CONSTRAINT TRIGGER t1e_reservation_legacy_release_audit
AFTER UPDATE OF "releasedAt" ON public."driverReservation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.t1e_legacy_release_audit_guard();
`,
          },
        ],
        postcheck: [
          {
            description:
              "verify all twelve coherence triggers exist and are enabled",
            sql: `SELECT COUNT(*) = 12 AS result FROM pg_trigger WHERE tgenabled = 'O' AND tgname IN (
              't1e_delivery_attempt_capture',
              't1e_order_claim_history',
              't1e_driver_reservation_history',
              't1e_reconciliation_admin',
              't1e_route_coherence',
              't1e_stop_coherence',
              't1e_claim_coherence',
              't1e_reservation_coherence',
              't1e_reconciliation_coherence',
              't1e_order_route_pointer_coherence',
              't1e_attempt_coherence',
              't1e_reservation_legacy_release_audit'
            )`,
          },
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'deliveryAttempt',
        constraint: 'delivery_attempt_failure_reason_pairing_2c593598',
        expression:
          '(outcome = \'FAILED\' AND "failureReason" IS NOT NULL) OR (outcome = \'SUCCESSFUL\' AND "failureReason" IS NULL)',
      }),
      this.createIndex({
        schema: 'public',
        table: 'driverReservation',
        index: 'one_active_reservation_per_route_b3e558e7',
        columns: ['routeId'],
        extras: { where: '("releasedAt" IS NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'legacyRouteReconciliation',
        index: 'one_reconciliation_per_route_37762cb4',
        columns: ['routeId'],
        extras: { unique: true },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
