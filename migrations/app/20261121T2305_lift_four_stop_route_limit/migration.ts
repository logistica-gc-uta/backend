#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/26b9ce897d81c1659e885bf4417cfcfda96d2a33bc6fa69a24ed74be8788a332/contract';
import startContract from '../../snapshots/26b9ce897d81c1659e885bf4417cfcfda96d2a33bc6fa69a24ed74be8788a332/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/5c8e1dbf367275ce7a022e294fe648c04bfa2b3e53d2e55a499fce569a77212c/contract';
import endContract from '../../snapshots/5c8e1dbf367275ce7a022e294fe648c04bfa2b3e53d2e55a499fce569a77212c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addCheckConstraint({
        schema: 'public',
        table: 'routeStop',
        constraint: 'route_stop_sequence_positive_592b3570',
        expression: '"isLegacy" OR "sequence" IS NULL OR "sequence" >= 1',
      }),
      rawSql({
        id: 'route-stops.lift-four-stop-limit',
        label:
          'Lift legacy 4-stop ceiling in route_integrity_guard, route_stop_integrity_guard, and t1e_validate_route_coherence while keeping sequence >= 1',
        operationClass: 'widening',
        target: {
          id: 'postgres',
          details: { objectType: 'table', schema: 'public', name: 'route' },
        },
        precheck: [
          {
            description:
              'require route_integrity_guard, route_stop_integrity_guard, and t1e_validate_route_coherence before updating them',
            sql: `SELECT (
              to_regprocedure('public.route_integrity_guard()') IS NOT NULL
              AND to_regprocedure('public.route_stop_integrity_guard()') IS NOT NULL
              AND to_regprocedure('public.t1e_validate_route_coherence(text)') IS NOT NULL
            ) AS result`,
          },
        ],
        execute: [
          {
            description:
              'update route_integrity_guard, route_stop_integrity_guard, and t1e_validate_route_coherence to allow >= 1 stops without a 4-stop ceiling',
            sql: `CREATE OR REPLACE FUNCTION public.route_integrity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $
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
      WHERE s."routeId" = NEW.id AND (s."isLegacy" OR s.sequence IS NULL OR s.sequence < 1
        OR (NEW."zoneId" IS NOT NULL AND o."zoneId" IS NOT NULL AND o."zoneId" IS DISTINCT FROM NEW."zoneId"))) THEN
      RAISE EXCEPTION 'Verified route requires valid nonlegacy sequence and same zone' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $;

CREATE OR REPLACE FUNCTION public.route_stop_integrity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $
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
  IF NEW."isLegacy" OR NEW.sequence IS NULL OR NEW.sequence < 1 THEN
    RAISE EXCEPTION 'Verified stop requires nonlegacy sequence >= 1' USING ERRCODE = '23514';
  END IF;
  SELECT "zoneId" INTO order_zone FROM public."order" WHERE id = NEW."orderId" FOR SHARE;
  IF destination_zone IS NOT NULL AND order_zone IS NOT NULL AND order_zone IS DISTINCT FROM destination_zone THEN
    RAISE EXCEPTION 'Route stop order must belong to the same zone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $;

CREATE OR REPLACE FUNCTION public.t1e_validate_route_coherence(p_route_id text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $
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
    IF stop_count < 1 THEN
      RAISE EXCEPTION 'Cancelled route must preserve at least one original stop'
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
END $;`,
          },
        ],
        postcheck: [
          {
            description:
              'route_integrity_guard, route_stop_integrity_guard, and t1e_validate_route_coherence allow >= 1 stops without a 4-stop ceiling',
            sql: `SELECT (
              (SELECT position('BETWEEN 1 AND 4' in prosrc) = 0 AND position('Route maximum is four stops' in prosrc) = 0 AND position('s.sequence < 1' in prosrc) > 0 FROM pg_proc WHERE proname='route_integrity_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('BETWEEN 1 AND 4' in prosrc) = 0 AND position('Route maximum is four stops' in prosrc) = 0 AND position('NEW.sequence < 1' in prosrc) > 0 FROM pg_proc WHERE proname='route_stop_integrity_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('stop_count > 4' in prosrc) = 0 AND position('stop_count < 1' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_validate_route_coherence' AND pronamespace='public'::regnamespace)
            ) AS result`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
