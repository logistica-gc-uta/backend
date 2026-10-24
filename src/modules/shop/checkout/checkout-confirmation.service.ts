import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { toInstant } from '../../../common/temporal.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { deliveryClock, parseDeliveryTiming } from '../../orders/order-delivery.util.js';
import { evaluatePlanningEligibility, validateCoordinatePair } from '../../orders/order-geography.util.js';
import { lockInventoryProduct } from '../../orders/order-inventory.util.js';
import { ShopSettingsPublicDto } from '../settings/dto/shop-settings.dto.js';
import { ShopSettingsService } from '../settings/shop-settings.service.js';
import { shopError } from '../shop-http.filter.js';
import {
  buildCanonicalIntent,
  CanonicalIntent,
  hashCanonicalIntent,
  lookupFixtureIdFromNumber,
} from './checkout-intent.util.js';
import { calculateMoneyAmounts, MoneyLineInput } from './checkout-money.util.js';
import { CheckoutRequestDto } from './dto/checkout-request.dto.js';
import { CheckoutSuccessDto } from './dto/checkout-response.dto.js';
import { verifyQuoteToken } from './quote-token.util.js';
import {
  assertPaymentSimulationEnabled,
  validateSimulatedCard,
} from './simulated-card.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];

interface ProductLockedRow {
  id: string;
  name: string;
  sku: string | null;
  stock: number;
  price: number;
  priceCents: bigint | null;
  isPublished: boolean;
  categoryId: string | null;
  categoryIsActive: boolean | null;
  imageUrl?: string | null;
}

interface CardLockedRow {
  id: string;
  fixtureId: string;
  last4: string;
  active: boolean;
  balanceCents: bigint;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
}

interface ZoneRow {
  id: string;
  name: string;
  code: string;
  depotLat: number | null;
  depotLng: number | null;
}

