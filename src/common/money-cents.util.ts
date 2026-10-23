import { BadRequestException } from '@nestjs/common';

export const MAX_JSON_CENTS = Number.MAX_SAFE_INTEGER;

/** Interpret the shortest decimal representation of an existing IEEE-754 value; never round to cents. */
export function exactLegacyCents(value: number): bigint | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) return null;
  const digits = `${match[1]}${match[2] ?? ''}`;
  const shift = Number(match[3] ?? 0) - (match[2]?.length ?? 0) + 2;
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 400) return null;
  const scaled = shift >= 0 ? BigInt(digits) * 10n ** BigInt(shift) :
    BigInt(digits) / 10n ** BigInt(-shift);
  if (shift < 0 && BigInt(digits) % (10n ** BigInt(-shift)) !== 0n) return null;
  return scaled <= BigInt(MAX_JSON_CENTS) ? scaled : null;
}

/** Shop JSON inputs are safe integers; persistence is int8, narrowed to JSON-safe range. */
export function centsToLegacyPrice(priceCents: number): number {
  if (!Number.isSafeInteger(priceCents) || priceCents < 1) {
    throw new BadRequestException('Price must be a positive JSON-safe integer in cents');
  }
  const price = priceCents / 100;
  if (exactLegacyCents(price) !== BigInt(priceCents)) {
    throw new BadRequestException('Price cannot be dual-written to legacy Float exactly');
  }
  return price;
}

export function legacyPriceCents(price: number): bigint {
  const cents = exactLegacyCents(price);
  if (cents === null || cents < 1n) {
    throw new BadRequestException('Legacy price must be positive and exactly representable in cents');
  }
  return cents;
}
