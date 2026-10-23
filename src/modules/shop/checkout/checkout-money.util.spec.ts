import {
  calculateMoneyAmounts,
  calculateTaxAmountCents,
  MAX_SAFE_MONEY_CENTS,
} from './checkout-money.util.js';

describe('checkout-money.util', () => {
  describe('calculateTaxAmountCents', () => {
    it('calculates 15% IVA on $73.00 exactly as $10.95', () => {
      // 7300 cents * 1500 bps = 1095 cents ($10.95)
      const tax = calculateTaxAmountCents(7300n, 1500, true);
      expect(tax).toBe(1095n);
    });

    it('returns 0 when tax is disabled', () => {
      const tax = calculateTaxAmountCents(7300n, 1500, false);
      expect(tax).toBe(0n);
    });

    it('returns 0 when tax rate is 0 bps even if enabled', () => {
      const tax = calculateTaxAmountCents(7300n, 0, true);
      expect(tax).toBe(0n);
    });

    it('handles exact half-cent boundary conditions using HALF_UP rounding', () => {
      // 10 cents * 15% = 1.5 cents -> rounds to 2 cents
      expect(calculateTaxAmountCents(10n, 1500, true)).toBe(2n);
      // 30 cents * 15% = 4.5 cents -> rounds to 5 cents
      expect(calculateTaxAmountCents(30n, 1500, true)).toBe(5n);
      // 70 cents * 15% = 10.5 cents -> rounds to 11 cents
      expect(calculateTaxAmountCents(70n, 1500, true)).toBe(11n);

      // Just below half-cent:
      // 3 cents * 15% = 0.45 cents -> rounds down to 0 cents
      expect(calculateTaxAmountCents(3n, 1500, true)).toBe(0n);
      // Just above half-cent:
      // 4 cents * 15% = 0.60 cents -> rounds up to 1 cent
      expect(calculateTaxAmountCents(4n, 1500, true)).toBe(1n);
    });

    it('handles 100% tax rate (10000 bps)', () => {
      expect(calculateTaxAmountCents(5000n, 10000, true)).toBe(5000n);
    });

    it('REPRODUCTION RED: validates non-negative subtotal even if tax is disabled', () => {
      expect(() => calculateTaxAmountCents(-100n, 1500, false)).toThrow();
    });

    it('REPRODUCTION RED: validates non-negative subtotal even if rate is 0', () => {
      expect(() => calculateTaxAmountCents(-100n, 0, true)).toThrow();
    });

    it('REPRODUCTION RED: validates integer bps in [0, 10000] even if tax is disabled', () => {
      expect(() => calculateTaxAmountCents(7300n, -1, false)).toThrow();
      expect(() => calculateTaxAmountCents(7300n, 15000, false)).toThrow();
      expect(() => calculateTaxAmountCents(7300n, 15.5, false)).toThrow();
    });
  });

  describe('calculateMoneyAmounts', () => {
    it('covers the exact mandatory authority example: $73.00 + 15% ($10.95) + free $0 = $83.95', () => {
      const result = calculateMoneyAmounts(
        [{ unitPriceCents: 3650, quantity: 2 }],
        { enabled: true, rateBps: 1500 },
      );

      expect(result).toEqual({
        subtotalCents: 7300,
        taxAmountCents: 1095,
        shippingAmountCents: 0,
        totalCents: 8395,
        lines: [
          {
            unitPriceCents: 3650,
            quantity: 2,
            lineTotalCents: 7300,
          },
        ],
      });
    });

    it('covers tax disabled with $73.00 subtotal yielding $73.00 total', () => {
      const result = calculateMoneyAmounts(
        [{ unitPriceCents: 7300, quantity: 1 }],
        { enabled: false, rateBps: 1500 },
      );

      expect(result).toEqual({
        subtotalCents: 7300,
        taxAmountCents: 0,
        shippingAmountCents: 0,
        totalCents: 7300,
        lines: [
          {
            unitPriceCents: 7300,
            quantity: 1,
            lineTotalCents: 7300,
          },
        ],
      });
    });

    it('handles multiple lines and calculates tax once on the aggregated subtotal', () => {
      const result = calculateMoneyAmounts(
        [
          { unitPriceCents: 10, quantity: 1 },
          { unitPriceCents: 10, quantity: 1 },
        ],
        { enabled: true, rateBps: 1500 },
      );

      expect(result.subtotalCents).toBe(20);
      expect(result.taxAmountCents).toBe(3);
      expect(result.totalCents).toBe(23);
    });

    it('throws on negative or non-integer unitPriceCents or quantity', () => {
      expect(() =>
        calculateMoneyAmounts(
          [{ unitPriceCents: -100, quantity: 1 }],
          { enabled: true, rateBps: 1500 },
        ),
      ).toThrow();

      expect(() =>
        calculateMoneyAmounts(
          [{ unitPriceCents: 100, quantity: -1 }],
          { enabled: true, rateBps: 1500 },
        ),
      ).toThrow();

      expect(() =>
        calculateMoneyAmounts(
          [{ unitPriceCents: 100.5, quantity: 1 }],
          { enabled: true, rateBps: 1500 },
        ),
      ).toThrow();
    });

    it('throws when calculation exceeds MAX_SAFE_MONEY_CENTS', () => {
      expect(() =>
        calculateMoneyAmounts(
          [{ unitPriceCents: MAX_SAFE_MONEY_CENTS, quantity: 2 }],
          { enabled: true, rateBps: 1500 },
        ),
      ).toThrow();
    });
  });
});
