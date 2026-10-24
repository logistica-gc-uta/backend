import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { deliveryClock, parseDeliveryTiming } from '../../orders/order-delivery.util.js';
import { evaluatePlanningEligibility, validateCoordinatePair } from '../../orders/order-geography.util.js';
import { consolidateOrderItems } from '../../orders/order-inventory.util.js';
import { ShopSettingsPublicDto } from '../settings/dto/shop-settings.dto.js';
import { ShopSettingsService } from '../settings/shop-settings.service.js';
import { shopError } from '../shop-http.filter.js';
import { calculateMoneyAmounts, MoneyLineInput } from './checkout-money.util.js';
import { QuoteRequestDto } from './dto/quote-request.dto.js';
import { QuoteResponseDto, QuotedLineDto } from './dto/quote-response.dto.js';
import { QuoteTokenPayload, signQuoteToken } from './quote-token.util.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];

interface ProductWithCategory {
  id: string;
  name: string;
  sku: string | null;
  stock: number;
  priceCents: bigint | null;
  isPublished: boolean;
  categoryId: string | null;
  category: {
    id: string;
    isActive: boolean;
  } | null;
}

interface ZoneWithDepot {
  id: string;
  name: string;
  code: string;
  depotLat: number | null;
  depotLng: number | null;
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: ShopSettingsService,
  ) {}

  /**
   * Generates a signed, short-lived quotation for the client basket and delivery input.
   * Validates product publication, active category, stock availability, server priceCents,
   * delivery zone with configured depot, operating hours in America/Guayaquil, and dynamic SKU limits.
   * Never reserves stock, mutates settings or creates orders.
   */
  async quoteCheckout(
    buyerUserId: string,
    dto: QuoteRequestDto,
  ): Promise<QuoteResponseDto> {
    // 1. Consolidate lines and enforce codepoint ordering
    const consolidated = consolidateOrderItems(dto.items);

    // 2. Fetch active settings for limits and delivery operating hours
    const settings: ShopSettingsPublicDto = await this.settingsService.getPublicSettings();

    // 3. Enforce dynamic per-SKU limits against consolidated quantities
    for (const item of consolidated) {
      if (item.quantity > settings.limits.maxUnitsPerSkuPerOrder) {
        throw shopError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'QUANTITY_LIMIT_EXCEEDED',
          'Requested quantity exceeds the maximum allowed units per SKU',
          {
            productId: item.productId,
            requestedQuantity: item.quantity,
            maximumAllowed: settings.limits.maxUnitsPerSkuPerOrder,
          },
        );
      }
    }

    // 4. Validate coordinate pair syntax and bounds
    validateCoordinatePair(
      dto.delivery.deliveryLocation.lat,
      dto.delivery.deliveryLocation.lng,
      'delivery',
    );

    // 5. Parse delivery timing instant with explicit offset
    const timing = parseDeliveryTiming(
      { scheduledDeliveryDate: dto.delivery.scheduledDeliveryDate },
      true,
    );
    const scheduledInstant = timing.scheduledDeliveryDate!;

    // 6. Read clock, zone, and products in default read committed transaction on pinned connection
    const productIds = consolidated.map(item => item.productId);
    const { nowDb, zone, productMap } = await this.prisma.client.transaction(
      async (tx: Transaction) => {
        const nowDb = await deliveryClock(tx, this.prisma.client.raw);
        const zone = (await tx.orm.public.Zone.where({
          id: dto.delivery.zoneId,
        }).first()) as ZoneWithDepot | undefined;

        const rawProducts = (await tx.orm.public.Product.where(p =>
          p.id.in(productIds),
        )
          .include('category')
          .all()) as unknown as ProductWithCategory[];

        const productMap = new Map<string, ProductWithCategory>();
        for (const p of rawProducts) {
          productMap.set(p.id, p);
        }

        return { nowDb, zone, productMap };
      },
    );

    // 7. Validate zone existence and depot eligibility
    if (!zone) {
      throw shopError(
        HttpStatus.NOT_FOUND,
        'ZONE_NOT_FOUND',
        `Zone with ID '${dto.delivery.zoneId}' not found`,
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
        'Zone or delivery coordinates are not eligible for delivery planning',
        {
          reasons: planningEligibility.reasons,
          zoneId: dto.delivery.zoneId,
        },
      );
    }

    // 8. Assert strictly future delivery date against PostgreSQL DB clock
    if (Temporal.Instant.compare(scheduledInstant, nowDb) <= 0) {
      throw shopError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'DELIVERY_INVALID',
        'Scheduled delivery date must be strictly in the future relative to server time',
        {
          scheduledDeliveryDate: dto.delivery.scheduledDeliveryDate,
          dbTime: nowDb.toString(),
        },
      );
    }

    // 9. Validate local America/Guayaquil operating hours (inclusive bounds)
    const localZonedDateTime = scheduledInstant.toZonedDateTimeISO('America/Guayaquil');
    const localTime = localZonedDateTime.toPlainTime();
    const startTime = Temporal.PlainTime.from(settings.deliverySchedule.startTime);
    const endTime = Temporal.PlainTime.from(settings.deliverySchedule.endTime);

    if (
      Temporal.PlainTime.compare(localTime, startTime) < 0 ||
      Temporal.PlainTime.compare(localTime, endTime) > 0
    ) {
      const requestedTimeStr = `${String(localTime.hour).padStart(2, '0')}:${String(localTime.minute).padStart(2, '0')}`;
      throw shopError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'DELIVERY_OUTSIDE_HOURS',
        `Scheduled delivery time ${requestedTimeStr} is outside commercial delivery hours (${settings.deliverySchedule.startTime} - ${settings.deliverySchedule.endTime})`,
        {
          startTime: settings.deliverySchedule.startTime,
          endTime: settings.deliverySchedule.endTime,
          timeZone: 'America/Guayaquil',
          requestedTime: requestedTimeStr,
        },
      );
    }

    // 10. Validate catalog products, active categories and authoritative prices
    const moneyLines: MoneyLineInput[] = [];
    const orderedProducts: ProductWithCategory[] = [];

    for (let i = 0; i < consolidated.length; i++) {
      const requested = consolidated[i]!;
      const prod = productMap.get(requested.productId);

      if (!prod) {
        throw shopError(
          HttpStatus.NOT_FOUND,
          'PRODUCT_NOT_FOUND',
          `Product with ID '${requested.productId}' not found in catalog`,
          { productId: requested.productId },
        );
      }

      if (!prod.isPublished) {
        throw shopError(
          HttpStatus.CONFLICT,
          'PRODUCT_UNPUBLISHED',
          `Product '${prod.name}' is not published for sale`,
          { productId: prod.id },
        );
      }

      if (!prod.category || !prod.category.isActive) {
        throw shopError(
          HttpStatus.CONFLICT,
          'PRODUCT_UNPUBLISHED',
          `Product '${prod.name}' belongs to an inactive or missing category`,
          { productId: prod.id },
        );
      }

      if (prod.priceCents === null || prod.priceCents === undefined || prod.priceCents <= 0n) {
        throw shopError(
          HttpStatus.CONFLICT,
          'PRODUCT_UNPUBLISHED',
          `Product '${prod.name}' has no valid price in cents configured`,
          { productId: prod.id },
        );
      }

      orderedProducts.push(prod);
      moneyLines.push({
        unitPriceCents: Number(prod.priceCents),
        quantity: requested.quantity,
      });
    }

    // 11. Calculate exact BigInt money figures and simulated IVA
    const moneyResult = calculateMoneyAmounts(moneyLines, {
      enabled: settings.tax.enabled,
      rateBps: settings.tax.rateBps,
    });

    // 12. Build quoted line items with live stock availability
    const quotedItems: QuotedLineDto[] = consolidated.map((item, i) => {
      const prod = orderedProducts[i]!;
      const line = moneyResult.lines[i]!;
      const availableStock = prod.stock;
      const available = availableStock >= item.quantity;

      return {
        productId: prod.id,
        name: prod.name,
        quantity: item.quantity,
        unitPriceCents: line.unitPriceCents,
        lineTotalCents: line.lineTotalCents,
        availableStock,
        available,
      };
    });

    // 13. Build and sign 15-minute opaque quote token bound to buyer and snapshot
    const validUntilInstant = nowDb.add({ minutes: 15 });
    const validUntil = validUntilInstant.toString();

    const tokenPayload: QuoteTokenPayload = {
      buyerUserId,
      issuedAt: nowDb.toString(),
      validUntil,
      settingsVersion: settings.version,
      currency: 'USD',
      tax: {
        mode: 'SIMULATED',
        enabled: settings.tax.enabled,
        rateBps: settings.tax.rateBps,
        amountCents: moneyResult.taxAmountCents,
      },
      subtotalCents: moneyResult.subtotalCents,
      shippingAmountCents: 0,
      totalCents: moneyResult.totalCents,
      items: quotedItems.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        lineTotalCents: item.lineTotalCents,
      })),
      delivery: {
        recipient: {
          name: dto.delivery.recipient.name.trim(),
          phone: dto.delivery.recipient.phone.trim(),
        },
        zoneId: dto.delivery.zoneId.trim(),
        deliveryAddress: dto.delivery.deliveryAddress.trim(),
        deliveryLocation: {
          lat: Number(dto.delivery.deliveryLocation.lat),
          lng: Number(dto.delivery.deliveryLocation.lng),
        },
        scheduledDeliveryDate: scheduledInstant.toString(),
        ...(dto.delivery.deliveryNotes?.trim() ? { deliveryNotes: dto.delivery.deliveryNotes.trim() } : {}),
      },
    };

    const quoteToken = signQuoteToken(tokenPayload);

    return {
      currency: 'USD',
      items: quotedItems,
      subtotalCents: moneyResult.subtotalCents,
      shipping: {
        status: 'FREE_INCLUDED',
        amountCents: 0,
        includedInPrices: true,
      },
      tax: {
        mode: 'SIMULATED',
        enabled: settings.tax.enabled,
        rateBps: settings.tax.rateBps,
        ratePercent: settings.tax.ratePercent,
        amountCents: moneyResult.taxAmountCents,
      },
      totalCents: moneyResult.totalCents,
      settingsVersion: settings.version,
      validUntil,
      quoteToken,
    };
  }
}
