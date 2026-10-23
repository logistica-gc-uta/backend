import { HttpStatus } from '@nestjs/common';
import { shopError } from '../shop-http.filter.js';

export const MAX_SAFE_MONEY_CENTS = Number.MAX_SAFE_INTEGER; // 9007199254740991

export interface MoneyLineInput {
  unitPriceCents: number;
  quantity: number;
}

export interface MoneyLineResult {
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface MoneyCalculationResult {
  subtotalCents: number;
  taxAmountCents: number;
  shippingAmountCents: number;
  totalCents: number;
  lines: MoneyLineResult[];
}

export interface TaxCalculationConfig {
  enabled: boolean;
  rateBps: number;
}

/**
 * Calculates simulated IVA tax amount in cents from non-negative subtotal BigInt.
 * Exact formula: floor((subtotalCents * rateBps + 5000) / 10000)
 * Rounds HALF_UP once on the entire subtotal, never per line.
 * Validates non-negative subtotal and integer basis points (0..10000) BEFORE checking disabled/zero rate.
 */
export function calculateTaxAmountCents(
  subtotalCents: bigint,
  rateBps: number,
  enabled: boolean,
): bigint {
  if (subtotalCents < 0n) {
    throw shopError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Subtotal cannot be negative',
    );
  }
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw shopError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Tax rate in basis points must be an integer between 0 and 10000',
    );
  }

  if (!enabled || rateBps === 0) {
    return 0n;
  }

  // Integer arithmetic: adding 5000 before dividing by 10000 performs exact HALF_UP rounding
  const tax = (subtotalCents * BigInt(rateBps) + 5000n) / 10000n;
  return tax;
}

/**
 * Calculates line totals, subtotal, simulated tax and total cents.
 * Ensures all intermediate and final figures are safe integers.
 */
export function calculateMoneyAmounts(
  lines: MoneyLineInput[],
  taxConfig: TaxCalculationConfig,
): MoneyCalculationResult {
  let subtotalBigInt = 0n;
  const processedLines: MoneyLineResult[] = [];

  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents <= 0) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Unit price in cents must be a positive safe integer',
      );
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Quantity must be a positive safe integer',
      );
    }

    const unitPriceBig = BigInt(line.unitPriceCents);
    const quantityBig = BigInt(line.quantity);
    const lineTotalBig = unitPriceBig * quantityBig;

    if (lineTotalBig > BigInt(MAX_SAFE_MONEY_CENTS)) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Line total exceeds maximum safe integer',
      );
    }

    subtotalBigInt += lineTotalBig;
    if (subtotalBigInt > BigInt(MAX_SAFE_MONEY_CENTS)) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Subtotal exceeds maximum safe integer',
      );
    }

    processedLines.push({
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
      lineTotalCents: Number(lineTotalBig),
    });
  }

  const taxBigInt = calculateTaxAmountCents(
    subtotalBigInt,
    taxConfig.rateBps,
    taxConfig.enabled,
  );

  const totalBigInt = subtotalBigInt + taxBigInt;
  if (totalBigInt > BigInt(MAX_SAFE_MONEY_CENTS)) {
    throw shopError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Total cents exceeds maximum safe integer',
    );
  }

  return {
    subtotalCents: Number(subtotalBigInt),
    taxAmountCents: Number(taxBigInt),
    shippingAmountCents: 0,
    totalCents: Number(totalBigInt),
    lines: processedLines,
  };
}
