import { BadRequestException } from '@nestjs/common';
import { centsToLegacyPrice, exactLegacyCents, legacyPriceCents } from './money-cents.util.js';

describe('exact money seam', () => {
  it.each([[0.1, 10n], [0.2, 20n], [36.5, 3650n], [1e5, 10000000n]])('converts decimal spelling %s to %s', (value, cents) => {
    expect(exactLegacyCents(value)).toBe(cents);
  });
  it.each([0.1 + 0.2, 1.001, -1, Infinity, NaN, 90071992547410])('refuses lossy or invalid historical value %s', value => {
    expect(exactLegacyCents(value)).toBeNull();
  });
  it('rejects unrepresentable legacy writes and roundtrips safe Shop writes', () => {
    expect(legacyPriceCents(0.01)).toBe(1n);
    expect(exactLegacyCents(centsToLegacyPrice(3650))).toBe(3650n);
    expect(() => legacyPriceCents(1.001)).toThrow(BadRequestException);
    expect(() => centsToLegacyPrice(Number.MAX_SAFE_INTEGER + 1)).toThrow(BadRequestException);
  });
});
