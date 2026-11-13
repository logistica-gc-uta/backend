#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/b5cbec5e55f8808d4442a200be9ff3b6d62e770ea9021d18110262f36e544233/contract';
import endContract from '../../snapshots/b5cbec5e55f8808d4442a200be9ff3b6d62e770ea9021d18110262f36e544233/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e44d61fd753bd3404c42e85b9570cb95731fcf8b6f1659b4e254e2a4774adc70/contract';
import startContract from '../../snapshots/e44d61fd753bd3404c42e85b9570cb95731fcf8b6f1659b4e254e2a4774adc70/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  rawSql,
  col,
  fn,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_f083b472',
      }),
      this.createTable({
        schema: 'public',
        table: 'orderPickup',
        columns: [
          col('agreedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('agreedById', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('agreementRequestId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('confirmationRequestId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('confirmedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('confirmedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('orderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'order_pickup_confirmation_consistent_8d7d1769',
            '("confirmedAt" IS NULL AND "confirmedById" IS NULL AND "confirmationRequestId" IS NULL) OR ("confirmedAt" IS NOT NULL AND "confirmedById" IS NOT NULL AND "confirmationRequestId" IS NOT NULL AND "confirmedAt" >= "agreedAt")',
          ),
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'dispatchIntervention',
        constraint: 'dispatch_audit_valid_f0c6b073',
        expression:
          "action IN ('CONFIRM', 'REJECT', 'REORDER', 'MOVE', 'REASSIGN_DRIVER', 'PRIORITIZE', 'CONTACT', 'RESCHEDULE', 'PICKUP_AGREE', 'PICKUP_DECLINE', 'PICKUP_CONFIRM') AND outcome IN ('APPLIED', 'REJECTED', 'FAILED') AND length(trim(reason)) BETWEEN 1 AND 500",
      }),
      this.addUnique({
        schema: 'public',
        table: 'orderPickup',
        constraint: 'orderPickup_orderId_key',
        columns: ['orderId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'orderPickup',
        constraint: 'orderPickup_agreementRequestId_key',
        columns: ['agreementRequestId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'orderPickup',
        constraint: 'orderPickup_confirmationRequestId_key',
        columns: ['confirmationRequestId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderPickup',
        index: 'orderPickup_agreedById_idx_5e5a37b2',
        columns: ['agreedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderPickup',
        index: 'orderPickup_confirmedById_idx_bf02ea5f',
        columns: ['confirmedById'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderPickup',
        foreignKey: {
          name: 'orderPickup_orderId_fkey',
          columns: ['orderId'],
          references: { schema: 'public', table: 'order', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderPickup',
        foreignKey: {
          name: 'orderPickup_agreedById_fkey',
          columns: ['agreedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderPickup',
        foreignKey: {
          name: 'orderPickup_confirmedById_fkey',
          columns: ['confirmedById'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      rawSql({
        id: 'dispatch.store-pickup-guards',
        label: 'Allow audited store-pickup resolutions of failed orders (#50)',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { objectType: 'table', schema: 'public', name: 'order' },
        },
        precheck: [
          {
            description: 'require the agreement guards installed by the failed order migration',
            sql: "SELECT to_regprocedure('public.dispatch_review_resolution_guard()') IS NOT NULL AS result",
          },
        ],
        execute: [
          {
            description:
              'extend the two guards so an audited PICKUP_AGREE / PICKUP_CONFIRM is a valid resolution, keeping every other restriction',
            sql: `CREATE OR REPLACE FUNCTION public.t1e_validate_stop_visit(p_stop_id text) RETURNS void
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
    WHERE a.action IN ('RESCHEDULE', 'PICKUP_AGREE') AND a.outcome = 'APPLIED' AND a."orderId" = stop_row."orderId"
      AND d."stopId" = stop_row.id AND d.outcome = 'FAILED' AND route_row.status = 'COMPLETED'
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
    RAISE EXCEPTION 'Order claim may be released only at valid completion or pre-start draft stop removal'
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
  ) AND NOT EXISTS (
    -- #50 PICKUP_AGREE: auditado en esta misma transacción, con un retiro creado por ese acuerdo y un intento fallido
    -- de una ruta terminada. El pedido sigue pendiente de gestión (la marca se conserva), sin ruta ni reserva.
    SELECT 1 FROM public."dispatchIntervention" a
    JOIN public."orderPickup" p ON p."orderId" = a."orderId" AND p."agreementRequestId" = a."requestId"
    JOIN public."deliveryAttempt" d ON d.id = a.payload::jsonb ->> 'attemptId'
    JOIN public."routeStop" st ON st.id = d."stopId"
    JOIN public.route r ON r.id = st."routeId"
    WHERE a.action = 'PICKUP_AGREE' AND a.outcome = 'APPLIED' AND a."orderId" = OLD.id
      AND a.xmin = pg_current_xact_id()::text::xid
      AND p."confirmedAt" IS NULL
      AND st."orderId" = OLD.id AND d.outcome = 'FAILED' AND r.status = 'COMPLETED'
      AND NEW.status = 'PENDING' AND NEW."requiresAdministrativeReview" AND NEW."routeId" IS NULL AND NEW."stopOrder" IS NULL
      AND (NEW."scheduledDeliveryDate", NEW."deliveryWindowStart", NEW."deliveryWindowEnd")
        IS NOT DISTINCT FROM (OLD."scheduledDeliveryDate", OLD."deliveryWindowStart", OLD."deliveryWindowEnd")
      AND NOT EXISTS (SELECT 1 FROM public."orderClaim" WHERE "orderId" = OLD.id AND "releasedAt" IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM public."deliveryAttempt" later JOIN public."routeStop" lst ON lst.id = later."stopId"
        WHERE lst."orderId" = OLD.id AND later.outcome = 'FAILED' AND (later."recordedAt", later.id) > (d."recordedAt", d.id)
      )
  ) AND NOT EXISTS (
    -- #50 PICKUP_CONFIRM: solo el retiro físico confirmado (actor y momento) entrega el pedido y limpia la gestión pendiente.
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
  ) THEN
    RAISE EXCEPTION 'Failed order requires an explicit persisted agreement and audited resolution after completion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;`,
          },
        ],
        postcheck: [
          {
            description: 'the guards accept the audited pickup resolutions and the agreement trigger stays enabled on order',
            sql: `SELECT (
              EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='dispatch_review_resolution' AND tgenabled='O' AND tgrelid='public.order'::regclass)
              AND (SELECT position('PICKUP_AGREE' in prosrc) > 0 AND position('PICKUP_CONFIRM' in prosrc) > 0 FROM pg_proc WHERE proname='dispatch_review_resolution_guard' AND pronamespace='public'::regnamespace)
              AND (SELECT position('PICKUP_AGREE' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_validate_stop_visit' AND pronamespace='public'::regnamespace)
              AND (SELECT position('PICKUP_AGREE' in prosrc) > 0 FROM pg_proc WHERE proname='t1e_claim_history_guard' AND pronamespace='public'::regnamespace)
            ) AS result`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
