#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/55eb8b3cd0f8ace944fb2e16f794a7bbdd3b6c39ed43431fa6154c8f800da189/contract';
import endContract from '../../snapshots/55eb8b3cd0f8ace944fb2e16f794a7bbdd3b6c39ed43431fa6154c8f800da189/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/5c8e1dbf367275ce7a022e294fe648c04bfa2b3e53d2e55a499fce569a77212c/contract';
import startContract from '../../snapshots/5c8e1dbf367275ce7a022e294fe648c04bfa2b3e53d2e55a499fce569a77212c/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'active_order_item_loss_unit_2b134a02',
      }),
      this.addColumn({
        schema: 'public',
        table: 'orderItemLoss',
        column: col('emergencyId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'active_order_item_loss_emergency_unit_5034e1e7',
        columns: ['emergencyId', 'orderItemId', 'unitNumber'],
        extras: { where: '("cancelledAt" IS NULL AND "emergencyId" IS NOT NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'active_order_item_loss_unit_151ab58d',
        columns: ['orderItemId', 'unitNumber'],
        extras: { where: '("cancelledAt" IS NULL AND "emergencyId" IS NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'orderItemLoss',
        index: 'orderItemLoss_emergencyId_idx_ced4adec',
        columns: ['emergencyId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orderItemLoss',
        foreignKey: {
          name: 'orderItemLoss_emergencyId_fkey',
          columns: ['emergencyId'],
          references: { schema: 'public', table: 'routeEmergency', columns: ['id'] },
        },
      }),
      rawSql({
        id: 'dispatch-review-guard.scope-emergency-recovery',
        label: 'Scope dispatch_review_resolution_guard emergency recovery and loss checks by emergencyId',
        operationClass: 'widening',
        target: {
          id: 'postgres',
          details: {
            objectType: 'table',
            schema: 'public',
            name: 'order',
          },
        },
        precheck: [
          {
            description: 'require dispatch_review_resolution_guard before replacing it',
            sql: `SELECT to_regprocedure('public.dispatch_review_resolution_guard()') IS NOT NULL AS result`,
          },
        ],
        execute: [
          {
            description:
              'update dispatch_review_resolution_guard so EMERGENCY_REQUEUE and loss matching are isolated per emergency',
            sql: `CREATE OR REPLACE FUNCTION public.dispatch_review_resolution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."requiresAdministrativeReview" AND (
    NOT NEW."requiresAdministrativeReview" OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('DELIVERED','CANCELLED','PENDING')) OR
    (NEW."scheduledDeliveryDate", NEW."deliveryWindowStart", NEW."deliveryWindowEnd", NEW."routeId")
    IS DISTINCT FROM (OLD."scheduledDeliveryDate", OLD."deliveryWindowStart", OLD."deliveryWindowEnd", OLD."routeId")
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public."routeUnitRecovery" u
      JOIN public."routeEmergency" ue ON ue.id = u."emergencyId"
      WHERE u."orderId" = OLD.id
        AND (
          NOT EXISTS (
            SELECT 1 FROM public."dispatchIntervention" rq
            WHERE rq.action = 'EMERGENCY_REQUEUE'
              AND rq.outcome = 'APPLIED'
              AND rq."orderId" = OLD.id
              AND rq.xmin = pg_current_xact_id()::text::xid
          )
          OR u."emergencyId" = (
            SELECT rq.payload::jsonb ->> 'emergencyId'
            FROM public."dispatchIntervention" rq
            WHERE rq.action = 'EMERGENCY_REQUEUE'
              AND rq.outcome = 'APPLIED'
              AND rq."orderId" = OLD.id
              AND rq.xmin = pg_current_xact_id()::text::xid
            LIMIT 1
          )
        )
        AND u."recoveredAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public."orderItemLoss" l
          WHERE l."orderItemId" = u."orderItemId"
            AND l."unitNumber" = u."unitNumber"
            AND l."cancelledAt" IS NULL
            AND l."replacementPreparedAt" IS NOT NULL
            AND (
              (l."emergencyId" IS NOT NULL AND l."emergencyId" = u."emergencyId")
              OR (l."emergencyId" IS NULL AND l."declaredAt" >= ue."declaredAt")
            )
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
END $$;`,
          },
        ],
        postcheck: [
          {
            description: 'dispatch_review_resolution_guard checks emergency-scoped losses and EMERGENCY_REQUEUE isolation',
            sql: `SELECT (position('l."emergencyId" = u."emergencyId"' in prosrc) > 0) AS result FROM pg_proc WHERE proname='dispatch_review_resolution_guard' AND pronamespace='public'::regnamespace`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
