#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452/contract';
import startContract from '../../snapshots/46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/c98b76b8c2f003d377fd1882031490290222be3a85b69a682ff58da04f9c590a/contract';
import endContract from '../../snapshots/c98b76b8c2f003d377fd1882031490290222be3a85b69a682ff58da04f9c590a/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  rawSql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createIndex({
        schema: 'public',
        table: 'route',
        index: 'one_in_progress_route_per_driver_8b94e85e',
        columns: ['driverId'],
        extras: { where: "(status = 'IN_PROGRESS')", unique: true },
      }),

      rawSql({
        id: 'route-lifecycle.integrity-guards',
        label:
          'Install row-locked route structure and append-only history guards',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', name: 'route_integrity_guard' },
        },
        precheck: [
          {
            description:
              'ensure these guard functions are not already installed',
            sql: "SELECT to_regprocedure('public.route_integrity_guard()') IS NULL AS result",
          },
        ],
        execute: [
          {
            description: 'install integrity functions and enabled triggers',
            sql: `
CREATE FUNCTION public.route_integrity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IS NULL OR OLD.status IN ('IN_PROGRESS', 'COMPLETED') THEN
      RAISE EXCEPTION 'Route structure is frozen or unverified legacy history' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NULL AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Unverified legacy route cannot be rewritten' USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'Route history identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('IN_PROGRESS', 'COMPLETED') AND
      (NEW."driverId", NEW."zoneId", NEW.date) IS DISTINCT FROM (OLD."driverId", OLD."zoneId", OLD.date) THEN
      RAISE EXCEPTION 'Route structure is frozen' USING ERRCODE = '23514';
    END IF;
    -- Irreversible freeze boundaries, not the complete service transition graph.
    IF OLD.status = 'COMPLETED' AND NEW.status IS DISTINCT FROM OLD.status OR
      OLD.status = 'IN_PROGRESS' AND NEW.status NOT IN ('IN_PROGRESS', 'COMPLETED') THEN
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
      (NEW."returnedAt", NEW."returnedById") IS DISTINCT FROM (OLD."returnedAt", OLD."returnedById") THEN
      RAISE EXCEPTION 'Recorded lifecycle event evidence is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (NEW."startedAt" IS NULL) <> (NEW."startedById" IS NULL) OR
     (NEW."completedAt" IS NULL) <> (NEW."completedById" IS NULL) OR
     (NEW."returnedAt" IS NULL) <> (NEW."returnedById" IS NULL) THEN
    RAISE EXCEPTION 'Lifecycle events require paired timestamps and actors' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS NULL AND (NEW."startedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL OR NEW."returnedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Unverified legacy route cannot invent events' USING ERRCODE = '23514';
  END IF;
  IF NEW."startedAt" IS NOT NULL AND NEW.status NOT IN ('IN_PROGRESS', 'COMPLETED') OR
    (NEW."completedAt" IS NOT NULL OR NEW."returnedAt" IS NOT NULL) AND NEW.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Recorded event is incompatible with lifecycle state' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'IN_PROGRESS' AND NEW."driverId" IS NULL THEN
    RAISE EXCEPTION 'IN_PROGRESS requires an assigned driver' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public."routeStop" s JOIN public."order" o ON o.id = s."orderId"
      WHERE s."routeId" = NEW.id AND (s."isLegacy" OR s.sequence IS NULL OR s.sequence NOT BETWEEN 1 AND 4 OR o."zoneId" <> NEW."zoneId")) THEN
      RAISE EXCEPTION 'Verified route requires valid nonlegacy sequence and same zone' USING ERRCODE = '23514';
    END IF;
    IF (SELECT COUNT(*) FROM public."routeStop" WHERE "routeId" = NEW.id) > 4 THEN
      RAISE EXCEPTION 'Route maximum is four stops' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.route_stop_integrity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
  -- Lock old and new parents in one deterministic order, sharing the start lock.
  FOR route_row IN SELECT id, status, "zoneId" FROM public.route
    WHERE id = ANY(route_ids) ORDER BY id FOR UPDATE LOOP
    IF route_row.status IS NULL THEN
      RAISE EXCEPTION 'Unverified legacy stop history cannot be rewritten' USING ERRCODE = '23514';
    END IF;
    IF structural AND route_row.status IN ('IN_PROGRESS', 'COMPLETED') THEN
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
  IF order_zone IS DISTINCT FROM destination_zone THEN
    RAISE EXCEPTION 'Route stop order must belong to the same zone' USING ERRCODE = '23514';
  END IF;
  IF (SELECT COUNT(*) FROM public."routeStop" WHERE "routeId" = NEW."routeId" AND (old_stop_id IS NULL OR id <> old_stop_id)) >= 4 THEN
    RAISE EXCEPTION 'Route maximum is four stops' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.route_history_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Route evidence is append-only' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER route_no_truncate BEFORE TRUNCATE ON public.route FOR EACH STATEMENT EXECUTE FUNCTION public.route_history_append_only();
CREATE TRIGGER route_stop_no_truncate BEFORE TRUNCATE ON public."routeStop" FOR EACH STATEMENT EXECUTE FUNCTION public.route_history_append_only();
CREATE TRIGGER route_integrity_guard BEFORE INSERT OR UPDATE OR DELETE ON public.route FOR EACH ROW EXECUTE FUNCTION public.route_integrity_guard();
CREATE TRIGGER route_stop_integrity_guard BEFORE INSERT OR UPDATE OR DELETE ON public."routeStop" FOR EACH ROW EXECUTE FUNCTION public.route_stop_integrity_guard();
CREATE TRIGGER delivery_attempt_append_only BEFORE UPDATE OR DELETE ON public."deliveryAttempt" FOR EACH ROW EXECUTE FUNCTION public.route_history_append_only();
CREATE TRIGGER delivery_attempt_no_truncate BEFORE TRUNCATE ON public."deliveryAttempt" FOR EACH STATEMENT EXECUTE FUNCTION public.route_history_append_only();
CREATE TRIGGER legacy_reconciliation_append_only BEFORE UPDATE OR DELETE ON public."legacyRouteReconciliation" FOR EACH ROW EXECUTE FUNCTION public.route_history_append_only();
CREATE TRIGGER legacy_reconciliation_no_truncate BEFORE TRUNCATE ON public."legacyRouteReconciliation" FOR EACH STATEMENT EXECUTE FUNCTION public.route_history_append_only();
`,
          },
        ],
        postcheck: [
          {
            description:
              'verify all eight integrity/history triggers exist and are enabled',
            sql: `SELECT COUNT(*) = 8 AS result FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgname IN ('route_no_truncate', 'route_stop_no_truncate', 'route_integrity_guard', 'route_stop_integrity_guard', 'delivery_attempt_append_only', 'delivery_attempt_no_truncate', 'legacy_reconciliation_append_only', 'legacy_reconciliation_no_truncate')`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