interface CheckoutAttemptRow {
  id: string;
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  orderId: string | null;
  receiptId: string | null;
  paymentAttemptId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
  successSnapshot: Record<string, unknown> | null;
}

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class CheckoutConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: ShopSettingsService,
  ) {}

  private statusForCode(code: string): number {
    switch (code) {
      case 'STOCK_UNAVAILABLE':
      case 'PRODUCT_UNPUBLISHED':
      case 'PRICE_CHANGED':
      case 'QUOTE_EXPIRED':
      case 'SHOP_SETTINGS_CHANGED':
      case 'IDEMPOTENCY_KEY_REUSED':
        return HttpStatus.CONFLICT; // 409
      case 'CARD_INVALID':
      case 'CARD_EXPIRED':
      case 'INSUFFICIENT_DEMO_FUNDS':
      case 'DELIVERY_INVALID':
      case 'DELIVERY_OUTSIDE_HOURS':
      case 'QUANTITY_LIMIT_EXCEEDED':
        return HttpStatus.UNPROCESSABLE_ENTITY; // 422
      case 'PRODUCT_NOT_FOUND':
      case 'ZONE_NOT_FOUND':
      case 'CHECKOUT_ATTEMPT_NOT_FOUND':
        return HttpStatus.NOT_FOUND; // 404
      case 'PAYMENT_SIMULATION_DISABLED':
        return HttpStatus.SERVICE_UNAVAILABLE; // 503
      case 'VALIDATION_ERROR':
        return HttpStatus.BAD_REQUEST; // 400
      case 'UNAUTHORIZED':
        return HttpStatus.UNAUTHORIZED; // 401
      default:
        return HttpStatus.INTERNAL_SERVER_ERROR; // 500
    }
  }

  private validateIdempotencyKey(key: string | undefined): string {
    if (!key || typeof key !== 'string') {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Idempotency-Key header is required',
        { field: 'Idempotency-Key' },
      );
    }
    const trimmed = key.trim();
    if (!UUID_V4_REGEX.test(trimmed)) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Idempotency-Key header must be a valid UUID v4',
        { field: 'Idempotency-Key', value: trimmed },
      );
    }
    return trimmed;
  }

  private async fetchExistingAttempt(
    userId: string,
    idempotencyKey: string,
  ): Promise<CheckoutAttemptRow | null> {
    return this.prisma.client.transaction(async (tx) => {
      const plan = this.prisma.client.raw.sql`
        SELECT "id", "userId", "idempotencyKey", "requestHash", "status",
               "orderId", "receiptId", "paymentAttemptId", "errorCode", "errorMessage",
               "errorDetails", "successSnapshot"
        FROM public."checkoutAttempt"
        WHERE "userId" = ${userId} AND "idempotencyKey" = ${idempotencyKey}
      `
        .returnsRow({
          id: 'pg/text@1',
          userId: 'pg/text@1',
          idempotencyKey: 'pg/text@1',
          requestHash: 'pg/text@1',
          status: 'pg/text@1',
          orderId: 'pg/text@1',
          receiptId: 'pg/text@1',
          paymentAttemptId: 'pg/text@1',
          errorCode: 'pg/text@1',
          errorMessage: 'pg/text@1',
          errorDetails: 'pg/jsonb@1',
          successSnapshot: 'pg/jsonb@1',
        })
        .build();

      const [row] = await tx.query(plan);
      if (!row || !row.status) {
        return null;
      }
      return (row as unknown as CheckoutAttemptRow);
    });
  }

  private async recordTerminalRejection(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    errorCode: string,
    errorMessage: string,
    errorDetails: Record<string, unknown>,
  ): Promise<CheckoutAttemptRow | null> {
    return this.prisma.client.transaction(async (tx) => {
      // Serialize under transaction advisory lock
      const lockPlan = this.prisma.client.raw.sql`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtext('checkout_intent'), hashtext(${userId} || ':' || ${idempotencyKey}))
      `
        .returnsRow({ locked: 'pg/int4@1' })
        .build();
      await tx.query(lockPlan);

      // Recheck if a concurrent winner committed or resolved under the lock
      const checkPlan = this.prisma.client.raw.sql`
        SELECT "id", "userId", "idempotencyKey", "requestHash", "status",
               "orderId", "receiptId", "paymentAttemptId", "errorCode", "errorMessage",
               "errorDetails", "successSnapshot"
        FROM public."checkoutAttempt"
        WHERE "userId" = ${userId} AND "idempotencyKey" = ${idempotencyKey}
      `
        .returnsRow({
          id: 'pg/text@1',
          userId: 'pg/text@1',
          idempotencyKey: 'pg/text@1',
          requestHash: 'pg/text@1',
          status: 'pg/text@1',
          orderId: 'pg/text@1',
          receiptId: 'pg/text@1',
          paymentAttemptId: 'pg/text@1',
          errorCode: 'pg/text@1',
          errorMessage: 'pg/text@1',
          errorDetails: 'pg/jsonb@1',
          successSnapshot: 'pg/jsonb@1',
        })
        .build();

      const [existing] = await tx.query(checkPlan);
      if (existing && (existing as any).status) {
        return existing as unknown as CheckoutAttemptRow;
      }

      // No winner: persist REJECTED attempt
      const attemptId = randomUUID();
      const insertPlan = this.prisma.client.raw.sql`
        INSERT INTO public."checkoutAttempt" (\n          "id", "userId", "idempotencyKey", "requestHash", "status",
          "errorCode", "errorMessage", "errorDetails", "createdAt", "updatedAt"
        ) VALUES (
          ${attemptId}, ${userId}, ${idempotencyKey}, ${requestHash}, 'REJECTED',
          ${errorCode}, ${errorMessage}, ${JSON.stringify(errorDetails)}::jsonb, clock_timestamp(), clock_timestamp()
        )
      `.affectedCount().build();

      await tx.execute(insertPlan);
      return null;
    });
  }

  /**
   * Executes atomic purchase checkout confirmation:
   * 1. Validates Idempotency-Key UUIDv4.
   * 2. Extracts canonical intent (consolidated lines, normalized delivery, quote token, safe fixture identity).
   * 3. Fast path: Replays known success BEFORE quote expiry/simulation gating/settings/card expiry.
   * 4. Acquires PostgreSQL locks in documented global hierarchy:
   *    Level 0: Transaction Advisory Lock on (userId, idempotencyKey)
   *    Level 1: ShopBusinessSettings FOR SHARE
   *    Level 2: Category rows in ascending codepoint order (categoryId ASC) FOR SHARE
   *    Level 3: Product inventory rows in ascending codepoint order (productId ASC) FOR UPDATE
   *    Level 4: SimulatedCard row FOR UPDATE
   * 5. Under advisory lock and row locks:
   *    - Rechecks cached attempt under serialization
   *    - Reads authoritative DB clock (nowDb)
   *    - Validates simulated card identity and calendar expiry against nowDb
   *    - Verifies quote token signature, ownership, and expiry against nowDb
   *    - Binds full canonical items + delivery to signed quotation snapshot
   *    - Validates current settings version, dynamic SKU limits, product publication, active category, stock, price
   *    - Validates future delivery instant, operating hours, zone & depot planning eligibility
   *    - Validates card funds (without exposing balance in errors)
   * 6. All-or-nothing execution:
   *    - Decrements stock and card balance
   *    - Fails closed if buyer user row is missing (no fake fallback)
   *    - Generates commercial numbers with full UUID entropy
   *    - Creates Order, OrderItems, PaymentAttempt, PurchaseReceipt (#34 snapshot with productId)
   *    - Commits CheckoutAttempt (SUCCEEDED)
   */
  async confirmCheckout(
    buyerUserId: string,
    rawIdempotencyKey: string | undefined,
    dto: CheckoutRequestDto,
  ): Promise<CheckoutSuccessDto> {
    const idempotencyKey = this.validateIdempotencyKey(rawIdempotencyKey);

    // 3. Fast-path: replay known success BEFORE simulation gating or quote expiry check
    const existing = await this.fetchExistingAttempt(buyerUserId, idempotencyKey);
    if (existing) {
      const cardFixtureId = lookupFixtureIdFromNumber(dto.paymentCard?.number) ?? 'UNKNOWN_FIXTURE';
      const canonicalIntent = buildCanonicalIntent({
        items: dto.items ?? [],
        delivery: dto.delivery,
        quoteToken: dto.quoteToken ?? '',
        cardFixtureId,
      });
      const requestHash = hashCanonicalIntent(canonicalIntent);

      if (existing.requestHash !== requestHash) {
        throw shopError(
          HttpStatus.CONFLICT,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key has already been used with a different request payload',
          { idempotencyKey },
        );
      }
      if (existing.status === 'SUCCEEDED' && existing.successSnapshot) {
        return existing.successSnapshot as unknown as CheckoutSuccessDto;
      }
      if (existing.status === 'REJECTED' && existing.errorCode) {
        throw shopError(
          this.statusForCode(existing.errorCode),
          existing.errorCode,
          existing.errorMessage ?? 'Solicitud rechazada previamente',
          existing.errorDetails ?? {},
        );
      }
    }

    // New request: assert simulation gating before proceeding
    assertPaymentSimulationEnabled();

    // 1. Safe in-memory card fixture lookup (NEVER persists or hashes PAN or CVV)
    const cardFixtureId = lookupFixtureIdFromNumber(dto.paymentCard?.number) ?? 'UNKNOWN_FIXTURE';

    // 2. Build safe canonical intent and compute deterministic request hash
    const canonicalIntent: CanonicalIntent = buildCanonicalIntent({
      items: dto.items,
      delivery: dto.delivery,
      quoteToken: dto.quoteToken,
      cardFixtureId,
    });
    const requestHash = hashCanonicalIntent(canonicalIntent);

    // 4. Validate coordinates syntax and parse delivery instant before locks
    validateCoordinatePair(
      dto.delivery.deliveryLocation.lat,
      dto.delivery.deliveryLocation.lng,
      'delivery',
    );
    const timing = parseDeliveryTiming(
      { scheduledDeliveryDate: dto.delivery.scheduledDeliveryDate },
      true,
    );
    const scheduledInstant = timing.scheduledDeliveryDate!;

    const consolidatedItems = canonicalIntent.items;
    const sortedProductIds = [...new Set(consolidatedItems.map((i) => i.productId))].sort(
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    );

    // 5. Execute single pinned business transaction
    try {
      return await this.prisma.client.transaction(async (tx: Transaction) => {
        // LOCK LEVEL 0: PostgreSQL Transaction Advisory Lock on (userId, idempotencyKey)
        const lockPlan = this.prisma.client.raw.sql`
          SELECT 1 AS locked
          FROM pg_advisory_xact_lock(hashtext('checkout_intent'), hashtext(${buyerUserId} || ':' || ${idempotencyKey}))
        `
          .returnsRow({ locked: 'pg/int4@1' })
          .build();
        await tx.query(lockPlan);

        // Double-check attempt under advisory lock to serialize concurrent races
        const lockedAttemptPlan = this.prisma.client.raw.sql`
          SELECT "id", "userId", "idempotencyKey", "requestHash", "status",
                 "orderId", "receiptId", "paymentAttemptId", "errorCode", "errorMessage",
                 "errorDetails", "successSnapshot"
          FROM public."checkoutAttempt"
          WHERE "userId" = ${buyerUserId} AND "idempotencyKey" = ${idempotencyKey}
        `
          .returnsRow({
            id: 'pg/text@1',
            userId: 'pg/text@1',
            idempotencyKey: 'pg/text@1',
            requestHash: 'pg/text@1',
            status: 'pg/text@1',
            orderId: 'pg/text@1',
            receiptId: 'pg/text@1',
            paymentAttemptId: 'pg/text@1',
            errorCode: 'pg/text@1',
            errorMessage: 'pg/text@1',
            errorDetails: 'pg/jsonb@1',
            successSnapshot: 'pg/jsonb@1',
          })
          .build();
        const [lockedAttempt] = await tx.query(lockedAttemptPlan);
        if (lockedAttempt && (lockedAttempt as any).status) {
          const attemptRow = lockedAttempt as unknown as CheckoutAttemptRow;
          if (attemptRow.requestHash !== requestHash) {
            throw shopError(
              HttpStatus.CONFLICT,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key has already been used with a different request payload',
              { idempotencyKey },
            );
          }
          if (attemptRow.status === 'SUCCEEDED' && attemptRow.successSnapshot) {
            return attemptRow.successSnapshot as unknown as CheckoutSuccessDto;
          }
          if (attemptRow.status === 'REJECTED' && attemptRow.errorCode) {
            throw shopError(
              this.statusForCode(attemptRow.errorCode),
              attemptRow.errorCode,
              attemptRow.errorMessage ?? 'Solicitud rechazada previamente',
              attemptRow.errorDetails ?? {},
            );
          }
        }

        // LOCK LEVEL 1: Settings locked FOR SHARE
        const currentSettings: ShopSettingsPublicDto =
          await this.settingsService.getPublicSettings(tx);

        // Discover category IDs for products to lock categories BEFORE products (consistent with CatalogService)
        const sortedCategoryIds: string[] = [];
        for (const productId of sortedProductIds) {
          const catPlan = this.prisma.client.raw.sql`
            SELECT "categoryId" FROM public.product WHERE id = ${productId} AND "categoryId" IS NOT NULL
          `
            .returnsRow({ categoryId: 'pg/text@1' })
            .build();
          const [row] = await tx.query(catPlan);
          const catId = (row as unknown as { categoryId: string | null } | undefined)?.categoryId;
          if (catId && !sortedCategoryIds.includes(catId)) {
            sortedCategoryIds.push(catId);
          }
        }
        sortedCategoryIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

        // LOCK LEVEL 2: Categories locked FOR SHARE in deterministic ascending codepoint order
        const categoryMap = new Map<string, { id: string; isActive: boolean }>();
        for (const catId of sortedCategoryIds) {
          const catLockPlan = this.prisma.client.raw.sql`
            SELECT id, "isActive"
            FROM public.category
            WHERE id = ${catId}
            FOR SHARE
          `
            .returnsRow({ id: 'pg/text@1', isActive: 'pg/bool@1' })
            .build();
          const [catRow] = await tx.query(catLockPlan);
          if (catRow) {
            categoryMap.set(catId, catRow as unknown as { id: string; isActive: boolean });
          }
        }

        // LOCK LEVEL 3: Products locked FOR UPDATE in deterministic ascending codepoint order
        const productMap = new Map<string, ProductLockedRow>();
        for (const productId of sortedProductIds) {
          await lockInventoryProduct(tx, this.prisma.client.raw, productId);
          const plan = this.prisma.client.raw.sql`
            SELECT p.id, p.name, p.sku, p.price, p.stock, p."priceCents", p."isPublished",
                   p."categoryId", c."isActive" AS "categoryIsActive"
            FROM public.product p
            LEFT JOIN public.category c ON c.id = p."categoryId"
            WHERE p.id = ${productId}
          `
            .returnsRow({
              id: 'pg/text@1',
              name: 'pg/text@1',
              sku: 'pg/text@1',
              price: 'pg/float8@1',
              stock: 'pg/int4@1',
              priceCents: 'pg/int8@1',
              isPublished: 'pg/bool@1',
              categoryId: 'pg/text@1',
              categoryIsActive: 'pg/bool@1',
            })
            .build();

          const [prodRow] = await tx.query(plan);
          if (prodRow) {
            productMap.set(productId, prodRow as unknown as ProductLockedRow);
          }
        }

        // LOCK LEVEL 4: SimulatedCard locked FOR UPDATE
        const cardLockPlan = this.prisma.client.raw.sql`
          SELECT id, "fixtureId", "last4", active, "balanceCents"
          FROM public."simulatedCard"
          WHERE "fixtureId" = ${cardFixtureId}
          FOR UPDATE
        `
          .returnsRow({
            id: 'pg/text@1',
            fixtureId: 'pg/text@1',
            last4: 'pg/text@1',
            active: 'pg/bool@1',
            balanceCents: 'pg/int8@1',
          })
          .build();
        const [cardRow] = await tx.query(cardLockPlan);
        const lockedCard = (cardRow as unknown as CardLockedRow) ?? null;

        // Authoritative DB clock read AFTER locks
        const nowDb = await deliveryClock(tx, this.prisma.client.raw);

        // Validate simulated card identity and calendar expiry against authoritative nowDb
        const validatedIdentity = validateSimulatedCard(dto.paymentCard, nowDb);
        if (!lockedCard || !lockedCard.active) {
          throw shopError(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'CARD_INVALID',
            'La tarjeta de pago de demostración no está activa o no fue encontrada',
            {},
          );
        }

        // Verify quote token cryptographic signature, buyer ownership, and expiry against nowDb
        const quotePayload = verifyQuoteToken(dto.quoteToken, buyerUserId, nowDb);

        // SIGNED INTENT BINDING: Enforce strict identity of items/quantities against signed quote
        if (quotePayload.items.length !== consolidatedItems.length) {
          throw shopError(
            HttpStatus.BAD_REQUEST,
            'VALIDATION_ERROR',
            'Los productos no coinciden con la cotización firmada',
            { reason: 'ITEMS_MISMATCH' },
          );
        }

        for (let i = 0; i < consolidatedItems.length; i++) {
          const reqItem = consolidatedItems[i]!;
          const qItem = quotePayload.items[i]!;
          if (reqItem.productId !== qItem.productId || reqItem.quantity !== qItem.quantity) {
            throw shopError(
              HttpStatus.BAD_REQUEST,
              'VALIDATION_ERROR',
              'La composición o cantidades de los productos no coinciden con la cotización firmada',
              {
                reason: 'ITEMS_MISMATCH',
                requested: { productId: reqItem.productId, quantity: reqItem.quantity },
                quoted: { productId: qItem.productId, quantity: qItem.quantity },
              },
            );
          }
        }

        // SIGNED INTENT BINDING: Enforce strict identity of delivery fields against signed quote
        const reqDelivery = canonicalIntent.delivery;
        const qDelivery = quotePayload.delivery;
        const reqDate = toInstant(reqDelivery.scheduledDeliveryDate).toString();
        const qDate = toInstant(qDelivery.scheduledDeliveryDate).toString();

        const deliveryMismatch =
          reqDelivery.recipient.name !== qDelivery.recipient.name ||
          reqDelivery.recipient.phone !== qDelivery.recipient.phone ||
          reqDelivery.zoneId !== qDelivery.zoneId ||
          reqDelivery.deliveryAddress !== qDelivery.deliveryAddress ||
          reqDelivery.deliveryLocation.lat !== qDelivery.deliveryLocation.lat ||
          reqDelivery.deliveryLocation.lng !== qDelivery.deliveryLocation.lng ||
          reqDate !== qDate ||
          (reqDelivery.deliveryNotes ?? '') !== (qDelivery.deliveryNotes ?? '');

        if (deliveryMismatch) {
          throw shopError(
            HttpStatus.BAD_REQUEST,
            'VALIDATION_ERROR',
            'Los datos de entrega no coinciden con la cotización firmada',
            { reason: 'DELIVERY_MISMATCH' },
          );
        }

        // Enforce settings version binding
        if (quotePayload.settingsVersion !== currentSettings.version) {
          throw shopError(
            HttpStatus.CONFLICT,
            'SHOP_SETTINGS_CHANGED',
            'La configuración comercial ha cambiado desde la cotización',
            {
              quotedVersion: quotePayload.settingsVersion,
              currentVersion: currentSettings.version,
            },
          );
        }

        // Enforce tax configuration binding
        if (
          quotePayload.tax.enabled !== currentSettings.tax.enabled ||
          quotePayload.tax.rateBps !== currentSettings.tax.rateBps
        ) {
          throw shopError(
            HttpStatus.CONFLICT,
            'SHOP_SETTINGS_CHANGED',
            'Las condiciones tributarias simuladas han cambiado desde la cotización',
            {
              quotedTax: quotePayload.tax,
              currentTax: {
                enabled: currentSettings.tax.enabled,
                rateBps: currentSettings.tax.rateBps,
              },
            },
          );
        }

        // Enforce SKU limits against current settings
        for (const line of consolidatedItems) {
          if (line.quantity > currentSettings.limits.maxUnitsPerSkuPerOrder) {
            throw shopError(
              HttpStatus.UNPROCESSABLE_ENTITY,
              'QUANTITY_LIMIT_EXCEEDED',
              'La cantidad supera el límite comercial por producto',
              {
                productId: line.productId,
                requestedQuantity: line.quantity,
                maximumAllowed: currentSettings.limits.maxUnitsPerSkuPerOrder,
              },
            );
          }
        }

        // Enforce product publication, category activity, live stock, and exact price snapshots
        const moneyLines: MoneyLineInput[] = [];
        const confirmedItems: Array<{
          productId: string;
          name: string;
          sku: string | null;
          quantity: number;
          unitPriceCents: number;
          lineTotalCents: number;
        }> = [];

        for (const item of consolidatedItems) {
          const prod = productMap.get(item.productId);
          if (!prod) {
            throw shopError(
              HttpStatus.NOT_FOUND,
              'PRODUCT_NOT_FOUND',
              `Producto con ID '${item.productId}' no encontrado`,
              { productId: item.productId },
            );
          }

          if (!prod.categoryId || !categoryMap.has(prod.categoryId)) {
            throw shopError(
              HttpStatus.CONFLICT,
              'PRODUCT_UNPUBLISHED',
              `El producto '${prod.name}' no tiene categoría asignada o su categoría cambió concurrentemente`,
              { productId: prod.id },
            );
          }

          const lockedCategory = categoryMap.get(prod.categoryId)!;

          if (!prod.isPublished || lockedCategory.isActive !== true) {
            throw shopError(
              HttpStatus.CONFLICT,
              'PRODUCT_UNPUBLISHED',
              `El producto '${prod.name}' no se encuentra publicado o su categoría está inactiva`,
              { productId: prod.id },
            );
          }

          if (prod.stock < item.quantity) {
            throw shopError(
              HttpStatus.CONFLICT,
              'STOCK_UNAVAILABLE',
              `Inventario insuficiente para el producto '${prod.name}'`,
              {
                productId: prod.id,
                requestedQuantity: item.quantity,
                availableStock: prod.stock,
              },
            );
          }

          if (
            prod.priceCents === null ||
            prod.priceCents === undefined ||
            prod.priceCents <= 0n
          ) {
            throw shopError(
              HttpStatus.CONFLICT,
              'PRODUCT_UNPUBLISHED',
              `El producto '${prod.name}' no tiene precio en centavos configurado`,
              { productId: prod.id },
            );
          }

          const quotedLine = quotePayload.items.find(
            (q) => q.productId === item.productId,
          );
          if (!quotedLine) {
            throw shopError(
              HttpStatus.CONFLICT,
              'PRICE_CHANGED',
              `El producto '${prod.name}' no estaba incluido en la cotización`,
              { productId: prod.id },
            );
          }

          const currentUnitPriceCents = Number(prod.priceCents);
          if (currentUnitPriceCents !== quotedLine.unitPriceCents) {
            throw shopError(
              HttpStatus.CONFLICT,
              'PRICE_CHANGED',
              `El precio del producto '${prod.name}' ha cambiado`,
              {
                productId: prod.id,
                quotedUnitPriceCents: quotedLine.unitPriceCents,
                currentUnitPriceCents,
              },
            );
          }

          moneyLines.push({
            unitPriceCents: currentUnitPriceCents,
            quantity: item.quantity,
          });

          confirmedItems.push({
            productId: prod.id,
            name: prod.name,
            sku: prod.sku ?? null,
            quantity: item.quantity,
            unitPriceCents: currentUnitPriceCents,
            lineTotalCents: currentUnitPriceCents * item.quantity,
          });
        }

        // Enforce strictly future delivery date relative to post-lock DB clock
        if (Temporal.Instant.compare(scheduledInstant, nowDb) <= 0) {
          throw shopError(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'DELIVERY_INVALID',
            'La fecha de entrega programada debe ser estrictamente futura',
            { scheduledDeliveryDate: dto.delivery.scheduledDeliveryDate },
          );
        }

        // Enforce operating hours in America/Guayaquil
        const localZonedDateTime = scheduledInstant.toZonedDateTimeISO('America/Guayaquil');
        const localTime = localZonedDateTime.toPlainTime();
        const startTime = Temporal.PlainTime.from(currentSettings.deliverySchedule.startTime);
        const endTime = Temporal.PlainTime.from(currentSettings.deliverySchedule.endTime);

        if (
          Temporal.PlainTime.compare(localTime, startTime) < 0 ||
          Temporal.PlainTime.compare(localTime, endTime) > 0
        ) {
          const reqTime = `${String(localTime.hour).padStart(2, '0')}:${String(localTime.minute).padStart(2, '0')}`;
          throw shopError(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'DELIVERY_OUTSIDE_HOURS',
            `Horario de entrega (${reqTime}) fuera del horario comercial (${currentSettings.deliverySchedule.startTime} - ${currentSettings.deliverySchedule.endTime})`,
            {
              startTime: currentSettings.deliverySchedule.startTime,
              endTime: currentSettings.deliverySchedule.endTime,
              requestedTime: reqTime,
            },
          );
        }

        // Validate zone and depot planning eligibility
        const zonePlan = this.prisma.client.raw.sql`
          SELECT id, name, code, "depotLat", "depotLng"
          FROM public.zone
          WHERE id = ${dto.delivery.zoneId}
        `
          .returnsRow({
            id: 'pg/text@1',
            name: 'pg/text@1',
            code: 'pg/text@1',
            depotLat: 'pg/float8@1',
            depotLng: 'pg/float8@1',
          })
          .build();
        const [zoneRow] = await tx.query(zonePlan);
        const zone = (zoneRow as unknown as ZoneRow) ?? null;

        if (!zone) {
          throw shopError(
            HttpStatus.NOT_FOUND,
            'ZONE_NOT_FOUND',
            `Zona con ID '${dto.delivery.zoneId}' no encontrada`,
            { zoneId: dto.delivery.zoneId },
          );
        }

        const { planningEligibility } = evaluatePlanningEligibility(
          {
            deliveryLat: dto.delivery.deliveryLocation.lat,
            deliveryLng: dto.delivery.deliveryLocation.lng,
          },
          zone,
        );

        if (!planningEligibility.eligible) {
          throw shopError(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'DELIVERY_INVALID',
            'La ubicación o zona no es elegible para entrega',
            { reasons: planningEligibility.reasons },
          );
        }

        // Exact money calculations
        const moneyResult = calculateMoneyAmounts(moneyLines, {
          enabled: currentSettings.tax.enabled,
          rateBps: currentSettings.tax.rateBps,
        });

        if (moneyResult.totalCents !== quotePayload.totalCents) {
          throw shopError(
            HttpStatus.CONFLICT,
            'PRICE_CHANGED',
            'El importe total difiere de la cotización confirmada',
            {
              quotedTotalCents: quotePayload.totalCents,
              calculatedTotalCents: moneyResult.totalCents,
            },
          );
        }

        // Validate simulated card funds under lock (exposing requiredCents only)
        const totalCentsBigInt = BigInt(moneyResult.totalCents);
        if (lockedCard.balanceCents < totalCentsBigInt) {
          throw shopError(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'INSUFFICIENT_DEMO_FUNDS',
            'Saldo ficticio insuficiente en la tarjeta de demostración',
            {
              requiredCents: moneyResult.totalCents,
            },
          );
        }

        // 6. ALL-OR-NOTHING COMMIT
        // A. Decrement inventory stock
        for (const item of consolidatedItems) {
          const prod = productMap.get(item.productId)!;
          const newStock = prod.stock - item.quantity;
          const updateStockPlan = this.prisma.client.raw.sql`
            UPDATE public.product
            SET stock = ${newStock}
            WHERE id = ${item.productId}
          `.affectedCount().build();
          await tx.execute(updateStockPlan);
        }

        // B. Decrement simulated card balance
        const newBalance = lockedCard.balanceCents - totalCentsBigInt;
        const updateBalancePlan = this.prisma.client.raw.sql`
          UPDATE public."simulatedCard"
          SET "balanceCents" = ${newBalance}, "updatedAt" = clock_timestamp()
          WHERE "fixtureId" = ${lockedCard.fixtureId}
        `.affectedCount().build();
        await tx.execute(updateBalancePlan);

        // C. Fetch buyer user details for receipt snapshot: fail closed if missing
        const userPlan = this.prisma.client.raw.sql`
          SELECT id, name, email
          FROM public."user"
          WHERE id = ${buyerUserId}
        `
          .returnsRow({ id: 'pg/text@1', name: 'pg/text@1', email: 'pg/text@1' })
          .build();
        const [buyerRow] = await tx.query(userPlan);
        if (!buyerRow) {
          throw shopError(
            HttpStatus.UNAUTHORIZED,
            'UNAUTHORIZED',
            'Authenticated buyer record not found in database',
            { buyerUserId },
          );
        }
        const buyer = buyerRow as unknown as UserRow;

        // D. Generate commercial numbers with full UUID entropy within 64-char limit
        const orderId = randomUUID();
        const receiptId = randomUUID();
        const paymentAttemptId = randomUUID();
        const checkoutAttemptId = randomUUID();
        const year = nowDb.toZonedDateTimeISO('America/Guayaquil').year;
        const nonce = randomUUID().replace(/-/g, '').toUpperCase();
        const commercialOrderNumber = `RG-${year}-${nonce}`;
        const receiptNumber = `CMP-RG-${year}-${nonce}`;
        const paymentReference = `PAY-DEMO-${year}-${nonce}`;

        // E. Insert Order (Float total = SUBTOTAL / 100, exact subtotalCents BigInt)
        const subtotalFloat = moneyResult.subtotalCents / 100;
        const scheduledDeliveryIso = new Date(scheduledInstant.epochMilliseconds).toISOString();

        const insertOrderPlan = this.prisma.client.raw.sql`
          INSERT INTO public."order" (
            "id", "userId", "createdById", "recipientType", "recipientName", "recipientPhone",
            "zoneId", "status", "total", "subtotalCents", "deliveryAddress", "scheduledDeliveryDate",
            "deliveryLat", "deliveryLng", "requiresAdministrativeReview", "createdAt"
          ) VALUES (
            ${orderId}, ${buyerUserId}, ${buyerUserId}, 'REGISTERED_CLIENT',
            ${dto.delivery.recipient.name.trim()}, ${dto.delivery.recipient.phone.trim()},
            ${dto.delivery.zoneId}, 'PENDING', ${subtotalFloat}, ${BigInt(moneyResult.subtotalCents)},
            ${dto.delivery.deliveryAddress.trim()}, ${scheduledDeliveryIso}::timestamptz,
            ${dto.delivery.deliveryLocation.lat}, ${dto.delivery.deliveryLocation.lng},
            false, clock_timestamp()
          )
        `.affectedCount().build();
        await tx.execute(insertOrderPlan);

        // F. Insert OrderItems
        for (const item of confirmedItems) {
          const itemPriceFloat = item.unitPriceCents / 100;
          const insertItemPlan = this.prisma.client.raw.sql`
            INSERT INTO public."orderItem" (
              "id", "orderId", "productId", "quantity", "price", "unitPriceCents"
            ) VALUES (
              ${randomUUID()}, ${orderId}, ${item.productId}, ${item.quantity},
              ${itemPriceFloat}, ${BigInt(item.unitPriceCents)}
            )
          `.affectedCount().build();
          await tx.execute(insertItemPlan);
        }

        // G. Insert PaymentAttempt (full integer money snapshots)
        const insertPaymentPlan = this.prisma.client.raw.sql`
          INSERT INTO public."paymentAttempt" (
            "id", "orderId", "buyerId", "cardFixtureId", "status", "currency",
            "subtotalCents", "taxEnabled", "taxRateBps", "taxAmountCents", "shippingAmountCents",
            "totalCents", "amountCents", "cardLast4", "reference", "createdAt"
          ) VALUES (
            ${paymentAttemptId}, ${orderId}, ${buyerUserId}, ${lockedCard.fixtureId}, 'APPROVED', 'USD',
            ${BigInt(moneyResult.subtotalCents)}, ${currentSettings.tax.enabled}, ${currentSettings.tax.rateBps},
            ${BigInt(moneyResult.taxAmountCents)}, 0, ${totalCentsBigInt}, ${totalCentsBigInt},
            ${validatedIdentity.last4}, ${paymentReference}, clock_timestamp()
          )
        `.affectedCount().build();
        await tx.execute(insertPaymentPlan);

        // H. Build PurchaseReceipt immutable snapshot (#34 minimal base with productId)
        const receiptSnapshot = {
          merchantName: 'REGALÍA',
          buyer: {
            id: buyer.id,
            name: buyer.name,
            email: buyer.email,
          },
          recipient: {
            name: dto.delivery.recipient.name.trim(),
            phone: dto.delivery.recipient.phone.trim(),
          },
          delivery: {
            zoneId: zone.id,
            zoneName: zone.name,
            address: dto.delivery.deliveryAddress.trim(),
            location: {
              lat: dto.delivery.deliveryLocation.lat,
              lng: dto.delivery.deliveryLocation.lng,
            },
            scheduledDeliveryDate: scheduledInstant.toString(),
            notes: dto.delivery.deliveryNotes?.trim() ?? null,
          },
          items: confirmedItems.map((i) => ({
            productId: i.productId,
            sku: i.sku,
            name: i.name,
            quantity: i.quantity,
            unitPriceCents: i.unitPriceCents,
            lineTotalCents: i.lineTotalCents,
          })),
          pricing: {
            currency: 'USD',
            subtotalCents: moneyResult.subtotalCents,
            tax: {
              mode: 'SIMULATED',
              enabled: currentSettings.tax.enabled,
              rateBps: currentSettings.tax.rateBps,
              amountCents: moneyResult.taxAmountCents,
            },
            shipping: {
              status: 'FREE_INCLUDED',
              amountCents: 0,
              includedInPrices: true,
            },
            totalCents: moneyResult.totalCents,
            settingsVersion: currentSettings.version,
          },
          payment: {
            status: 'APPROVED',
            reference: paymentReference,
            cardLast4: validatedIdentity.last4,
          },
          issuedAt: new Date(nowDb.epochMilliseconds).toISOString(),
          disclaimer: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA',
        };

        const insertReceiptPlan = this.prisma.client.raw.sql`
          INSERT INTO public."purchaseReceipt" (
            "id", "orderId", "number", "commercialOrderNumber", "buyerId", "issuedAt",
            "merchantName", "currency", "subtotalCents", "taxMode", "taxEnabled", "taxRateBps",
            "taxAmountCents", "shippingStatus", "shippingAmountCents", "totalCents", "snapshot",
            "disclaimer", "createdAt"
          ) VALUES (
            ${receiptId}, ${orderId}, ${receiptNumber}, ${commercialOrderNumber}, ${buyerUserId}, clock_timestamp(),
            'REGALÍA', 'USD', ${BigInt(moneyResult.subtotalCents)}, 'SIMULATED', ${currentSettings.tax.enabled},
            ${currentSettings.tax.rateBps}, ${BigInt(moneyResult.taxAmountCents)}, 'FREE_INCLUDED', 0,
            ${totalCentsBigInt}, ${JSON.stringify(receiptSnapshot)}::jsonb,
            'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA', clock_timestamp()
          )
        `.affectedCount().build();
        await tx.execute(insertReceiptPlan);

        // I. Build public success response
        const successResponse: CheckoutSuccessDto = {
          checkoutAttemptId,
          status: 'SUCCEEDED',
          order: {
            id: orderId,
            number: commercialOrderNumber,
            status: 'PENDING',
            subtotalCents: moneyResult.subtotalCents,
            taxAmountCents: moneyResult.taxAmountCents,
            taxRateBps: currentSettings.tax.rateBps,
            shippingAmountCents: 0,
            totalCents: moneyResult.totalCents,
            taxEnabled: currentSettings.tax.enabled,
            currency: 'USD',
            scheduledDeliveryDate: new Date(scheduledInstant.epochMilliseconds).toISOString(),
          },
          payment: {
            status: 'APPROVED',
            amountCents: moneyResult.totalCents,
            cardLast4: validatedIdentity.last4,
            reference: paymentReference,
          },
          receipt: {
            id: receiptId,
            number: receiptNumber,
          },
        };

        // J. Persist CheckoutAttempt SUCCEEDED
        const insertAttemptPlan = this.prisma.client.raw.sql`
          INSERT INTO public."checkoutAttempt" (
            "id", "userId", "idempotencyKey", "requestHash", "status",
            "orderId", "receiptId", "paymentAttemptId", "successSnapshot", "createdAt", "updatedAt"
          ) VALUES (
            ${checkoutAttemptId}, ${buyerUserId}, ${idempotencyKey}, ${requestHash}, 'SUCCEEDED',
            ${orderId}, ${receiptId}, ${paymentAttemptId},
            ${JSON.stringify(successResponse)}::jsonb, clock_timestamp(), clock_timestamp()
          )
        `.affectedCount().build();
        await tx.execute(insertAttemptPlan);

        return successResponse;
      });
    } catch (err: any) {
      // If business rejection, serialize and record/resolve terminal attempt
      const errorObj = err?.response?.error;
      if (errorObj && typeof errorObj.code === 'string') {
        const winnerOrResolved = await this.recordTerminalRejection(
          buyerUserId,
          idempotencyKey,
          requestHash,
          errorObj.code,
          errorObj.message ?? err.message,
          (errorObj.details as Record<string, unknown>) ?? {},
        );

        if (winnerOrResolved) {
          if (winnerOrResolved.requestHash !== requestHash) {
            throw shopError(
              HttpStatus.CONFLICT,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key has already been used with a different request payload',
              { idempotencyKey },
            );
          }
          if (winnerOrResolved.status === 'SUCCEEDED' && winnerOrResolved.successSnapshot) {
            return winnerOrResolved.successSnapshot as unknown as CheckoutSuccessDto;
          }
          if (winnerOrResolved.status === 'REJECTED' && winnerOrResolved.errorCode) {
            throw shopError(
              this.statusForCode(winnerOrResolved.errorCode),
              winnerOrResolved.errorCode,
              winnerOrResolved.errorMessage ?? 'Solicitud rechazada previamente',
              winnerOrResolved.errorDetails ?? {},
            );
          }
        }
      }

      throw err;
    }
  }
}
