import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  deriveQuoteSigningKey,
  QuoteTokenPayload,
  revalidateQuote,
  signQuoteToken,
  verifyQuoteToken,
} from './quote-token.util.js';

describe('quote-token.util', () => {
  const originalSecret = process.env.JWT_SECRET;
  const testSecret = 'test-secret-key-for-checkout-v12-tests-2026';

  beforeEach(() => {
    process.env.JWT_SECRET = testSecret;
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  const validPayload: QuoteTokenPayload = {
    buyerUserId: '99999999-9999-4999-8999-999999999999',
    issuedAt: '2026-10-23T12:00:00.000Z',
    validUntil: '2026-10-23T12:15:00.000Z',
    settingsVersion: 1,
    currency: 'USD',
    tax: {
      mode: 'SIMULATED',
      enabled: true,
      rateBps: 1500,
      amountCents: 1095,
    },
    subtotalCents: 7300,
    shippingAmountCents: 0,
    totalCents: 8395,
    items: [
      {
        productId: '11111111-1111-4111-8111-111111111111',
        quantity: 2,
        unitPriceCents: 3650,
        lineTotalCents: 7300,
      },
    ],
    delivery: {
      recipient: {
        name: 'Ana Regalo',
        phone: '0991234567',
      },
      zoneId: '55555555-5555-4555-8555-555555555555',
      deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
      deliveryLocation: {
        lat: -1.2425,
        lng: -78.6188,
      },
      scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
    },
  };

  describe('deriveQuoteSigningKey', () => {
    it('refuses missing or empty secret and never falls back to a hardcoded secret', () => {
      delete process.env.JWT_SECRET;
      expect(() => deriveQuoteSigningKey()).toThrow(HttpException);

      process.env.JWT_SECRET = '   ';
      expect(() => deriveQuoteSigningKey()).toThrow(HttpException);
    });

    it('derives a deterministic 32-byte domain-separated HMAC key from configured secret', () => {
      const key1 = deriveQuoteSigningKey();
      const key2 = deriveQuoteSigningKey();
      expect(key1).toEqual(key2);
      expect(key1.length).toBe(32);
    });
  });

  describe('signQuoteToken & verifyQuoteToken', () => {
    it('generates an opaque token with qtk_v1. prefix and verifies successfully', () => {
      const token = signQuoteToken(validPayload);
      expect(token.startsWith('qtk_v1.')).toBe(true);

      const nowDb = Temporal.Instant.from('2026-10-23T12:05:00.000Z');
      const verified = verifyQuoteToken(token, validPayload.buyerUserId, nowDb);
      expect(verified).toEqual(validPayload);
    });

    it('rejects tampered payload', () => {
      const token = signQuoteToken(validPayload);
      const parts = token.split('.');
      // Alter the payload base64url
      const tamperedToken = `${parts[0]}.${parts[1]}A.${parts[2]}`;

      const nowDb = Temporal.Instant.from('2026-10-23T12:05:00.000Z');
      expect(() =>
        verifyQuoteToken(tamperedToken, validPayload.buyerUserId, nowDb),
      ).toThrow(HttpException);
    });

    it('rejects tampered signature', () => {
      const token = signQuoteToken(validPayload);
      const parts = token.split('.');
      const tamperedToken = `${parts[0]}.${parts[1]}.badSig123`;

      const nowDb = Temporal.Instant.from('2026-10-23T12:05:00.000Z');
      expect(() =>
        verifyQuoteToken(tamperedToken, validPayload.buyerUserId, nowDb),
      ).toThrow(HttpException);
    });

    it('rejects buyer mismatch with FORBIDDEN (403)', () => {
      const token = signQuoteToken(validPayload);
      const otherUser = randomUUID();
      const nowDb = Temporal.Instant.from('2026-10-23T12:05:00.000Z');

      try {
        verifyQuoteToken(token, otherUser, nowDb);
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect(err.getResponse().error.code).toBe('FORBIDDEN');
      }
    });

    it('rejects expired token with QUOTE_EXPIRED (409) based on DB clock', () => {
      const token = signQuoteToken(validPayload);
      // Valid until 12:15, current DB clock is 12:16
      const expiredDb = Temporal.Instant.from('2026-10-23T12:16:00.000Z');

      try {
        verifyQuoteToken(token, validPayload.buyerUserId, expiredDb);
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(err.getResponse().error.code).toBe('QUOTE_EXPIRED');
      }
    });

    it('pins exact 15-minute expiry bound (nowDb >= validUntil rejects with 409 QUOTE_EXPIRED)', () => {
      const token = signQuoteToken(validPayload);
      // Valid until exactly 12:15:00.000Z. At nowDb == 12:15:00.000Z, must reject.
      const exactExpiryDb = Temporal.Instant.from('2026-10-23T12:15:00.000Z');

      try {
        verifyQuoteToken(token, validPayload.buyerUserId, exactExpiryDb);
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(err.getResponse().error.code).toBe('QUOTE_EXPIRED');
      }
    });

    it('accepts token just before 15-minute expiry bound (nowDb < validUntil)', () => {
      const token = signQuoteToken(validPayload);
      // Valid until 12:15:00.000Z. At nowDb == 12:14:59.999Z (1ms before), must succeed.
      const justBeforeDb = Temporal.Instant.from('2026-10-23T12:14:59.999Z');

      const verified = verifyQuoteToken(token, validPayload.buyerUserId, justBeforeDb);
      expect(verified.buyerUserId).toBe(validPayload.buyerUserId);
      expect(verified.totalCents).toBe(validPayload.totalCents);
    });

    it('cannot be used as an authentication bearer JWT', () => {
      const token = signQuoteToken(validPayload);
      // Ensure the token has the qtk_v1 prefix, preventing JWT libraries from parsing as standard 3-part header.payload.signature
      expect(token.split('.').length).toBe(3);
      expect(token.startsWith('qtk_v1.')).toBe(true);
      // It has qtk_v1, payload, and sig -> but header is not a JSON with alg
      const firstSegment = token.split('.')[0];
      expect(firstSegment).toBe('qtk_v1');
    });
  });

  describe('revalidateQuote', () => {
    it('succeeds when settings version and prices match', () => {
      expect(() =>
        revalidateQuote(
          validPayload,
          { version: 1 },
          [
            {
              id: '11111111-1111-4111-8111-111111111111',
              priceCents: 3650n,
            },
          ],
        ),
      ).not.toThrow();
    });

    it('throws 409 SHOP_SETTINGS_CHANGED when settings version has changed', () => {
      try {
        revalidateQuote(
          validPayload,
          { version: 2 },
          [
            {
              id: '11111111-1111-4111-8111-111111111111',
              priceCents: 3650n,
            },
          ],
        );
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(err.getResponse().error.code).toBe('SHOP_SETTINGS_CHANGED');
        expect(err.getResponse().error.details).toEqual({
          expectedVersion: 1,
          currentVersion: 2,
        });
      }
    });

    it('throws 409 PRICE_CHANGED when any product unit price has changed', () => {
      try {
        revalidateQuote(
          validPayload,
          { version: 1 },
          [
            {
              id: '11111111-1111-4111-8111-111111111111',
              priceCents: 4000n, // Price changed from 3650 to 4000
            },
          ],
        );
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(err.getResponse().error.code).toBe('PRICE_CHANGED');
        expect(err.getResponse().error.details).toEqual({
          productId: '11111111-1111-4111-8111-111111111111',
          quotedPriceCents: 3650,
          currentPriceCents: 4000,
        });
      }
    });
  });
});
