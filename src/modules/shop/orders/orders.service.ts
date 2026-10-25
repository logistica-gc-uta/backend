import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { shopError } from '../shop-http.filter.js';
import { toIsoTimestamp } from '../settings/shop-settings.service.js';
import { OrderStatus, ShopOrdersQueryDto } from './dto/orders-query.dto.js';
import { OrderListDto, OrderSummaryDto } from './dto/order-summary.dto.js';
import { OrderDetailDto, SoldItemDto, TimelineEntryDto } from './dto/order-detail.dto.js';
import { ReceiptDto } from './dto/receipt.dto.js';

interface RawOrderSummaryRow {
  id: string;
  number: string;
  createdAt: unknown;
  scheduledDeliveryDate: unknown;
  status: string;
  subtotalCents: bigint | number;
  taxAmountCents: bigint | number;
  taxRateBps: number;
  shippingAmountCents: number;
  totalCents: bigint | number;
  currency: string;
  receiptId: string;
  taxEnabled: boolean;
  snapshot: unknown;
}

interface RawOrderDetailRow extends RawOrderSummaryRow {
  routeId: string | null;
}

interface RawReceiptRow {
  id: string;
  number: string;
  orderId: string;
  issuedAt: unknown;
  merchantName: string;
  currency: string;
  subtotalCents: bigint | number;
  taxMode: string;
  taxEnabled: boolean;
  taxRateBps: number;
  taxAmountCents: bigint | number;
  shippingStatus: string;
  shippingAmountCents: number;
  totalCents: bigint | number;
  snapshot: unknown;
  disclaimer: string;
}

interface RawClaimRow {
  id: string;
  claimedAt: unknown;
  releasedAt: unknown;
}

interface RawRouteRow {
  startedAt: unknown;
}

interface RawAttemptRow {
  id: string;
  outcome: string;
  failureReason: string | null;
  recordedAt: unknown;
}

interface ParsedSnapshotItem {
  productId?: string;
  sku?: string;
  name?: string;
  quantity?: number;
  unitPriceCents?: number;
  lineTotalCents?: number;
  imageUrl?: string | null;
}

interface ParsedSnapshot {
  merchantName?: string;
  buyer?: {
    id?: string;
    name?: string;
    email?: string;
  };
  recipient?: {
    name?: string;
    phone?: string;
  };
  delivery?: {
    zoneId?: string;
    zoneName?: string;
    address?: string;
    location?: {
      lat?: number;
      lng?: number;
    };
    scheduledDeliveryDate?: string;
    notes?: string | null;
  };
  items?: ParsedSnapshotItem[];
  pricing?: {
    currency?: string;
    subtotalCents?: number;
    tax?: {
      mode?: string;
      enabled?: boolean;
      rateBps?: number;
      amountCents?: number;
    };
    shipping?: {
      status?: string;
      amountCents?: number;
      includedInPrices?: boolean;
    };
    totalCents?: number;
  };
  payment?: {
    status?: string;
    reference?: string;
    cardLast4?: string;
  };
  disclaimer?: string;
}

interface InternalTimelineItem extends TimelineEntryDto {
  entityId: string;
}

function parseSnapshot(raw: unknown): ParsedSnapshot {
  if (!raw) {
    throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Purchase receipt snapshot missing');
  }
  if (typeof raw === 'object' && raw !== null) return raw as ParsedSnapshot;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return parsed as ParsedSnapshot;
    } catch {
      // Handled by trailing throw
    }
  }
  throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Purchase receipt snapshot corrupted');
}

function toSafeIntegerCents(val: unknown, fieldName: string): number {
  let num: number;
  if (typeof val === 'bigint') {
    num = Number(val);
  } else if (typeof val === 'number') {
    num = val;
  } else if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    num = Number(val.trim());
  } else {
    throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', `Invalid money value for ${fieldName}`);
  }
  if (!Number.isSafeInteger(num) || num < 0) {
    throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', `Unsafe or negative money cents for ${fieldName}`);
  }
  return num;
}

