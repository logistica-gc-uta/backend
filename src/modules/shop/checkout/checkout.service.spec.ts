import { HttpException, HttpStatus } from '@nestjs/common';
import { ShopSettingsPublicDto } from '../settings/dto/shop-settings.dto.js';
import { CheckoutService } from './checkout.service.js';
import { QuoteRequestDto } from './dto/quote-request.dto.js';
import { verifyQuoteToken } from './quote-token.util.js';

describe('CheckoutService (unit)', () => {
  let service: CheckoutService;
  let mockPrisma: any;
  let mockSettingsService: any;
  const originalSecret = process.env.JWT_SECRET;

  const buyerUserId = '99999999-9999-4999-8999-999999999999';
  const testZoneId = '55555555-5555-4555-8555-555555555555';
  const testProductId1 = '11111111-1111-4111-8111-111111111111';
  const testCategoryId = '22222222-2222-4222-8222-222222222222';

  const defaultDbTime = Temporal.Instant.from('2026-10-23T12:00:00.000Z');

  const defaultSettings: ShopSettingsPublicDto = {
    version: 1,
    currency: 'USD',
    shipping: {
      status: 'FREE_INCLUDED',
      amountCents: 0,
      includedInPrices: true,
    },
    tax: {
      mode: 'SIMULATED',
      enabled: true,
      rateBps: 1500,
      ratePercent: 15,
    },
    limits: {
      maxUnitsPerSkuPerOrder: 10,
    },
    deliverySchedule: {
      timeZone: 'America/Guayaquil',
      startTime: '07:00',
      endTime: '17:00',
      boundariesInclusive: true,
    },
    updatedAt: '2026-10-23T12:00:00.000Z',
  };

  const createZoneRow = (depotLat: number | null = -1.24, depotLng: number | null = -78.61) => ({
    id: testZoneId,
    name: 'Zona Centro',
    code: 'CENTRO',
    depotLat,
    depotLng,
  });

  const createProductRow = (overrides: Partial<any> = {}) => ({
    id: testProductId1,
    name: 'Caja sorpresa navideña',
    sku: 'REG-NAV-001',
    stock: 8,
    price: 36.5,
    priceCents: 3650n,
    isPublished: true,
    categoryId: testCategoryId,
    category: {
      id: testCategoryId,
      name: 'Navidad',
      isActive: true,
    },
    ...overrides,
  });

  const createQuoteRequest = (
    items = [{ productId: testProductId1, quantity: 2 }],
    scheduledDeliveryDate = '2026-11-15T10:00:00-05:00',
  ): QuoteRequestDto => ({
    items,
    delivery: {
      recipient: {
        name: 'Ana Regalo',
        phone: '0991234567',
      },
      zoneId: testZoneId,
      deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
      deliveryLocation: {
        lat: -1.2425,
        lng: -78.6188,
      },
      scheduledDeliveryDate,
      deliveryNotes: 'Entregar en recepcion',
    },
  });

  let currentProducts: any[] = [];
  let currentZone: any = null;

  beforeEach(() => {
    process.env.JWT_SECRET = 'unit-test-secret-key-checkout-2026';
    currentProducts = [createProductRow()];
    currentZone = createZoneRow();

    mockPrisma = {
      client: {
        raw: {
          sql: jest.fn().mockReturnValue({
            returnsRow: jest.fn().mockReturnValue({
              build: jest.fn().mockReturnValue({ query: 'MOCK_QUERY' }),
            }),
            affectedCount: jest.fn().mockReturnValue({
              build: jest.fn().mockReturnValue({ query: 'MOCK_AFFECTED' }),
            }),
          }),
        },
        orm: {
          public: {
            Zone: {
              where: jest.fn().mockReturnValue({
                first: jest.fn().mockImplementation(() => Promise.resolve(currentZone)),
              }),
            },
            Product: {
              where: jest.fn().mockReturnValue({
                include: jest.fn().mockReturnValue({
                  all: jest.fn().mockImplementation(() => Promise.resolve(currentProducts)),
                }),
              }),
            },
          },
        },
        transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => {
          const tx = {
            query: jest.fn().mockImplementation(() => {
              return Promise.resolve([{ instant: defaultDbTime }]);
            }),
            execute: jest.fn().mockResolvedValue({ affectedRows: 0 }),
            orm: mockPrisma.client.orm,
          };
          return cb(tx);
        }),
      },
    };

    mockSettingsService = {
      getPublicSettings: jest.fn().mockResolvedValue(defaultSettings),
    };

    service = new CheckoutService(mockPrisma, mockSettingsService);
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  describe('quoteCheckout happy path', () => {
    it('produces an exact quote with subtotal $73.00, 15% IVA $10.95, shipping $0, total $83.95', async () => {
      const quote = await service.quoteCheckout(buyerUserId, createQuoteRequest());

      expect(quote).toEqual({
        currency: 'USD',
        items: [
          {
            productId: testProductId1,
            name: 'Caja sorpresa navideña',
            quantity: 2,
            unitPriceCents: 3650,
            lineTotalCents: 7300,
            availableStock: 8,
            available: true,
          },
        ],
        subtotalCents: 7300,
        shipping: {
          status: 'FREE_INCLUDED',
          amountCents: 0,
          includedInPrices: true,
        },
        tax: {
          mode: 'SIMULATED',
          enabled: true,
          rateBps: 1500,
          ratePercent: 15,
          amountCents: 1095,
        },
        totalCents: 8395,
        settingsVersion: 1,
        validUntil: defaultDbTime.add({ minutes: 15 }).toString(),
        quoteToken: expect.stringMatching(/^qtk_v1\..+\..+$/),
      });

      // Verify the generated token binds buyer and data
      const verified = verifyQuoteToken(quote.quoteToken, buyerUserId, defaultDbTime);
      expect(verified.buyerUserId).toBe(buyerUserId);
      expect(verified.totalCents).toBe(8395);
      expect(verified.settingsVersion).toBe(1);
    });

    it('reports available: false when product stock is less than requested quantity without failing quote', async () => {
      currentProducts = [createProductRow({ stock: 1 })];

      const quote = await service.quoteCheckout(buyerUserId, createQuoteRequest());
      expect(quote.items[0].availableStock).toBe(1);
      expect(quote.items[0].available).toBe(false);
      expect(quote.totalCents).toBe(8395);
    });
  });

  describe('duplicate consolidation & dynamic SKU limits', () => {
    it('consolidates duplicated product lines and rejects 6+5=11 exceeding dynamic limit 10 with 422 QUANTITY_LIMIT_EXCEEDED', async () => {
      const requestWithDuplicates = createQuoteRequest([
        { productId: testProductId1, quantity: 6 },
        { productId: testProductId1, quantity: 5 },
      ]);

      try {
        await service.quoteCheckout(buyerUserId, requestWithDuplicates);
        fail('Should have thrown QUANTITY_LIMIT_EXCEEDED');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(err.getResponse().error.code).toBe('QUANTITY_LIMIT_EXCEEDED');
        expect(err.getResponse().error.details).toEqual({
          productId: testProductId1,
          requestedQuantity: 11,
          maximumAllowed: 10,
        });
      }
    });

    it('accepts consolidated quantity equal to the boundary maximum 10', async () => {
      const boundaryRequest = createQuoteRequest([
        { productId: testProductId1, quantity: 6 },
        { productId: testProductId1, quantity: 4 },
      ]);

      const quote = await service.quoteCheckout(buyerUserId, boundaryRequest);
      expect(quote.items[0].quantity).toBe(10);
      expect(quote.items[0].lineTotalCents).toBe(36500);
    });
  });

  describe('geographic & zone validation', () => {
    it('throws 404 ZONE_NOT_FOUND when zoneId does not exist', async () => {
      currentZone = null;

      try {
        await service.quoteCheckout(buyerUserId, createQuoteRequest());
        fail('Should have thrown ZONE_NOT_FOUND');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect(err.getResponse().error.code).toBe('ZONE_NOT_FOUND');
        expect(err.getResponse().error.details).toEqual({ zoneId: testZoneId });
      }
    });

    it('throws 422 DELIVERY_INVALID when zone has no depot coordinates configured', async () => {
      currentZone = createZoneRow(null, null);

      try {
        await service.quoteCheckout(buyerUserId, createQuoteRequest());
        fail('Should have thrown DELIVERY_INVALID');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(err.getResponse().error.code).toBe('DELIVERY_INVALID');
      }
    });
  });

  describe('delivery schedule and operating hours', () => {
    it('throws 422 DELIVERY_INVALID when scheduled delivery date is in the past relative to DB clock', async () => {
      const pastRequest = createQuoteRequest(
        [{ productId: testProductId1, quantity: 2 }],
        '2026-10-20T10:00:00-05:00',
      );

      try {
        await service.quoteCheckout(buyerUserId, pastRequest);
        fail('Should have thrown DELIVERY_INVALID');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(err.getResponse().error.code).toBe('DELIVERY_INVALID');
      }
    });

    it('throws 422 DELIVERY_OUTSIDE_HOURS for 06:59 local America/Guayaquil time', async () => {
      const outsideRequest = createQuoteRequest(
        [{ productId: testProductId1, quantity: 2 }],
        '2026-11-15T06:59:00-05:00',
      );

      try {
        await service.quoteCheckout(buyerUserId, outsideRequest);
        fail('Should have thrown DELIVERY_OUTSIDE_HOURS');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(err.getResponse().error.code).toBe('DELIVERY_OUTSIDE_HOURS');
        expect(err.getResponse().error.details).toEqual({
          startTime: '07:00',
          endTime: '17:00',
          timeZone: 'America/Guayaquil',
          requestedTime: '06:59',
        });
      }
    });

    it('throws 422 DELIVERY_OUTSIDE_HOURS for 17:01 local America/Guayaquil time', async () => {
      const outsideRequest = createQuoteRequest(
        [{ productId: testProductId1, quantity: 2 }],
        '2026-11-15T17:01:00-05:00',
      );

      try {
        await service.quoteCheckout(buyerUserId, outsideRequest);
        fail('Should have thrown DELIVERY_OUTSIDE_HOURS');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(err.getResponse().error.code).toBe('DELIVERY_OUTSIDE_HOURS');
      }
    });

    it('accepts boundary inclusive times 07:00 and 17:00 local time', async () => {
      const startBoundaryRequest = createQuoteRequest(
        [{ productId: testProductId1, quantity: 2 }],
        '2026-11-15T07:00:00-05:00',
      );
      const quoteStart = await service.quoteCheckout(buyerUserId, startBoundaryRequest);
      expect(quoteStart.totalCents).toBe(8395);

      const endBoundaryRequest = createQuoteRequest(
        [{ productId: testProductId1, quantity: 2 }],
        '2026-11-15T17:00:00-05:00',
      );
      const quoteEnd = await service.quoteCheckout(buyerUserId, endBoundaryRequest);
      expect(quoteEnd.totalCents).toBe(8395);
    });
  });

  describe('product catalog and publication checks', () => {
    it('throws 404 PRODUCT_NOT_FOUND when productId does not exist', async () => {
      currentProducts = [];

      try {
        await service.quoteCheckout(buyerUserId, createQuoteRequest());
        fail('Should have thrown PRODUCT_NOT_FOUND');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect(err.getResponse().error.code).toBe('PRODUCT_NOT_FOUND');
        expect(err.getResponse().error.details).toEqual({ productId: testProductId1 });
      }
    });

    it('throws 409 PRODUCT_UNPUBLISHED when product is unpublished', async () => {
      currentProducts = [createProductRow({ isPublished: false })];

      try {
        await service.quoteCheckout(buyerUserId, createQuoteRequest());
        fail('Should have thrown PRODUCT_UNPUBLISHED');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(err.getResponse().error.code).toBe('PRODUCT_UNPUBLISHED');
      }
    });

    it('throws 409 PRODUCT_UNPUBLISHED when category is inactive', async () => {
      currentProducts = [
        createProductRow({
          category: {
            id: testCategoryId,
            name: 'Navidad',
            isActive: false, // Inactive category
          },
        }),
      ];

      try {
        await service.quoteCheckout(buyerUserId, createQuoteRequest());
        fail('Should have thrown PRODUCT_UNPUBLISHED');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(err.getResponse().error.code).toBe('PRODUCT_UNPUBLISHED');
      }
    });

    it('throws 409 PRODUCT_UNPUBLISHED when priceCents is null or non-positive', async () => {
      currentProducts = [createProductRow({ priceCents: null })];

      try {
        await service.quoteCheckout(buyerUserId, createQuoteRequest());
        fail('Should have thrown PRODUCT_UNPUBLISHED');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(err.getResponse().error.code).toBe('PRODUCT_UNPUBLISHED');
      }
    });
  });
});
