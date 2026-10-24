import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { shopError } from '../shop-http.filter.js';
import {
  CheckoutAttemptStatusDto,
  CheckoutAttemptStatusType,
} from './dto/checkout-attempt-status.dto.js';
import { toIsoTimestamp } from '../settings/shop-settings.service.js';

interface RawAttemptQueryRow {
  id: string;
  userId: string;
  idempotencyKey: string;
  status: string;
  orderId: string | null;
  receiptId: string | null;
  errorCode: string | null;
  updatedAt: unknown;
  createdAt?: unknown;
}

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class CheckoutAttemptService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Internal bounded stale reconciler (MD 10.3 / CI-SHOP-001 v1.2 S12):
   * Inspects DB clock + conservative staleness (15 min) + pg_try_advisory_xact_lock
   * in the exact same 'checkout_intent' namespace to prove no active business Tx is running.
   * If lock acquired and attempt is still PROCESSING, marks attempt FAILED with safe
   * INTERNAL_ERROR. No stock, balance, or receipt mutation.
   */
  async reconcileStaleAttemptIfOrphan(
    userId: string,
    idempotencyKey: string,
    conservativeStalenessMinutes = 15,
  ): Promise<void> {
    await this.prisma.client.transaction(async (tx) => {
      // 1. Check if attempt exists, is PROCESSING, and exceeds conservative staleness using authoritative DB clock
      const checkPlan = this.prisma.client.raw.sql`
        SELECT "id", "status",
               (clock_timestamp() - "createdAt") >= (${conservativeStalenessMinutes} || ' minutes')::interval AS is_stale
        FROM public."checkoutAttempt"
        WHERE "userId" = ${userId} AND "idempotencyKey" = ${idempotencyKey}
      `
        .returnsRow({
          id: 'pg/text@1',
          status: 'pg/text@1',
          is_stale: 'pg/bool@1',
        })
        .build();

      const [attempt] = await tx.query(checkPlan);
      if (!attempt || attempt.status !== 'PROCESSING' || !attempt.is_stale) {
        return;
      }

      const attemptId: string = attempt.id;

      // 2. Try to acquire advisory lock in same C2 namespace: hashtext('checkout_intent'), hashtext(userId:key)
      const tryLockPlan = this.prisma.client.raw.sql`
        SELECT pg_try_advisory_xact_lock(hashtext('checkout_intent'), hashtext(${userId} || ':' || ${idempotencyKey})) AS locked
      `
        .returnsRow({ locked: 'pg/bool@1' })
        .build();

      const [lockResult] = await tx.query(tryLockPlan);
      if (!lockResult || !lockResult.locked) {
        return; // Active business Tx holds the lock, do NOT reconcile
      }

      // 3. Re-check status under lock to avoid race conditions
      const recheckPlan = this.prisma.client.raw.sql`
        SELECT "id", "status"
        FROM public."checkoutAttempt"
        WHERE "id" = ${attemptId}
      `
        .returnsRow({ id: 'pg/text@1', status: 'pg/text@1' })
        .build();

      const [recheck] = await tx.query(recheckPlan);
      if (!recheck || recheck.status !== 'PROCESSING') {
        return;
      }

      // 4. Mark orphan as FAILED with safe INTERNAL_ERROR (no stock/balance/order side-effects)
      const updatePlan = this.prisma.client.raw.sql`
        UPDATE public."checkoutAttempt"
        SET "status" = 'FAILED',
            "errorCode" = 'INTERNAL_ERROR',
            "errorMessage" = 'Intento expirado o interrumpido durante el procesamiento',
            "errorDetails" = '{"reason":"STALE_PROCESSING_ORPHAN"}'::jsonb,
            "updatedAt" = clock_timestamp()
        WHERE "id" = ${attemptId} AND "status" = 'PROCESSING'
      `.affectedCount().build();

      await tx.execute(updatePlan);
    });
  }

  /**
   * GET /api/v1/shop/checkout-attempts/:idempotencyKey
   * Client owner scoped status lookup. Returns exact projection.
   * Unknown key or another owner key returns 404 CHECKOUT_ATTEMPT_NOT_FOUND (indistinguishable).
   */
  async getAttemptStatus(
    buyerUserId: string,
    rawKey: string,
  ): Promise<CheckoutAttemptStatusDto> {
    if (!rawKey || typeof rawKey !== 'string' || !UUID_V4_REGEX.test(rawKey.trim())) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'El parámetro idempotencyKey debe ser un UUIDv4 válido',
        { parameter: 'idempotencyKey', value: rawKey },
      );
    }

    const idempotencyKey = rawKey.trim();

    // Lazy bounded stale reconciliation before reading status
    await this.reconcileStaleAttemptIfOrphan(buyerUserId, idempotencyKey);

    return this.prisma.client.transaction(async (tx) => {
      const plan = this.prisma.client.raw.sql`
        SELECT "id", "userId", "idempotencyKey", "status",
               "orderId", "receiptId", "errorCode", "updatedAt"
        FROM public."checkoutAttempt"
        WHERE "userId" = ${buyerUserId} AND "idempotencyKey" = ${idempotencyKey}
      `
        .returnsRow({
          id: 'pg/text@1',
          userId: 'pg/text@1',
          idempotencyKey: 'pg/text@1',
          status: 'pg/text@1',
          orderId: 'pg/text@1',
          receiptId: 'pg/text@1',
          errorCode: 'pg/text@1',
          updatedAt: 'pg/timestamptz-temporal@1',
        })
        .build();

      const [row] = await tx.query(plan);
      if (!row || !row.status) {
        throw shopError(
          HttpStatus.NOT_FOUND,
          'CHECKOUT_ATTEMPT_NOT_FOUND',
          'Intento de checkout no encontrado',
          { idempotencyKey },
        );
      }

      const attempt = row as unknown as RawAttemptQueryRow;
      const formattedUpdatedAt = toIsoTimestamp(attempt.updatedAt);

      return {
        status: attempt.status as CheckoutAttemptStatusType,
        checkoutAttemptId: attempt.id,
        orderId: attempt.orderId ?? null,
        receiptId: attempt.receiptId ?? null,
        errorCode: attempt.errorCode ?? null,
        updatedAt: formattedUpdatedAt,
      };

    });
  }
}