function resolveFrozenScheduledDate(snapScheduledDate: unknown, rowScheduledDate: unknown): string {
  if (typeof snapScheduledDate === 'string' && snapScheduledDate.trim().length > 0) {
    return toIsoTimestamp(snapScheduledDate.trim());
  }
  if (rowScheduledDate) {
    return toIsoTimestamp(rowScheduledDate);
  }
  throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Missing scheduled delivery date in frozen record');
}

@Injectable()
export class ShopOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 1. GET /api/v1/shop/orders
   * Paged client purchase history, immutable financial/product snapshots from PurchaseReceipt.
   * Scoped strictly to authenticated client JWT.
   */
  async listOrders(buyerUserId: string, query: ShopOrdersQueryDto): Promise<OrderListDto> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 10));
    const offset = (page - 1) * pageSize;
    const statusFilter = query.status ? query.status.toString() : '';

    return this.prisma.client.transaction(async (tx) => {
      const countPlan = this.prisma.client.raw.sql`
        SELECT count(*)::int AS total
        FROM public."order" o
        JOIN public."purchaseReceipt" r ON r."orderId" = o."id"
        WHERE o."userId" = ${buyerUserId} AND r."buyerId" = ${buyerUserId}
          AND (${statusFilter} = '' OR o."status"::text = ${statusFilter})
      `
        .returnsRow({ total: 'pg/int4@1' })
        .build();

      const [countResult] = await tx.query(countPlan);
      const total = countResult?.total ?? 0;
      const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;

      if (total === 0 || offset >= total) {
        return {
          items: [],
          total,
          page,
          pageSize,
          totalPages,
        };
      }

      const listPlan = this.prisma.client.raw.sql`
        SELECT
          o."id",
          r."commercialOrderNumber" AS "number",
          o."createdAt",
          o."scheduledDeliveryDate",
          o."status"::text AS "status",
          r."subtotalCents",
          r."taxAmountCents",
          r."taxRateBps",
          r."shippingAmountCents",
          r."totalCents",
          r."currency",
          r."id" AS "receiptId",
          r."taxEnabled",
          r."snapshot"
        FROM public."order" o
        JOIN public."purchaseReceipt" r ON r."orderId" = o."id"
        WHERE o."userId" = ${buyerUserId} AND r."buyerId" = ${buyerUserId}
          AND (${statusFilter} = '' OR o."status"::text = ${statusFilter})
        ORDER BY o."createdAt" DESC, o."id" DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `
        .returnsRow({
          id: 'pg/text@1',
          number: 'pg/text@1',
          createdAt: 'pg/timestamptz-temporal@1',
          scheduledDeliveryDate: 'pg/timestamptz-temporal@1',
          status: 'pg/text@1',
          subtotalCents: 'pg/int8@1',
          taxAmountCents: 'pg/int8@1',
          taxRateBps: 'pg/int4@1',
          shippingAmountCents: 'pg/int4@1',
          totalCents: 'pg/int8@1',
          currency: 'pg/text@1',
          receiptId: 'pg/text@1',
          taxEnabled: 'pg/bool@1',
          snapshot: 'pg/jsonb@1',
        })
        .build();

      const rows = (await tx.query(listPlan)) as unknown as RawOrderSummaryRow[];

      const items: OrderSummaryDto[] = rows.map((row) => {
        const snap = parseSnapshot(row.snapshot);
        if (!Array.isArray(snap.items) || snap.items.length === 0) {
          throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot items missing');
        }

        let itemsCount = 0;
        for (const it of snap.items) {
          if (typeof it.quantity !== 'number' || it.quantity <= 0 || !Number.isInteger(it.quantity)) {
            throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot item quantity corrupted');
          }
          itemsCount += it.quantity;
        }

        const rawImageUrl = snap.items[0]?.imageUrl;
        const primaryImageUrl =
          typeof rawImageUrl === 'string' && rawImageUrl.trim().length > 0 ? rawImageUrl.trim() : null;

        const scheduledDate = resolveFrozenScheduledDate(
          snap.delivery?.scheduledDeliveryDate,
          row.scheduledDeliveryDate,
        );

        return {
          id: row.id,
          number: row.number,
          createdAt: toIsoTimestamp(row.createdAt),
          scheduledDeliveryDate: scheduledDate,
          status: row.status as OrderStatus,
          totalCents: toSafeIntegerCents(row.totalCents, 'totalCents'),
          currency: 'USD',
          paymentStatus: 'APPROVED',
          receiptId: row.receiptId,
          itemsCount,
          primaryImageUrl,
          subtotalCents: toSafeIntegerCents(row.subtotalCents, 'subtotalCents'),
          taxAmountCents: toSafeIntegerCents(row.taxAmountCents, 'taxAmountCents'),
          taxRateBps: row.taxRateBps,
          shippingAmountCents: row.shippingAmountCents,
          taxEnabled: row.taxEnabled,
        };
      });

      return {
        items,
        total,
        page,
        pageSize,
        totalPages,
      };
    });
  }

  /**
   * 2. GET /api/v1/shop/orders/:id
   * Complete own order detail with immutable contact/financial snapshot and persisted timeline.
   * Unknown or foreign orders return 404 ORDER_NOT_FOUND (no BOLA leakage).
   */
  async getOrderDetail(buyerUserId: string, orderId: string): Promise<OrderDetailDto> {
    return this.prisma.client.transaction(async (tx) => {
      const orderPlan = this.prisma.client.raw.sql`
        SELECT
          o."id",
          r."commercialOrderNumber" AS "number",
          o."createdAt",
          o."scheduledDeliveryDate",
          o."status"::text AS "status",
          o."routeId",
          r."subtotalCents",
          r."taxAmountCents",
          r."taxRateBps",
          r."shippingAmountCents",
          r."totalCents",
          r."currency",
          r."id" AS "receiptId",
          r."taxEnabled",
          r."snapshot"
        FROM public."order" o
        JOIN public."purchaseReceipt" r ON r."orderId" = o."id"
        WHERE o."id" = ${orderId} AND o."userId" = ${buyerUserId} AND r."buyerId" = ${buyerUserId}
      `
        .returnsRow({
          id: 'pg/text@1',
          number: 'pg/text@1',
          createdAt: 'pg/timestamptz-temporal@1',
          scheduledDeliveryDate: 'pg/timestamptz-temporal@1',
          status: 'pg/text@1',
          routeId: 'pg/text@1',
          subtotalCents: 'pg/int8@1',
          taxAmountCents: 'pg/int8@1',
          taxRateBps: 'pg/int4@1',
          shippingAmountCents: 'pg/int4@1',
          totalCents: 'pg/int8@1',
          currency: 'pg/text@1',
          receiptId: 'pg/text@1',
          taxEnabled: 'pg/bool@1',
          snapshot: 'pg/jsonb@1',
        })
        .build();

      const [row] = (await tx.query(orderPlan)) as unknown as [RawOrderDetailRow | undefined];
      if (!row) {
        throw shopError(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Pedido no encontrado');
      }

      // Collect real persisted timeline events
      const timelineEntries: InternalTimelineItem[] = [
        {
          entityId: `order:${row.id}`,
          code: 'PENDING',
          label: 'Pedido registrado',
          at: toIsoTimestamp(row.createdAt),
        },
      ];

      // Query real order claims with primary keys to preserve deterministic ties
      const claimsPlan = this.prisma.client.raw.sql`
        SELECT "id", "claimedAt", "releasedAt"
        FROM public."orderClaim"
        WHERE "orderId" = ${orderId}
        ORDER BY "claimedAt" ASC NULLS LAST, "id" ASC
      `
        .returnsRow({
          id: 'pg/text@1',
          claimedAt: 'pg/timestamptz-temporal@1',
          releasedAt: 'pg/timestamptz-temporal@1',
        })
        .build();

      const claims = (await tx.query(claimsPlan)) as unknown as RawClaimRow[];
      for (const claim of claims) {
        if (claim.claimedAt) {
          timelineEntries.push({
            entityId: `claim-assigned:${claim.id}`,
            code: 'ASSIGNED',
            label: 'Asignado a ruta',
            at: toIsoTimestamp(claim.claimedAt),
          });
        }
        if (claim.releasedAt) {
          timelineEntries.push({
            entityId: `claim-released:${claim.id}`,
            code: 'CLAIM_RELEASED',
            label: 'Reserva de ruta liberada',
            at: toIsoTimestamp(claim.releasedAt),
          });
        }
      }

      // Query real route departure
      if (row.routeId) {
        const routePlan = this.prisma.client.raw.sql`
          SELECT "startedAt"
          FROM public."route"
          WHERE "id" = ${row.routeId}
        `
          .returnsRow({ startedAt: 'pg/timestamptz-temporal@1' })
          .build();

        const [routeRow] = (await tx.query(routePlan)) as unknown as [RawRouteRow | undefined];
        if (routeRow?.startedAt) {
          timelineEntries.push({
            entityId: `route:${row.routeId}`,
            code: 'IN_TRANSIT',
            label: 'En camino',
            at: toIsoTimestamp(routeRow.startedAt),
          });
        }
      }

      // Query real delivery attempts preserving distinct entities without collapsing
      const attemptsPlan = this.prisma.client.raw.sql`
        SELECT da."id", da."outcome"::text AS "outcome", da."failureReason"::text AS "failureReason", da."recordedAt"
        FROM public."routeStop" rs
        JOIN public."deliveryAttempt" da ON da."stopId" = rs."id"
        WHERE rs."orderId" = ${orderId}
        ORDER BY da."recordedAt" ASC, da."id" ASC
      `
        .returnsRow({
          id: 'pg/text@1',
          outcome: 'pg/text@1',
          failureReason: 'pg/text@1',
          recordedAt: 'pg/timestamptz-temporal@1',
        })
        .build();

      const attempts = (await tx.query(attemptsPlan)) as unknown as RawAttemptRow[];
      for (const attempt of attempts) {
        if (attempt.recordedAt) {
          if (attempt.outcome === 'SUCCESSFUL') {
            timelineEntries.push({
              entityId: `attempt:${attempt.id}`,
              code: 'DELIVERED',
              label: 'Entregado',
              at: toIsoTimestamp(attempt.recordedAt),
            });
          } else if (attempt.outcome === 'FAILED') {
            let label = 'Intento de entrega fallido';
            if (attempt.failureReason === 'RECIPIENT_ABSENT') {
              label = 'Intento de entrega fallido: destinatario ausente';
            } else if (attempt.failureReason === 'RECIPIENT_REFUSED') {
              label = 'Intento de entrega fallido: entrega rechazada';
            }
            timelineEntries.push({
              entityId: `attempt:${attempt.id}`,
              code: 'ATTEMPT_FAILED',
              label,
              at: toIsoTimestamp(attempt.recordedAt),
            });
          }
        }
      }

      // Sort timeline deterministically by persisted timestamp and entity ID
      timelineEntries.sort((a, b) => {
        const timeDiff = new Date(a.at).getTime() - new Date(b.at).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.entityId.localeCompare(b.entityId);
      });

      const timeline: TimelineEntryDto[] = timelineEntries.map(({ code, label, at }) => ({
        code,
        label,
        at,
      }));

      // Hydrate and validate snapshot data strictly
      const snap = parseSnapshot(row.snapshot);
      if (!Array.isArray(snap.items) || snap.items.length === 0) {
        throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot items missing');
      }

      const soldItems: SoldItemDto[] = snap.items.map((item) => {
        if (!item.name || !item.sku || typeof item.quantity !== 'number' || item.quantity <= 0 || !Number.isInteger(item.quantity)) {
          throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot item data corrupted');
        }
        const rawUrl = item.imageUrl;
        const imageUrl = typeof rawUrl === 'string' && rawUrl.trim().length > 0 ? rawUrl.trim() : null;
        return {
          productId: typeof item.productId === 'string' && item.productId.length > 0 ? item.productId : '',
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unitPriceCents: toSafeIntegerCents(item.unitPriceCents, 'unitPriceCents'),
          lineTotalCents: toSafeIntegerCents(item.lineTotalCents, 'lineTotalCents'),
          imageUrl,
        };
      });

      if (
        !snap.buyer?.name ||
        typeof snap.buyer.name !== 'string' ||
        !snap.buyer.name.trim() ||
        !snap.buyer?.email ||
        typeof snap.buyer.email !== 'string' ||
        !snap.buyer.email.trim()
      ) {
        throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot buyer data corrupted');
      }

      const buyer = {
        id: typeof snap.buyer.id === 'string' && snap.buyer.id ? snap.buyer.id : buyerUserId,
        name: snap.buyer.name.trim(),
        email: snap.buyer.email.trim(),
      };

      if (
        !snap.recipient?.name ||
        typeof snap.recipient.name !== 'string' ||
        !snap.recipient.name.trim() ||
        !snap.recipient?.phone ||
        typeof snap.recipient.phone !== 'string' ||
        !snap.recipient.phone.trim()
      ) {
        throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot recipient data corrupted');
      }

      const recipient = {
        name: snap.recipient.name.trim(),
        phone: snap.recipient.phone.trim(),
      };

      if (
        !snap.delivery?.zoneId ||
        !snap.delivery?.zoneName ||
        !snap.delivery?.address ||
        typeof snap.delivery?.location?.lat !== 'number' ||
        typeof snap.delivery?.location?.lng !== 'number'
      ) {
        throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot delivery data corrupted');
      }

      const scheduledDate = resolveFrozenScheduledDate(
        snap.delivery.scheduledDeliveryDate,
        row.scheduledDeliveryDate,
      );

      const delivery = {
        zoneId: snap.delivery.zoneId,
        zoneName: snap.delivery.zoneName,
        address: snap.delivery.address,
        location: {
          lat: snap.delivery.location.lat,
          lng: snap.delivery.location.lng,
        },
        scheduledDeliveryDate: scheduledDate,
        notes:
          typeof snap.delivery.notes === 'string' && snap.delivery.notes.trim().length > 0
            ? snap.delivery.notes.trim()
            : null,
      };

      return {
        id: row.id,
        number: row.number,
        createdAt: toIsoTimestamp(row.createdAt),
        scheduledDeliveryDate: scheduledDate,
        status: row.status as OrderStatus,
        routeId: row.routeId ?? null,
        currency: 'USD',
        totalCents: toSafeIntegerCents(row.totalCents, 'totalCents'),
        paymentStatus: 'APPROVED',
        buyer,
        recipient,
        delivery,
        items: soldItems,
        timeline,
        receiptId: row.receiptId,
        subtotalCents: toSafeIntegerCents(row.subtotalCents, 'subtotalCents'),
        taxAmountCents: toSafeIntegerCents(row.taxAmountCents, 'taxAmountCents'),
        taxRateBps: row.taxRateBps,
        shippingAmountCents: row.shippingAmountCents,
        taxEnabled: row.taxEnabled,
      };
    });
  }

  /**
   * 3. GET /api/v1/shop/orders/:id/receipt
   * Single immutable purchase receipt projection. Safe projection without secrets or PAN.
   * Unknown or foreign orders return 404 ORDER_NOT_FOUND (never leaks existence).
   */
  async getOrderReceipt(buyerUserId: string, orderId: string): Promise<ReceiptDto> {
    return this.prisma.client.transaction(async (tx) => {
      const receiptPlan = this.prisma.client.raw.sql`
        SELECT
          r."id",
          r."number",
          r."orderId",
          r."issuedAt",
          r."merchantName",
          r."currency",
          r."subtotalCents",
          r."taxMode",
          r."taxEnabled",
          r."taxRateBps",
          r."taxAmountCents",
          r."shippingStatus",
          r."shippingAmountCents",
          r."totalCents",
          r."snapshot",
          r."disclaimer"
        FROM public."purchaseReceipt" r
        JOIN public."order" o ON o."id" = r."orderId"
        WHERE r."orderId" = ${orderId} AND r."buyerId" = ${buyerUserId} AND o."userId" = ${buyerUserId}
      `
        .returnsRow({
          id: 'pg/text@1',
          number: 'pg/text@1',
          orderId: 'pg/text@1',
          issuedAt: 'pg/timestamptz-temporal@1',
          merchantName: 'pg/text@1',
          currency: 'pg/text@1',
          subtotalCents: 'pg/int8@1',
          taxMode: 'pg/text@1',
          taxEnabled: 'pg/bool@1',
          taxRateBps: 'pg/int4@1',
          taxAmountCents: 'pg/int8@1',
          shippingStatus: 'pg/text@1',
          shippingAmountCents: 'pg/int4@1',
          totalCents: 'pg/int8@1',
          snapshot: 'pg/jsonb@1',
          disclaimer: 'pg/text@1',
        })
        .build();

      const [row] = (await tx.query(receiptPlan)) as unknown as [RawReceiptRow | undefined];
      if (!row) {
        throw shopError(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Pedido o comprobante no encontrado');
      }

      const snap = parseSnapshot(row.snapshot);
      if (!Array.isArray(snap.items) || snap.items.length === 0) {
        throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot items missing');
      }

      const receiptItems = snap.items.map((item) => {
        if (!item.name || !item.sku || typeof item.quantity !== 'number' || item.quantity <= 0 || !Number.isInteger(item.quantity)) {
          throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot item data corrupted');
        }
        return {
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unitPriceCents: toSafeIntegerCents(item.unitPriceCents, 'unitPriceCents'),
          lineTotalCents: toSafeIntegerCents(item.lineTotalCents, 'lineTotalCents'),
        };
      });

      if (
        !snap.buyer?.name ||
        typeof snap.buyer.name !== 'string' ||
        !snap.buyer.name.trim() ||
        !snap.buyer?.email ||
        typeof snap.buyer.email !== 'string' ||
        !snap.buyer.email.trim()
      ) {
        throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot buyer data corrupted');
      }

      const buyer = {
        name: snap.buyer.name.trim(),
        email: snap.buyer.email.trim(),
      };

      if (!snap.recipient?.name || typeof snap.recipient.name !== 'string' || !snap.recipient.name.trim()) {
        throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot recipient data corrupted');
      }

      const recipient = {
        name: snap.recipient.name.trim(),
      };

      if (!snap.payment?.reference || !snap.payment?.cardLast4) {
        throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Snapshot payment data corrupted');
      }

      const payment = {
        status: 'APPROVED' as const,
        reference: snap.payment.reference,
        cardLast4: snap.payment.cardLast4,
      };

      const ratePercent = row.taxRateBps / 100;

      return {
        id: row.id,
        number: row.number,
        orderId: row.orderId,
        issuedAt: toIsoTimestamp(row.issuedAt),
        merchantName: row.merchantName || 'REGALÍA',
        buyer,
        recipient,
        items: receiptItems,
        currency: 'USD',
        subtotalCents: toSafeIntegerCents(row.subtotalCents, 'subtotalCents'),
        totalCents: toSafeIntegerCents(row.totalCents, 'totalCents'),
        payment,
        disclaimer: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA' as const,
        tax: {
          mode: 'SIMULATED' as const,
          enabled: row.taxEnabled,
          rateBps: row.taxRateBps,
          ratePercent,
          amountCents: toSafeIntegerCents(row.taxAmountCents, 'taxAmountCents'),
        },
        shipping: {
          status: 'FREE_INCLUDED' as const,
          amountCents: 0,
          includedInPrices: true,
        },
      };
    });
  }
}
