import * as crypto from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { shopError } from '../shop-http.filter.js';

export interface QuotedTokenItem {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface QuotedTokenDelivery {
  recipient: {
    name: string;
    phone: string;
  };
  zoneId: string;
  deliveryAddress: string;
  deliveryLocation: {
    lat: number;
    lng: number;
  };
  scheduledDeliveryDate: string; // ISO 8601 UTC instant
  deliveryNotes?: string;
}

export interface QuoteTokenPayload {
  buyerUserId: string;
  issuedAt: string;
  validUntil: string;
  settingsVersion: number;
  currency: 'USD';
  tax: {
    mode: 'SIMULATED';
    enabled: boolean;
    rateBps: number;
    amountCents: number;
  };
  subtotalCents: number;
  shippingAmountCents: 0;
  totalCents: number;
  items: QuotedTokenItem[];
  delivery: QuotedTokenDelivery;
}

const TOKEN_PREFIX = 'qtk_v1';
const DOMAIN_CONTEXT = 'regalia:shop:quote-token:v1.2';

/**
 * Derives a distinct 32-byte domain-separated HMAC key from configured JWT_SECRET.
 * Refuses missing or empty secret with an explicit error; never falls back to hardcoded defaults.
 */
export function deriveQuoteSigningKey(): Buffer {
  const rawSecret = process.env.JWT_SECRET;
  if (!rawSecret || !rawSecret.trim()) {
    throw shopError(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'INTERNAL_ERROR',
      'Quote signing secret is not configured in the server environment',
    );
  }
  return crypto.createHmac('sha256', rawSecret.trim()).update(DOMAIN_CONTEXT).digest();
}

/**
 * Signs a canonical quote payload into an opaque token with domain-separated HMAC.
 */
export function signQuoteToken(payload: QuoteTokenPayload): string {
  const signingKey = deriveQuoteSigningKey();
  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadJson, 'utf-8').toString('base64url');

  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(payloadBase64)
    .digest('base64url');

  return `${TOKEN_PREFIX}.${payloadBase64}.${signature}`;
}

/**
 * Verifies the quote token syntax, cryptographic signature, buyer ownership, and DB-clock expiration.
 * Expiry boundary: nowDb >= validUntil strictly rejects with 409 QUOTE_EXPIRED.
 */
export function verifyQuoteToken(
  token: string,
  buyerUserId: string,
  nowDb: Temporal.Instant,
): QuoteTokenPayload {
  if (typeof token !== 'string') {
    throw shopError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Quote token must be a string',
      { reason: 'INVALID_TOKEN_TYPE' },
    );
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw shopError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Malformed quote token format',
      { reason: 'INVALID_TOKEN_FORMAT' },
    );
  }

  const [, payloadBase64, providedSig] = parts;
  const signingKey = deriveQuoteSigningKey();

  const expectedSig = crypto
    .createHmac('sha256', signingKey)
    .update(payloadBase64)
    .digest('base64url');

  const providedBuffer = Buffer.from(providedSig, 'utf-8');
  const expectedBuffer = Buffer.from(expectedSig, 'utf-8');

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw shopError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Quote token signature is invalid or has been tampered with',
      { reason: 'TAMPERED_TOKEN' },
    );
  }

  let payload: QuoteTokenPayload;
  try {
    const jsonStr = Buffer.from(payloadBase64, 'base64url').toString('utf-8');
    payload = JSON.parse(jsonStr) as QuoteTokenPayload;
  } catch {
    throw shopError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Quote token payload cannot be decoded',
      { reason: 'DECODE_ERROR' },
    );
  }

  if (payload.buyerUserId !== buyerUserId) {
    throw shopError(
      HttpStatus.FORBIDDEN,
      'FORBIDDEN',
      'Quote token does not belong to the current authenticated buyer',
      { reason: 'BUYER_MISMATCH' },
    );
  }

  const validUntilInstant = Temporal.Instant.from(payload.validUntil);
  // Boundary rule: nowDb >= validUntil rejects with QUOTE_EXPIRED
  if (Temporal.Instant.compare(nowDb, validUntilInstant) >= 0) {
    throw shopError(
      HttpStatus.CONFLICT,
      'QUOTE_EXPIRED',
      'The quotation has expired; please request a new quotation',
      {
        validUntil: payload.validUntil,
        expiredAt: nowDb.toString(),
      },
    );
  }

  return payload;
}

/**
 * Revalidates quote token snapshot against current live settings version and product prices.
 * Used prior to transactional execution in Checkout (#33-C).
 */
export function revalidateQuote(
  payload: QuoteTokenPayload,
  currentSettings: { version: number },
  currentProducts: Array<{ id: string; priceCents?: bigint | number | null }>,
): void {
  if (currentSettings.version !== payload.settingsVersion) {
    throw shopError(
      HttpStatus.CONFLICT,
      'SHOP_SETTINGS_CHANGED',
      'Commercial shop settings have changed since quotation; please review updated quote',
      {
        expectedVersion: payload.settingsVersion,
        currentVersion: currentSettings.version,
      },
    );
  }

  const productMap = new Map<string, number | null>();
  for (const prod of currentProducts) {
    const price =
      prod.priceCents !== null && prod.priceCents !== undefined
        ? Number(prod.priceCents)
        : null;
    productMap.set(prod.id, price);
  }

  for (const item of payload.items) {
    const currentPrice = productMap.get(item.productId);
    if (currentPrice === null || currentPrice === undefined || currentPrice !== item.unitPriceCents) {
      throw shopError(
        HttpStatus.CONFLICT,
        'PRICE_CHANGED',
        'One or more product prices have changed since quotation; please review updated quote',
        {
          productId: item.productId,
          quotedPriceCents: item.unitPriceCents,
          currentPriceCents: currentPrice ?? null,
        },
      );
    }
  }
}
