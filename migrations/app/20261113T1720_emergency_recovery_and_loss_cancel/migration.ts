#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/1749c53799fc77a70513636955c4c1b5a1668789c3d6dcb5017d4647b1ab9677/contract';
import startContract from '../../snapshots/1749c53799fc77a70513636955c4c1b5a1668789c3d6dcb5017d4647b1ab9677/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/defd240814f2524f7af9bf379253487edc9887ac231ea845a81baa9c7f768009/contract';
import endContract from '../../snapshots/defd240814f2524f7af9bf379253487edc9887ac231ea845a81baa9c7f768009/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  primaryKey,
  rawSql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_3cf23df8',
      }),
      this.dropConstraint({
        schema: 'public',
        table: 'orderItemLoss',
        constraint: 'orderItemLoss_orderItemId_unitNumber_key',
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'productStockMovement',
        constraint: 'product_stock_movement_valid_50f99fc3',
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'route',
        constraint: 'route_status_check_16cb52d8',
      }),
      this.createTable({
        schema: 'public',
        table: 'routeEmergency',
        columns: [
          col('closeReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('closeRequestId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('closedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('closedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('declarationRequestId', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('declaredAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('declaredById', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reason', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('routeId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'route_emergency_closure_consistent_faa95e7a',
            '("closedAt" IS NULL AND "closedById" IS NULL AND "closeReason" IS NULL AND "closeRequestId" IS NULL) OR ("closedAt" IS NOT NULL AND "closedById" IS NOT NULL AND "closeReason" IS NOT NULL AND length(trim("closeReason")) BETWEEN 1 AND 500 AND "closeRequestId" IS NOT NULL AND "closedAt" >= "declaredAt")',
          ),
          checkExpression(
            'route_emergency_reason_valid_1db11f3d',
            'length(trim(reason)) BETWEEN 1 AND 500',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'routeUnitRecovery',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('emergencyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orderItemId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('productId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('recoveredAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('recoveredById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('recoveryRequestId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('routeId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('stopId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('unitNumber', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'route_unit_recovery_consistent_7b99d583',
            '("recoveredAt" IS NULL AND "recoveredById" IS NULL AND "recoveryRequestId" IS NULL) OR ("recoveredAt" IS NOT NULL AND "recoveredById" IS NOT NULL AND "recoveryRequestId" IS NOT NULL)',
          ),
          checkExpression('route_unit_recovery_unit_positive_861d7482', '"unitNumber" >= 1'),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'orderItemLoss',
        column: col('cancelReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'orderItemLoss',
        column: col('cancelRequestId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'orderItemLoss',
        column: col('cancelledAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'orderItemLoss',
        column: col('cancelledById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_11fbfe53',
        expression:
          "action IN ('CONFIRM', 'REJECT', 'REORDER', 'MOVE', 'REASSIGN_DRIVER', 'PRIORITIZE', 'CONTACT', 'RESCHEDULE', 'PICKUP_AGREE', 'PICKUP_DECLINE', 'PICKUP_CONFIRM', 'RELEASE_DRAFT', 'LOSS_DECLARE', 'REPLACEMENT_PREPARE', 'ORIGINAL_RECOVER', 'LOSS_CANCEL', 'EMERGENCY_DECLARE', 'UNIT_RECOVERY_CONFIRM', 'EMERGENCY_CLOSE', 'EMERGENCY_DRIVER_RELEASE', 'EMERGENCY_REQUEUE') AND outcome IN ('APPLIED', 'REJECTED', 'FAILED') AND length(trim(reason)) BETWEEN 1 AND 500",
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'orderItemLoss',
        constraint: 'order_item_loss_cancellation_consistent_1c788b6a',
        expression:
          '("cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancelReason" IS NULL AND "cancelRequestId" IS NULL) OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(trim("cancelReason")) BETWEEN 1 AND 500 AND "cancelRequestId" IS NOT NULL AND "cancelledAt" >= "declaredAt" AND "recoveredAt" IS NULL)',
      }),
      this.addUnique({
        schema: 'public',
        table: 'orderItemLoss',
        constraint: 'orderItemLoss_cancelRequestId_key',
        columns: ['cancelRequestId'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'productStockMovement',
        constraint: 'product_stock_movement_valid_22f76b30',
        expression:
          "(kind = 'REPLACEMENT_OUT' AND delta = -1) OR (kind = 'RECOVERY_IN' AND delta = 1) OR (kind = 'REPLACEMENT_CANCEL_IN' AND delta = 1)",
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'route',
        constraint: 'route_status_check_736c4cf9',
        expression:
          "\"status\" IN ('DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'INTERRUPTED')",
      }),
      this.addUnique({
        schema: 'public',
        table: 'routeEmergency',
        constraint: 'routeEmergency_routeId_key',
        columns: ['routeId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'routeEmergency',
        constraint: 'routeEmergency_declarationRequestId_key',
        columns: ['declarationRequestId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'routeEmergency',
        constraint: 'routeEmergency_closeRequestId_key',
        columns: ['closeRequestId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'routeUnitRecovery',
        constraint: 'routeUnitRecovery_recoveryRequestId_key',
        columns: ['recoveryRequestId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'routeUnitRecovery',
        constraint: 'routeUnitRecovery_emergencyId_orderItemId_unitNumber_key',
        columns: ['emergencyId', 'orderItemId', 'unitNumber'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'active_order_item_loss_unit_2b134a02',
        columns: ['orderItemId', 'unitNumber'],
        extras: { where: '("cancelledAt" IS NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'orderItemLoss_cancelledById_idx_03ce7bea',
        columns: ['cancelledById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeEmergency',
        index: 'routeEmergency_closedById_idx_3fbe6e44',
        columns: ['closedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeEmergency',
        index: 'routeEmergency_declaredById_idx_dd0c7dda',
        columns: ['declaredById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeUnitRecovery',
        index: 'routeUnitRecovery_emergencyId_idx_ced4adec',
        columns: ['emergencyId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeUnitRecovery',
        index: 'routeUnitRecovery_orderId_idx_d284871b',
        columns: ['orderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeUnitRecovery',
        index: 'routeUnitRecovery_orderItemId_idx_99e2d9f7',
        columns: ['orderItemId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeUnitRecovery',
        index: 'routeUnitRecovery_productId_idx_5858600a',
        columns: ['productId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeUnitRecovery',
        index: 'routeUnitRecovery_recoveredById_idx_2e510b5c',
        columns: ['recoveredById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeUnitRecovery',
        index: 'routeUnitRecovery_routeId_idx_91ae2fd6',
        columns: ['routeId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'routeUnitRecovery',
        index: 'routeUnitRecovery_stopId_idx_8804d4e7',
        columns: ['stopId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderItemLoss',
        foreignKey: {
          name: 'orderItemLoss_cancelledById_fkey',
          columns: ['cancelledById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeEmergency',
        foreignKey: {
          name: 'routeEmergency_routeId_fkey',
          columns: ['routeId'],
          references: { schema: 'public', table: 'route', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeEmergency',
        foreignKey: {
          name: 'routeEmergency_declaredById_fkey',
          columns: ['declaredById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeEmergency',
        foreignKey: {
          name: 'routeEmergency_closedById_fkey',
          columns: ['closedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeUnitRecovery',
        foreignKey: {
          name: 'routeUnitRecovery_emergencyId_fkey',
          columns: ['emergencyId'],
          references: { schema: 'public', table: 'routeEmergency', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeUnitRecovery',
        foreignKey: {
          name: 'routeUnitRecovery_routeId_fkey',
          columns: ['routeId'],
          references: { schema: 'public', table: 'route', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeUnitRecovery',
        foreignKey: {
          name: 'routeUnitRecovery_stopId_fkey',
          columns: ['stopId'],
          references: { schema: 'public', table: 'routeStop', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeUnitRecovery',
        foreignKey: {
          name: 'routeUnitRecovery_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeUnitRecovery',
        foreignKey: {
          name: 'routeUnitRecovery_orderItemId_fkey',
          columns: ['orderItemId'],
          references: { schema: 'public', table: 'orderItem', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeUnitRecovery',
        foreignKey: {
          name: 'routeUnitRecovery_productId_fkey',
          columns: ['productId'],
          references: { schema: 'public', table: 'product', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'routeUnitRecovery',
        foreignKey: {
          name: 'routeUnitRecovery_recoveredById_fkey',
          columns: ['recoveredById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      rawSql({
        id: 'route-emergency-recovery.coherence-and-resolution-guards',
        label:
          'Widen route, stop, claim, reservation, and dispatch review guards for INTERRUPTED routes and unit recovery blocks',
        operationClass: 'widening',
        target: {
          id: 'postgres',
          details: { objectType: 'table', schema: 'public', name: 'route' },
        },
        precheck: [
          {
            description:
              'require lifecycle coherence and review resolution functions before replacing them',
            sql: `SELECT (
              to_regprocedure('public.route_integrity_guard()') IS NOT NULL
              AND to_regprocedure('public.route_stop_integrity_guard()') IS NOT NULL
              AND to_regprocedure('public.t1e_validate_route_coherence(text)') IS NOT NULL
              AND to_regprocedure('public.t1e_validate_stop_visit(text)') IS NOT NULL
              AND to_regprocedure('public.t1e_claim_history_guard()') IS NOT NULL
              AND to_regprocedure('public.t1e_reservation_history_guard()') IS NOT NULL
              AND to_regprocedure('public.dispatch_review_resolution_guard()') IS NOT NULL
            ) AS result`,
          },
        ],
        execute: [
          {
            description:
              'update route, stop, coherence, visit, claim, reservation, and review guards to enforce #51 emergency recovery invariants alongside #49/#50/#52',
            sql: `CREATE OR REPLACE FUNCTION public.route_integrity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IS NULL OR OLD.status IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') THEN
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
    IF OLD.status IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') AND
      (NEW."driverId", NEW."zoneId", NEW.date) IS DISTINCT FROM (OLD."driverId", OLD."zoneId", OLD.date) THEN
      RAISE EXCEPTION 'Route structure is frozen' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('COMPLETED', 'INTERRUPTED') AND NEW.status IS DISTINCT FROM OLD.status OR
      OLD.status = 'IN_PROGRESS' AND NEW.status NOT IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') THEN
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
  IF NEW."startedAt" IS NOT NULL AND NEW.status NOT IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') OR
    NEW."completedAt" IS NOT NULL AND NEW.status <> 'COMPLETED' OR
    NEW."returnedAt" IS NOT NULL AND NEW.status NOT IN ('COMPLETED', 'INTERRUPTED') THEN
    RAISE EXCEPTION 'Recorded event is incompatible with lifecycle state' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('IN_PROGRESS', 'INTERRUPTED') AND NEW."driverId" IS NULL THEN
    RAISE EXCEPTION 'IN_PROGRESS or INTERRUPTED requires an assigned driver' USING ERRCODE = '23514';
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
    IF structural AND route_row.status IN ('IN_PROGRESS', 'COMPLETED', 'INTERRUPTED') THEN
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
    RAISE EXCEPTION 'Order claim may be released only at valid completion, emergency declaration, or pre-start stop removal'
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
    IF route_status IN ('COMPLETED', 'INTERRUPTED') AND returned_at = NEW."releasedAt" THEN
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
      -- Allow only PICKUP_CONFIRM? No: #51/#50 blocks order recovery/reschedule/pickup while units remain unrecovered/unprepared!
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
        AND st."orderId" = OLD.id AND d.outcome = 'FAILED' AND r.status IN ('COMPLETED', 'INTERRUPTED')
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
        AND st."orderId" = OLD.id AND d.outcome = 'FAILED' AND r.status IN ('COMPLETED', 'INTERRUPTED')
        AND NEW.status = 'PENDING' AND NEW."requiresAdministrativeReview" AND NEW."routeId" IS NULL AND NEW."stopOrder" IS NULL
        AND (NEW."scheduledDeliveryDate", NEW."deliveryWindowStart", NEW."deliveryWindowEnd")
          IS NOT DISTINCT FROM (OLD."scheduledDeliveryDate", OLD."deliveryWindowStart", OLD."deliveryWindowEnd")
        AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
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
        AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM public."deliveryAttempt" later JOIN public."routeStop" lst ON lst.id = later."stopId"
          WHERE lst."orderId" = OLD.id AND later.outcome = 'FAILED' AND later."recordedAt" >= e."declaredAt"
        )
    ) THEN
      RAISE EXCEPTION 'Failed or emergency order requires an explicit persisted resolution after completion or recovery' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;`,
          },
        ],
        postcheck: [
          {
            description:
              'all 7 updated route, stop, visit, claim, reservation, and dispatch review guard functions reflect INTERRUPTED and EMERGENCY_REQUEUE rules',
            sql: `SELECT (
              (SELECT position('INTERRUPTED' in prosrc) > 0 FROM pg_proc WHERE proname='route_integrity_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('INTERRUPTED' in prosrc) > 0 FROM pg_proc WHERE proname='route_stop_integrity_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('INTERRUPTED' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_validate_route_coherence' AND pronamespace='public'::regnamespace)
              AND (SELECT position('INTERRUPTED' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_validate_stop_visit' AND pronamespace='public'::regnamespace)
              AND (SELECT position('EMERGENCY_DECLARE' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_claim_history_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('INTERRUPTED' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_reservation_history_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('EMERGENCY_REQUEUE' in prosrc) > 0 FROM pg_proc WHERE proname='dispatch_review_resolution_guard' AND pronamespace='public'::regnamespace)
            ) AS result`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
