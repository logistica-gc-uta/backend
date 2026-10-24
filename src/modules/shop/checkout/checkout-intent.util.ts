import { createHash } from 'node:crypto';
import { toInstant } from '../../../common/temporal.util.js';
import { consolidateOrderItems } from '../../orders/order-inventory.util.js';
import { SIMULATED_CARD_FIXTURES } from './simulated-card.js';

export interface CanonicalItem {
  productId: string;
  quantity: number;
}

export interface CanonicalRecipient {
  name: string;
  phone: string;
}

export interface CanonicalLocation {
  lat: number;
  lng: number;
}

export interface CanonicalDelivery {
  recipient: CanonicalRecipient;
  zoneId: string;
  deliveryAddress: string;
  deliveryLocation: CanonicalLocation;
  scheduledDeliveryDate: string;
  deliveryNotes?: string;
}

export interface CanonicalIntent {
  items: CanonicalItem[];
  delivery: CanonicalDelivery;
  quoteToken: string;
  cardFixtureId: string;
}

export interface RawIntentInput {
  items: { productId: string; quantity: number }[];
  delivery: {
    recipient: { name: string; phone: string };
    zoneId: string;
    deliveryAddress: string;
    deliveryLocation: { lat: number; lng: number };
    scheduledDeliveryDate: string;
    deliveryNotes?: string | null;
  };
  quoteToken: string;
  cardFixtureId?: string | null;
}

/**
 * Safely looks up the synthetic in-memory fixtureId from card number without persisting or leaking PAN.
 * Returns null if the number does not correspond to any known test fixture.
 */
export function lookupFixtureIdFromNumber(cardNumber: string): string | null {
  if (typeof cardNumber !== 'string') {
    return null;
  }
  const normalizedNumber = cardNumber.replace(/\s+/g, '');
  const fixture = SIMULATED_CARD_FIXTURES.find(
    (f) => f.normalizedNumber === normalizedNumber,
  );
  return fixture ? fixture.fixtureId : null;
}

/**
 * Builds a normalized canonical intent representation for idempotency tracking.
 * - Enforces codepoint order consolidation for items.
 * - Trims recipient name, phone, zoneId, address, and delivery notes.
 * - Normalizes delivery instant to canonical UTC ISO string representation.
 * - Retains full finite coordinate precision without lossy rounding.
 * - Retains ONLY cardFixtureId for card identification; NEVER includes PAN, CVV, holderName, or expiry.
 */
export function buildCanonicalIntent(input: RawIntentInput): CanonicalIntent {
  const consolidated = consolidateOrderItems(input.items);
  const deliveryInstant = toInstant(input.delivery.scheduledDeliveryDate);
  const normalizedDate = deliveryInstant.toString();

  const trimmedNotes = input.delivery.deliveryNotes?.trim();

  return {
    items: consolidated.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    })),
    delivery: {
      recipient: {
        name: input.delivery.recipient.name.trim(),
        phone: input.delivery.recipient.phone.trim(),
      },
      zoneId: input.delivery.zoneId.trim(),
      deliveryAddress: input.delivery.deliveryAddress.trim(),
      deliveryLocation: {
        lat: Number(input.delivery.deliveryLocation.lat),
        lng: Number(input.delivery.deliveryLocation.lng),
      },
      scheduledDeliveryDate: normalizedDate,
      ...(trimmedNotes ? { deliveryNotes: trimmedNotes } : {}),
    },
    quoteToken: input.quoteToken.trim(),
    cardFixtureId: input.cardFixtureId && input.cardFixtureId.trim()
      ? input.cardFixtureId.trim()
      : 'UNKNOWN_FIXTURE',
  };
}

function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalJsonStringify).join(',')}]`;
  }
  const keys = Object.keys(obj).sort();
  const entries = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalJsonStringify((obj as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(',')}}`;
}

/**
 * Computes a deterministic SHA-256 hash of the canonical purchase intent.
 */
export function hashCanonicalIntent(intent: CanonicalIntent): string {
  const serialized = canonicalJsonStringify(intent);
  return createHash('sha256').update(serialized).digest('hex');
}
