import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { calculateMoneyAmounts } from '../shop/checkout/checkout-money.util.js';
import { shopError } from '../shop/shop-http.filter.js';
import { ShopSettingsService } from '../shop/settings/shop-settings.service.js';
import { toIsoTimestamp } from '../shop/settings/shop-settings.service.js';
import { StoreCoverageService } from '../store-coverage/store-coverage.service.js';
import { assertDeliveryCovered } from './delivery-coverage.util.js';
import { assertWithinOperatingHours } from './delivery-hours.util.js';
import { CreateAdminOrderDto } from './dto/create-admin-order.dto.js';
import { UpdateOrderContactDto } from './dto/update-order-contact.dto.js';
import { assertDeliveryFuture, deliveryClock, parseDeliveryTiming } from './order-delivery.util.js';
import { validateCoordinatePair } from './order-geography.util.js';
import { consolidateOrderItems } from './order-inventory.util.js';
import { projectOrder } from './order-response.util.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STALE_MS = 15 * 60 * 1000;

interface AttemptRow {
  id: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  orderId: string | null;
  receiptId: string | null;
  declarationId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: unknown;
  successSnapshot: unknown;
  updatedAt?: unknown;
}

@Injectable()
export class AdminPurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: ShopSettingsService,
    private readonly storeCoverage: StoreCoverageService,
  ) {}

  async create(actorId: string, dto: CreateAdminOrderDto, rawKey: string | undefined) {
    const idempotencyKey = this.requireIdempotencyKey(rawKey);
    const requestHash = this.requestHash(dto);
    const existing = await this.fetchAttempt(actorId, idempotencyKey);
    if (existing) {
      return this.replayOrConflict(existing, requestHash, idempotencyKey);
    }

    const attemptId = randomUUID();
    const reserved = await this.reserveProcessing(actorId, idempotencyKey, requestHash, attemptId);
    if (!reserved) {
      const raced = await this.fetchAttempt(actorId, idempotencyKey);
      if (raced) {
        return this.replayOrConflict(raced, requestHash, idempotencyKey);
      }
      throw shopError(
        HttpStatus.CONFLICT,
        'ADMIN_PURCHASE_IN_PROGRESS',
        'La compra administrativa sigue en procesamiento',
        { idempotencyKey },
      );
    }

    try {
      return await this.executeSale(actorId, dto, idempotencyKey, requestHash, attemptId);
    } catch (error) {
      await this.recordFailure(actorId, idempotencyKey, requestHash, attemptId, error);
      throw error;
    }
  }

  async getAttempt(actorId: string, rawKey: string) {
    if (!rawKey || !UUID_V4_REGEX.test(rawKey.trim())) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'El parámetro idempotencyKey debe ser un UUIDv4 válido',
        { parameter: 'idempotencyKey', value: rawKey },
      );
    }
    const idempotencyKey = rawKey.trim();
    await this.reconcileStale(actorId, idempotencyKey);
    const attempt = await this.fetchAttempt(actorId, idempotencyKey);
    if (!attempt) {
      throw shopError(HttpStatus.NOT_FOUND, 'ADMIN_PURCHASE_ATTEMPT_NOT_FOUND', 'Intento de compra no encontrado');
    }
    return {
      id: attempt.id,
      status: attempt.status,
      orderId: attempt.orderId,
      receiptId: attempt.receiptId,
      errorCode: attempt.errorCode,
      updatedAt: attempt.updatedAt ? toIsoTimestamp(attempt.updatedAt) : undefined,
      result: attempt.status === 'SUCCEEDED' ? attempt.successSnapshot : undefined,
    };
  }

  async getReceipt(orderId: string) {
    return this.prisma.client.transaction(async (tx) => {
      const plan = this.prisma.client.raw.sql`
        SELECT
          r."id", r."number", r."orderId", r."issuedAt", r."merchantName", r."currency",
          r."subtotalCents", r."taxMode", r."taxEnabled", r."taxRateBps", r."taxAmountCents",
          r."shippingStatus", r."shippingAmountCents", r."totalCents", r."snapshot", r."disclaimer"
        FROM public."purchaseReceipt" r
        WHERE r."orderId" = ${orderId}
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
      const [row] = await tx.query(plan);
      if (!row) {
        throw shopError(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Pedido o comprobante no encontrado');
      }
      return this.projectReceipt(row as Record<string, unknown>);
    });
  }

  async updateContact(actorId: string, orderId: string, dto: UpdateOrderContactDto) {
    const fields = ['buyerPhone', 'buyerName', 'recipientName', 'recipientPhone'] as const;
    const requested = fields.filter((field) => dto[field] !== undefined);
    if (requested.length === 0) {
      throw new BadRequestException('At least one contact field is required');
    }

    return this.prisma.client.transaction(async (tx) => {
      const lockPlan = this.prisma.client.raw.sql`
        SELECT id, "userId", "recipientType", "buyerName", "buyerPhone", "recipientName", "recipientPhone", "contactRevision"
        FROM public."order" WHERE id = ${orderId} FOR UPDATE
      `
        .returnsRow({
          id: 'pg/text@1',
          userId: 'pg/text@1',
          recipientType: 'pg/text@1',
          buyerName: 'pg/text@1',
          buyerPhone: 'pg/text@1',
          recipientName: 'pg/text@1',
          recipientPhone: 'pg/text@1',
          contactRevision: 'pg/int4@1',
        })
        .build();
      const [order] = await tx.query(lockPlan);
      if (!order) {
        throw new NotFoundException(`Pedido con ID '${orderId}' no encontrado`);
      }
      if (order.contactRevision !== dto.contactRevision) {
        throw shopError(
          HttpStatus.CONFLICT,
          'CONTACT_REVISION_CONFLICT',
          'El pedido fue corregido por otro administrador',
          { contactRevision: order.contactRevision },
        );
      }
      if (dto.buyerName !== undefined && order.userId !== null) {
        throw new BadRequestException('buyerName can only be corrected on guest purchases');
      }

      const current = order as Record<string, unknown>;
      const next: Record<string, string | null | number> = {
        buyerName: order.buyerName,
        buyerPhone: order.buyerPhone,
        recipientName: order.recipientName,
        recipientPhone: order.recipientPhone,
      };
      for (const field of requested) {
        next[field] = dto[field]!;
      }

      const updatePlan = this.prisma.client.raw.sql`
        UPDATE public."order"
        SET "buyerName" = NULLIF(${String(next.buyerName ?? '')}, ''),
            "buyerPhone" = NULLIF(${String(next.buyerPhone ?? '')}, ''),
            "recipientName" = ${String(next.recipientName ?? '')},
            "recipientPhone" = NULLIF(${String(next.recipientPhone ?? '')}, ''),
            "contactRevision" = ${dto.contactRevision + 1}
        WHERE id = ${orderId} AND "contactRevision" = ${dto.contactRevision}
      `.affectedCount().build();
      const stats = await tx.execute(updatePlan);
      const affected = typeof stats === 'number' ? stats : (stats?.affectedRows ?? 0);
      if (affected !== 1) {
        throw shopError(
          HttpStatus.CONFLICT,
          'CONTACT_REVISION_CONFLICT',
          'El pedido fue corregido por otro administrador',
          {},
        );
      }

      for (const field of requested) {
        const previous = current[field] == null ? '' : String(current[field]);
        const updated = dto[field]!;
        if (previous === updated) continue;
        await tx.execute(
          this.prisma.client.raw.sql`
            INSERT INTO public."orderContactAudit" (
              id, "orderId", "actorId", field, "previousValue", "nextValue", "createdAt"
            ) VALUES (
              ${randomUUID()}, ${orderId}, ${actorId}, ${field}, NULLIF(${previous ?? ''}, ''), ${updated}, clock_timestamp()
            )
          `.affectedCount().build(),
        );
      }

      const reloaded = await tx.orm.public.Order.where({ id: orderId })
        .include('items', (i) => i.include('product'))
        .include('zone')
        .first();
      return projectOrder(reloaded!, true);
    });
  }

  async contactHistory(orderId: string) {
    const order = await this.prisma.order.where({ id: orderId }).select('id').first();
    if (!order) {
      throw new NotFoundException(`Pedido con ID '${orderId}' no encontrado`);
    }
    return this.prisma.client.transaction(async (tx) => {
      const plan = this.prisma.client.raw.sql`
        SELECT id, field, "previousValue", "nextValue", "actorId", "createdAt"
        FROM public."orderContactAudit"
        WHERE "orderId" = ${orderId}
        ORDER BY "createdAt" ASC, id ASC
      `
        .returnsRow({
          id: 'pg/text@1',
          field: 'pg/text@1',
          previousValue: 'pg/text@1',
          nextValue: 'pg/text@1',
          actorId: 'pg/text@1',
          createdAt: 'pg/timestamptz-temporal@1',
        })
        .build();
      const rows = await tx.query(plan);
      return rows.map((row) => ({
        id: row.id,
        field: row.field,
        previousValue: row.previousValue,
        nextValue: row.nextValue,
        actorId: row.actorId,
        createdAt: toIsoTimestamp(row.createdAt),
      }));
    });
  }

  private requireIdempotencyKey(key: string | undefined): string {
    if (!key || typeof key !== 'string' || !UUID_V4_REGEX.test(key.trim())) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'El header Idempotency-Key debe ser un UUIDv4 válido',
        { header: 'Idempotency-Key' },
      );
    }
    return key.trim();
  }

  private requestHash(dto: CreateAdminOrderDto): string {
    const payload = {
      buyer: dto.buyer,
      giftRecipient: dto.giftRecipient ?? null,
      payment: { method: dto.payment.method, note: dto.payment.note ?? null },
      items: consolidateOrderItems(dto.items),
      deliveryAddress: dto.deliveryAddress.trim(),
      deliveryLat: dto.deliveryLat,
      deliveryLng: dto.deliveryLng,
      scheduledDeliveryDate: dto.scheduledDeliveryDate,
      deliveryWindowStart: dto.deliveryWindowStart ?? null,
      deliveryWindowEnd: dto.deliveryWindowEnd ?? null,
      zoneId: dto.zoneId ?? null,
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private async fetchAttempt(actorId: string, idempotencyKey: string): Promise<AttemptRow | null> {
    return this.prisma.client.transaction(async (tx) => {
      const plan = this.prisma.client.raw.sql`
        SELECT "id", "actorId", "idempotencyKey", "requestHash", "status",
               "orderId", "receiptId", "declarationId", "errorCode", "errorMessage",
               "errorDetails", "successSnapshot", "updatedAt"
        FROM public."adminPurchaseAttempt"
        WHERE "actorId" = ${actorId} AND "idempotencyKey" = ${idempotencyKey}
      `
        .returnsRow({
          id: 'pg/text@1',
          actorId: 'pg/text@1',
          idempotencyKey: 'pg/text@1',
          requestHash: 'pg/text@1',
          status: 'pg/text@1',
          orderId: 'pg/text@1',
          receiptId: 'pg/text@1',
          declarationId: 'pg/text@1',
          errorCode: 'pg/text@1',
          errorMessage: 'pg/text@1',
          errorDetails: 'pg/jsonb@1',
          successSnapshot: 'pg/jsonb@1',
          updatedAt: 'pg/timestamptz-temporal@1',
        })
        .build();
      const [row] = await tx.query(plan);
      return row?.status ? (row as unknown as AttemptRow) : null;
    });
  }

  private async reserveProcessing(
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
    attemptId: string,
  ): Promise<boolean> {
    return this.prisma.client.transaction(async (tx) => {
      const insertPlan = this.prisma.client.raw.sql`
        INSERT INTO public."adminPurchaseAttempt" (
          "id", "actorId", "idempotencyKey", "requestHash", "status", "createdAt", "updatedAt"
        ) VALUES (
          ${attemptId}, ${actorId}, ${idempotencyKey}, ${requestHash}, 'PROCESSING',
          clock_timestamp(), clock_timestamp()
        )
        ON CONFLICT ("actorId", "idempotencyKey") DO NOTHING
      `.affectedCount().build();
      const stats = await tx.execute(insertPlan);
      const affected = typeof stats === 'number' ? stats : (stats?.affectedRows ?? 0);
      return affected === 1;
    });
  }

  private replayOrConflict(attempt: AttemptRow, requestHash: string, idempotencyKey: string) {
    if (attempt.requestHash !== requestHash) {
      throw shopError(
        HttpStatus.CONFLICT,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key has already been used with a different request payload',
        { idempotencyKey },
      );
    }
    if (attempt.status === 'SUCCEEDED' && attempt.successSnapshot) {
      return attempt.successSnapshot;
    }
    if (attempt.status === 'REJECTED') {
      this.rethrowRecorded(attempt);
    }
    if (attempt.status === 'FAILED') {
      throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Error interno al procesar el intento de compra');
    }
    throw shopError(
      HttpStatus.CONFLICT,
      'ADMIN_PURCHASE_IN_PROGRESS',
      'La compra administrativa sigue en procesamiento',
      { idempotencyKey },
    );
  }

  private rethrowRecorded(attempt: AttemptRow): never {
    const details = attempt.errorDetails && typeof attempt.errorDetails === 'object'
      ? attempt.errorDetails as Record<string, unknown>
      : {};
    if (attempt.errorCode === 'NEST_BAD_REQUEST') {
      throw new BadRequestException(attempt.errorMessage ?? 'Bad Request');
    }
    if (attempt.errorCode === 'NEST_NOT_FOUND') {
      throw new NotFoundException(attempt.errorMessage ?? 'Not Found');
    }
    throw shopError(
      this.statusForCode(attempt.errorCode ?? 'INTERNAL_ERROR'),
      attempt.errorCode ?? 'INTERNAL_ERROR',
      attempt.errorMessage ?? 'Solicitud rechazada previamente',
      details,
    );
  }

  private statusForCode(code: string): number {
    switch (code) {
      case 'IDEMPOTENCY_KEY_REUSED':
      case 'ADMIN_PURCHASE_IN_PROGRESS':
      case 'STORE_NOT_CONFIGURED':
      case 'CONTACT_REVISION_CONFLICT':
        return HttpStatus.CONFLICT;
      case 'DELIVERY_OUTSIDE_HOURS':
      case 'DELIVERY_OUTSIDE_COVERAGE':
      case 'DELIVERY_INVALID':
        return HttpStatus.UNPROCESSABLE_ENTITY;
      case 'VALIDATION_ERROR':
        return HttpStatus.BAD_REQUEST;
      case 'ADMIN_PURCHASE_ATTEMPT_NOT_FOUND':
      case 'ORDER_NOT_FOUND':
        return HttpStatus.NOT_FOUND;
      default:
        return HttpStatus.INTERNAL_SERVER_ERROR;
    }
  }

  private async recordFailure(
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
    attemptId: string,
    error: unknown,
  ): Promise<void> {
    let status: 'REJECTED' | 'FAILED' = 'FAILED';
    let errorCode = 'INTERNAL_ERROR';
    let errorMessage = 'Error interno al procesar el intento de compra';
    let errorDetails: Record<string, unknown> = {};
    if (error instanceof HttpException) {
      const payload = error.getResponse();
      const object = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const explicit = object.error && typeof object.error === 'object'
        ? object.error as Record<string, unknown>
        : undefined;
      if (typeof explicit?.code === 'string') {
        status = 'REJECTED';
        errorCode = explicit.code;
        errorMessage = typeof explicit.message === 'string' ? explicit.message : error.message;
        errorDetails = explicit.details && typeof explicit.details === 'object'
          ? explicit.details as Record<string, unknown>
          : {};
      } else if (error.getStatus() === 400) {
        status = 'REJECTED';
        errorCode = 'NEST_BAD_REQUEST';
        errorMessage = typeof object.message === 'string' ? object.message : error.message;
      } else if (error.getStatus() === 404) {
        status = 'REJECTED';
        errorCode = 'NEST_NOT_FOUND';
        errorMessage = typeof object.message === 'string' ? object.message : error.message;
      }
    }
    await this.prisma.client.transaction(async (tx) => {
      await this.lockIntent(tx, actorId, idempotencyKey);
      await tx.execute(
        this.prisma.client.raw.sql`
          UPDATE public."adminPurchaseAttempt"
          SET "status" = ${status},
              "errorCode" = ${errorCode},
              "errorMessage" = ${errorMessage},
              "errorDetails" = ${JSON.stringify(errorDetails)}::jsonb,
              "updatedAt" = clock_timestamp()
          WHERE "id" = ${attemptId}
            AND "actorId" = ${actorId}
            AND "idempotencyKey" = ${idempotencyKey}
            AND "requestHash" = ${requestHash}
            AND "status" = 'PROCESSING'
        `.affectedCount().build(),
      );
    });
  }

  private async lockIntent(tx: Transaction, actorId: string, idempotencyKey: string) {
    const lockPlan = this.prisma.client.raw.sql`
      SELECT 1 AS locked
      FROM pg_advisory_xact_lock(hashtext('admin_purchase'), hashtext(${actorId} || ':' || ${idempotencyKey}))
    `.returnsRow({ locked: 'pg/int4@1' }).build();
    await tx.query(lockPlan);
  }

  private async reconcileStale(actorId: string, idempotencyKey: string): Promise<void> {
    await this.prisma.client.transaction(async (tx) => {
      await this.lockIntent(tx, actorId, idempotencyKey);
      const plan = this.prisma.client.raw.sql`
        SELECT id, status, "updatedAt"
        FROM public."adminPurchaseAttempt"
        WHERE "actorId" = ${actorId} AND "idempotencyKey" = ${idempotencyKey}
      `
        .returnsRow({
          id: 'pg/text@1',
          status: 'pg/text@1',
          updatedAt: 'pg/timestamptz-temporal@1',
        })
        .build();
      const [row] = await tx.query(plan);
      if (!row || row.status !== 'PROCESSING' || !row.updatedAt) return;
      const updated = new Date(toIsoTimestamp(row.updatedAt)).getTime();
      if (Date.now() - updated < STALE_MS) return;
      await tx.execute(
        this.prisma.client.raw.sql`
          UPDATE public."adminPurchaseAttempt"
          SET "status" = 'FAILED',
              "errorCode" = 'INTERNAL_ERROR',
              "errorMessage" = 'Error interno al procesar el intento de compra',
              "errorDetails" = '{}'::jsonb,
              "updatedAt" = clock_timestamp()
          WHERE id = ${row.id} AND status = 'PROCESSING'
        `.affectedCount().build(),
      );
    });
  }

  private recipientText(value: string, max: number, field: string): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
      throw new BadRequestException(`Invalid recipient ${field}`);
    }
    return value.trim();
  }

  private async executeSale(
    actorId: string,
    dto: CreateAdminOrderDto,
    idempotencyKey: string,
    requestHash: string,
    attemptId: string,
  ) {
    const timing = parseDeliveryTiming(dto, true);
    const coords = validateCoordinatePair(dto.deliveryLat, dto.deliveryLng, 'delivery');
    if (!coords.hasCoordinates || coords.lat === null || coords.lng === null) {
      throw new BadRequestException('Confirmed delivery coordinates are required');
    }
    await assertDeliveryCovered(this.storeCoverage, coords.lat, coords.lng);
    const settings = await this.settingsService.getPublicSettings();
    if (timing.scheduledDeliveryDate) {
      assertWithinOperatingHours(timing.scheduledDeliveryDate, settings.deliverySchedule);
    }

    let ownerId: string | null = null;
    let buyerName: string;
    let buyerEmail: string | null = null;
    if (dto.buyer.type === 'REGISTERED_CLIENT') {
      const owner = await this.prisma.user.where({ id: dto.buyer.clientId }).select('id', 'name', 'email', 'role').first();
      if (!owner) throw new NotFoundException('Registered client not found');
      if (owner.role !== 'CLIENT') throw new BadRequestException('Registered owner must be a CLIENT');
      ownerId = owner.id;
      buyerName = this.recipientText(owner.name, 120, 'name');
      buyerEmail = owner.email;
    } else if (dto.buyer.type === 'GUEST') {
      buyerName = this.recipientText(dto.buyer.name, 120, 'name');
    } else {
      throw new BadRequestException('Unknown recipient type');
    }
    if (ownerId === actorId) {
      throw new BadRequestException('ADMIN actor is never the buyer');
    }
    const buyerPhone = this.recipientText(dto.buyer.contactPhone, 40, 'phone');
    const recipientName = dto.giftRecipient
      ? this.recipientText(dto.giftRecipient.name, 120, 'name')
      : buyerName;
    const recipientPhone = dto.giftRecipient
      ? this.recipientText(dto.giftRecipient.contactPhone, 40, 'phone')
      : buyerPhone;
    const recipientType = ownerId ? 'REGISTERED_CLIENT' : 'GUEST';
    const consolidated = consolidateOrderItems(dto.items);

    return this.prisma.client.transaction(async (tx) => {
      await this.lockIntent(tx, actorId, idempotencyKey);
      const current = await this.fetchAttemptInTx(tx, actorId, idempotencyKey);
      if (current && current.status !== 'PROCESSING') {
        return this.replayOrConflict(current, requestHash, idempotencyKey);
      }
      if (current && current.id !== attemptId) {
        throw shopError(
          HttpStatus.CONFLICT,
          'ADMIN_PURCHASE_IN_PROGRESS',
          'La compra administrativa sigue en procesamiento',
          { idempotencyKey },
        );
      }

      assertDeliveryFuture(timing, await deliveryClock(tx, this.prisma.client.raw));
      const reserved: Array<{
        productId: string;
        quantity: number;
        price: number;
        unitPriceCents: number;
        name: string;
        sku: string;
        lineTotalCents: number;
      }> = [];
      let totalOrder = 0;
      for (const { productId, quantity } of consolidated) {
        const product = await this.lockProduct(tx, productId);
        const lockedAt = await deliveryClock(tx, this.prisma.client.raw);
        assertDeliveryFuture(timing, lockedAt);
        if (product.stock < quantity) {
          throw new BadRequestException(
            `Stock insuficiente para el producto '${product.name}'. Solicitado: ${quantity}, Disponible: ${product.stock}`,
          );
        }
        const priceCents = typeof product.priceCents === 'bigint'
          ? product.priceCents
          : BigInt(product.priceCents ?? 0);
        if (priceCents <= 0n) {
          throw new BadRequestException(`Product '${product.name}' has no valid price in cents configured`);
        }
        const unitPriceCents = Number(priceCents);
        await tx.execute(
          this.prisma.client.raw.sql`
            UPDATE public.product
            SET stock = ${product.stock - quantity}, "updatedAt" = clock_timestamp()
            WHERE id = ${productId}
          `.affectedCount().build(),
        );
        totalOrder += product.price * quantity;
        reserved.push({
          productId,
          quantity,
          price: product.price,
          unitPriceCents,
          name: product.name,
          sku: product.sku ?? `LEGACY-${product.id.slice(0, 8)}`,
          lineTotalCents: unitPriceCents * quantity,
        });
      }

      const money = calculateMoneyAmounts(
        reserved.map((line) => ({ unitPriceCents: line.unitPriceCents, quantity: line.quantity })),
        { enabled: settings.tax.enabled, rateBps: settings.tax.rateBps },
      );

      const orderId = randomUUID();
      const receiptId = randomUUID();
      const declarationId = randomUUID();
      const year = (await deliveryClock(tx, this.prisma.client.raw)).toZonedDateTimeISO('America/Guayaquil').year;
      const nonce = randomUUID().replace(/-/g, '').toUpperCase();
      const commercialOrderNumber = `RG-${year}-${nonce}`;
      const receiptNumber = `CMP-RG-${year}-${nonce}`;
      const scheduledIso = dto.scheduledDeliveryDate ?? '';
      const windowStart = dto.deliveryWindowStart ?? '';
      const windowEnd = dto.deliveryWindowEnd ?? '';
      const zoneId = dto.zoneId ?? '';

      await tx.execute(
        this.prisma.client.raw.sql`
          INSERT INTO public."order" (
            "id", "userId", "createdById", "recipientType", "recipientName", "recipientPhone",
            "buyerName", "buyerPhone", "contactRevision", "zoneId", "status", "total", "subtotalCents",
            "deliveryAddress", "scheduledDeliveryDate", "deliveryWindowStart", "deliveryWindowEnd",
            "deliveryLat", "deliveryLng", "requiresAdministrativeReview", "createdAt"
          ) VALUES (
            ${orderId}, NULLIF(${ownerId ?? ''}, ''), ${actorId}, ${recipientType}, ${recipientName}, ${recipientPhone},
            ${buyerName}, ${buyerPhone}, 0, NULLIF(${zoneId}, ''), 'PENDING', ${totalOrder}, ${BigInt(money.subtotalCents)},
            ${dto.deliveryAddress.trim()}, NULLIF(${scheduledIso}, '')::timestamptz,
            NULLIF(${windowStart}, '')::timestamptz, NULLIF(${windowEnd}, '')::timestamptz,
            ${dto.deliveryLat}, ${dto.deliveryLng}, false, clock_timestamp()
          )
        `.affectedCount().build(),
      );

      for (const item of reserved) {
        await tx.execute(
          this.prisma.client.raw.sql`
            INSERT INTO public."orderItem" ("id", "orderId", "productId", "quantity", "price", "unitPriceCents")
            VALUES (${randomUUID()}, ${orderId}, ${item.productId}, ${item.quantity}, ${item.price}, ${BigInt(item.unitPriceCents)})
          `.affectedCount().build(),
        );
      }

      const declaredAtPlan = this.prisma.client.raw.sql`
        INSERT INTO public."externalPaymentDeclaration" (
          id, "orderId", method, "declaredById", "declaredAt", note, "createdAt"
        ) VALUES (
          ${declarationId}, ${orderId}, ${dto.payment.method}, ${actorId}, clock_timestamp(),
          NULLIF(${dto.payment.note ?? ''}, ''), clock_timestamp()
        )
        RETURNING "declaredAt"
      `.returnsRow({ declaredAt: 'pg/timestamptz-temporal@1' }).build();
      const [declaration] = await tx.query(declaredAtPlan);
      const declaredAt = toIsoTimestamp(declaration!.declaredAt);

      const snapshot = {
        merchantName: 'REGALÍA',
        buyer: ownerId
          ? { id: ownerId, name: buyerName, phone: buyerPhone, email: buyerEmail }
          : { name: buyerName, phone: buyerPhone },
        recipient: { name: recipientName, phone: recipientPhone },
        delivery: {
          zoneId: dto.zoneId ?? null,
          address: dto.deliveryAddress.trim(),
          location: { lat: coords.lat, lng: coords.lng },
          scheduledDeliveryDate: timing.scheduledDeliveryDate?.toString() ?? null,
        },
        items: reserved.map((item) => ({
          productId: item.productId,
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          lineTotalCents: item.lineTotalCents,
        })),
        pricing: {
          currency: 'USD',
          subtotalCents: money.subtotalCents,
          tax: {
            mode: 'SIMULATED',
            enabled: settings.tax.enabled,
            rateBps: settings.tax.rateBps,
            amountCents: money.taxAmountCents,
          },
          shipping: { status: 'FREE_INCLUDED', amountCents: 0, includedInPrices: true },
          totalCents: money.totalCents,
          settingsVersion: settings.version,
        },
        payment: {
          kind: 'ADMIN_DECLARED_EXTERNAL',
          status: 'DECLARED',
          method: dto.payment.method,
          declaredById: actorId,
          declaredAt,
          note: dto.payment.note ?? null,
        },
        disclaimer: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA',
      };

      await tx.execute(
        this.prisma.client.raw.sql`
          INSERT INTO public."purchaseReceipt" (
            "id", "orderId", "number", "commercialOrderNumber", "buyerId", "issuedAt",
            "merchantName", "currency", "subtotalCents", "taxMode", "taxEnabled", "taxRateBps",
            "taxAmountCents", "shippingStatus", "shippingAmountCents", "totalCents", "snapshot",
            "disclaimer", "createdAt"
          ) VALUES (
            ${receiptId}, ${orderId}, ${receiptNumber}, ${commercialOrderNumber}, NULLIF(${ownerId ?? ''}, ''), clock_timestamp(),
            'REGALÍA', 'USD', ${BigInt(money.subtotalCents)}, 'SIMULATED', ${settings.tax.enabled},
            ${settings.tax.rateBps}, ${BigInt(money.taxAmountCents)}, 'FREE_INCLUDED', 0,
            ${BigInt(money.totalCents)}, ${JSON.stringify(snapshot)}::jsonb,
            'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA', clock_timestamp()
          )
        `.affectedCount().build(),
      );

      const created = await tx.orm.public.Order.where({ id: orderId })
        .include('items', (i) => i.include('product'))
        .include('zone')
        .first();
      const successSnapshot = {
        ...projectOrder(created!, true),
        buyerName,
        buyerPhone,
        contactRevision: 0,
        receipt: { id: receiptId, number: receiptNumber },
        payment: {
          kind: 'ADMIN_DECLARED_EXTERNAL',
          status: 'DECLARED',
          method: dto.payment.method,
          declaredById: actorId,
          declaredAt,
        },
        subtotalCents: money.subtotalCents,
        taxAmountCents: money.taxAmountCents,
        taxRateBps: settings.tax.rateBps,
        shippingAmountCents: 0,
        totalCents: money.totalCents,
      };

      await tx.execute(
        this.prisma.client.raw.sql`
          UPDATE public."adminPurchaseAttempt"
          SET "status" = 'SUCCEEDED',
              "orderId" = ${orderId},
              "receiptId" = ${receiptId},
              "declarationId" = ${declarationId},
              "successSnapshot" = ${JSON.stringify(successSnapshot)}::jsonb,
              "updatedAt" = clock_timestamp()
          WHERE id = ${attemptId} AND status = 'PROCESSING'
        `.affectedCount().build(),
      );

      assertDeliveryFuture(timing, await deliveryClock(tx, this.prisma.client.raw));
      return successSnapshot;
    });
  }

  private async fetchAttemptInTx(tx: Transaction, actorId: string, idempotencyKey: string) {
    const plan = this.prisma.client.raw.sql`
      SELECT "id", "actorId", "idempotencyKey", "requestHash", "status",
             "orderId", "receiptId", "declarationId", "errorCode", "errorMessage",
             "errorDetails", "successSnapshot", "updatedAt"
      FROM public."adminPurchaseAttempt"
      WHERE "actorId" = ${actorId} AND "idempotencyKey" = ${idempotencyKey}
    `
      .returnsRow({
        id: 'pg/text@1',
        actorId: 'pg/text@1',
        idempotencyKey: 'pg/text@1',
        requestHash: 'pg/text@1',
        status: 'pg/text@1',
        orderId: 'pg/text@1',
        receiptId: 'pg/text@1',
        declarationId: 'pg/text@1',
        errorCode: 'pg/text@1',
        errorMessage: 'pg/text@1',
        errorDetails: 'pg/jsonb@1',
        successSnapshot: 'pg/jsonb@1',
        updatedAt: 'pg/timestamptz-temporal@1',
      })
      .build();
    const [row] = await tx.query(plan);
    return row?.status ? (row as unknown as AttemptRow) : null;
  }

  private async lockProduct(tx: Transaction, productId: string) {
    const plan = this.prisma.client.raw.sql`
      SELECT id, name, sku, price, "priceCents", stock
      FROM public.product WHERE id = ${productId} FOR UPDATE
    `
      .returnsRow({
        id: 'pg/text@1',
        name: 'pg/text@1',
        sku: 'pg/text@1',
        price: 'pg/float8@1',
        priceCents: 'pg/int8@1',
        stock: 'pg/int4@1',
      })
      .build();
    const [product] = await tx.query(plan);
    if (!product) {
      throw new NotFoundException(`Producto con ID '${productId}' no encontrado`);
    }
    return product as {
      id: string;
      name: string;
      sku: string | null;
      price: number;
      priceCents: bigint | null;
      stock: number;
    };
  }

  private projectReceipt(row: Record<string, unknown>) {
    const snap = row.snapshot as Record<string, unknown>;
    const paymentSnap = (snap?.payment ?? {}) as Record<string, unknown>;
    const buyerSnap = (snap?.buyer ?? {}) as Record<string, unknown>;
    const recipientSnap = (snap?.recipient ?? {}) as Record<string, unknown>;
    const items = Array.isArray(snap?.items) ? snap.items as Array<Record<string, unknown>> : [];
    const declared = paymentSnap.kind === 'ADMIN_DECLARED_EXTERNAL' || paymentSnap.status === 'DECLARED';
    const payment = declared
      ? {
          kind: 'ADMIN_DECLARED_EXTERNAL' as const,
          status: 'DECLARED' as const,
          method: paymentSnap.method,
          declaredById: paymentSnap.declaredById,
          declaredAt: paymentSnap.declaredAt,
        }
      : {
          status: 'APPROVED' as const,
          reference: paymentSnap.reference,
          cardLast4: paymentSnap.cardLast4,
        };
    const buyer: Record<string, unknown> = { name: buyerSnap.name };
    if (typeof buyerSnap.email === 'string' && buyerSnap.email.trim()) buyer.email = buyerSnap.email.trim();
    if (typeof buyerSnap.phone === 'string' && buyerSnap.phone.trim()) buyer.phone = buyerSnap.phone.trim();
    return {
      id: row.id,
      number: row.number,
      orderId: row.orderId,
      issuedAt: toIsoTimestamp(row.issuedAt),
      merchantName: row.merchantName || 'REGALÍA',
      buyer,
      recipient: { name: recipientSnap.name, phone: recipientSnap.phone },
      items: items.map((item) => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        unitPriceCents: Number(item.unitPriceCents),
        lineTotalCents: Number(item.lineTotalCents),
      })),
      currency: 'USD',
      subtotalCents: Number(row.subtotalCents),
      totalCents: Number(row.totalCents),
      payment,
      disclaimer: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA',
      tax: {
        mode: 'SIMULATED',
        enabled: row.taxEnabled,
        rateBps: row.taxRateBps,
        ratePercent: Number(row.taxRateBps) / 100,
        amountCents: Number(row.taxAmountCents),
      },
      shipping: { status: 'FREE_INCLUDED', amountCents: 0, includedInPrices: true },
    };
  }
}
