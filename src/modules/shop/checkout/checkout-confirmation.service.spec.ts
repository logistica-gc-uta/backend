import { HttpStatus } from '@nestjs/common';
import { CheckoutConfirmationService } from './checkout-confirmation.service.js';

describe('CheckoutConfirmationService unit tests', () => {
  let service: CheckoutConfirmationService;
  let mockPrisma: any;
  let mockSettings: any;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

    mockPrisma = {
      client: {
        raw: {
          sql: jest.fn().mockReturnValue({
            returnsRow: jest.fn().mockReturnValue({
              build: jest.fn().mockReturnValue({}),
            }),
            affectedCount: jest.fn().mockReturnValue({
              build: jest.fn().mockReturnValue({}),
            }),
            build: jest.fn().mockReturnValue({}),
          }),
        },
        transaction: jest.fn().mockImplementation(async (cb: any) => {
          const tx = {
            execute: jest.fn().mockResolvedValue(1),
            query: jest.fn().mockImplementation(async () => {
              return [{ instant: Temporal.Now.instant() }];
            }),
          };
          return cb(tx);
        }),
        orm: {
          public: {
            CheckoutAttempt: {
              where: jest.fn().mockReturnValue({
                first: jest.fn().mockResolvedValue(null),
              }),
            },
          },
        },
      },
    };

    mockSettings = {
      getPublicSettings: jest.fn().mockResolvedValue({
        version: 1,
        currency: 'USD',
        shipping: { status: 'FREE_INCLUDED', amountCents: 0, includedInPrices: true },
        tax: { mode: 'SIMULATED', enabled: true, rateBps: 1500, ratePercent: 15 },
        limits: { maxUnitsPerSkuPerOrder: 10 },
        deliverySchedule: {
          timeZone: 'America/Guayaquil',
          startTime: '07:00',
          endTime: '17:00',
          boundariesInclusive: true,
        },
        updatedAt: '2026-10-23T00:00:00.000Z',
      }),
    };

    service = new CheckoutConfirmationService(mockPrisma as any, mockSettings as any);
  });

  afterEach(() => {
    delete process.env.SIMULATED_PAYMENTS_ENABLED;
  });

  it('rejects invalid or non-UUIDv4 idempotency key with HTTP 400 VALIDATION_ERROR', async () => {
    await expect(
      service.confirmCheckout('user-1', 'not-a-uuid', {} as any),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      response: {
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining('Idempotency-Key'),
        },
      },
    });
  });

  it('fails closed with 503 PAYMENT_SIMULATION_DISABLED when simulation flag is disabled', async () => {
    process.env.SIMULATED_PAYMENTS_ENABLED = 'false';

    await expect(
      service.confirmCheckout('user-1', '77777777-7777-4777-8777-777777777777', {
        paymentCard: {
          number: '9000 0000 0000 0001',
          holderName: 'PRUEBA APROBADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '111',
        },
      } as any),
    ).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: {
        error: {
          code: 'PAYMENT_SIMULATION_DISABLED',
        },
      },
    });
  });

  it('rejects invalid card fixture with 422 CARD_INVALID', async () => {
    await expect(
      service.confirmCheckout('user-1', '77777777-7777-4777-8777-777777777777', {
        items: [{ productId: 'p1', quantity: 1 }],
        delivery: {
          recipient: { name: 'Juan', phone: '0991234567' },
          zoneId: 'z1',
          deliveryAddress: 'Calle 1',
          deliveryLocation: { lat: -1.2, lng: -78.6 },
          scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        },
        quoteToken: 'tok',
        paymentCard: {
          number: '4111 1111 1111 1111', // Not a demo fixture
          holderName: 'PRUEBA APROBADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '111',
        },
      } as any),
    ).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      response: {
        error: {
          code: 'CARD_INVALID',
        },
      },
    });
  });

  it('throws 409 IDEMPOTENCY_KEY_REUSED when same key was previously used with a different request hash', async () => {
    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        query: jest.fn().mockResolvedValue([
          {
            id: 'attempt-1',
            requestHash: 'different-hash',
            status: 'SUCCEEDED',
            successSnapshot: { status: 'SUCCEEDED' },
          },
        ]),
      };
      return cb(tx);
    });

    await expect(
      service.confirmCheckout('user-1', '77777777-7777-4777-8777-777777777777', {
        items: [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
        delivery: {
          recipient: { name: 'Juan', phone: '0991234567' },
          zoneId: '22222222-2222-4222-8222-222222222222',
          deliveryAddress: 'Av. Cevallos 100',
          deliveryLocation: { lat: -1.24, lng: -78.61 },
          scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        },
        quoteToken: 'token1234567890',
        paymentCard: {
          number: '9000 0000 0000 0001',
          holderName: 'PRUEBA APROBADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '111',
        },
      } as any),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
        },
      },
    });
  });

  it('returns cached success snapshot when same key and identical request hash are replayed', async () => {
    const cachedSuccess = {
      checkoutAttemptId: 'attempt-1',
      status: 'SUCCEEDED',
      order: {
        id: 'order-1',
        number: 'RG-2026-0001',
        status: 'PENDING',
        totalCents: 8395,
        subtotalCents: 7300,
        taxAmountCents: 1095,
        taxRateBps: 1500,
        shippingAmountCents: 0,
        taxEnabled: true,
        currency: 'USD',
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      payment: {
        status: 'APPROVED',
        amountCents: 8395,
        cardLast4: '0001',
        reference: 'PAY-DEMO-0001',
      },
      receipt: {
        id: 'receipt-1',
        number: 'CMP-RG-2026-0001',
      },
    };

    // Calculate actual hash for test payload to simulate exact match
    const { buildCanonicalIntent, hashCanonicalIntent } = await import('./checkout-intent.util.js');
    const intent = buildCanonicalIntent({
      items: [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
      delivery: {
        recipient: { name: 'Juan', phone: '0991234567' },
        zoneId: '22222222-2222-4222-8222-222222222222',
        deliveryAddress: 'Av. Cevallos 100',
        deliveryLocation: { lat: -1.24, lng: -78.61 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      quoteToken: 'token1234567890',
      cardFixtureId: 'DEMO_APPROVED',
    });
    const matchingHash = hashCanonicalIntent(intent);

    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        query: jest.fn().mockResolvedValue([
          {
            id: 'attempt-1',
            requestHash: matchingHash,
            status: 'SUCCEEDED',
            successSnapshot: cachedSuccess,
          },
        ]),
      };
      return cb(tx);
    });

    const result = await service.confirmCheckout(
      'user-1',
      '77777777-7777-4777-8777-777777777777',
      {
        items: [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
        delivery: {
          recipient: { name: 'Juan', phone: '0991234567' },
          zoneId: '22222222-2222-4222-8222-222222222222',
          deliveryAddress: 'Av. Cevallos 100',
          deliveryLocation: { lat: -1.24, lng: -78.61 },
          scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        },
        quoteToken: 'token1234567890',
        paymentCard: {
          number: '9000 0000 0000 0001',
          holderName: 'PRUEBA APROBADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '111',
        },
      } as any,
    );

    expect(result).toEqual(cachedSuccess);
  });

  it('fails closed with 409 PRODUCT_UNPUBLISHED when product category association changed between discovery and product lock', async () => {
    const { signQuoteToken } = await import('./quote-token.util.js');
    process.env.JWT_SECRET = 'supersecretlongenough12345678901234567890';
    const prodId = '11111111-1111-4111-8111-111111111111';
    const zoneId = '22222222-2222-4222-8222-222222222222';
    const buyerUserId = 'user-1';

    const quoteToken = signQuoteToken({
      buyerUserId,
      issuedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 600000).toISOString(),
      settingsVersion: 1,
      currency: 'USD',
      items: [{ productId: prodId, quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000 }],
      delivery: {
        zoneId,
        recipient: { name: 'Juan', phone: '0991234567' },
        deliveryAddress: 'Av. Cevallos 100',
        deliveryLocation: { lat: -1.24, lng: -78.61 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      subtotalCents: 1000,
      shippingAmountCents: 0,
      tax: { mode: 'SIMULATED', enabled: true, rateBps: 1500, amountCents: 150 },
      totalCents: 1150,
    });

    let queryCall = 0;
    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        execute: jest.fn().mockResolvedValue(1),
        query: jest.fn().mockImplementation(async () => {
          queryCall++;
          if (queryCall === 1) return []; // initial attempt check
          if (queryCall === 2) {
            // lock attempt
            return [{ id: 'attempt-1', status: 'PROCESSING', requestHash: 'hash-1' }];
          }
          if (queryCall === 3) {
            // discovery: product category was cat-A
            return [{ categoryId: 'cat-A' }];
          }
          if (queryCall === 4) {
            // category lock: cat-A locked FOR SHARE
            return [{ id: 'cat-A', isActive: true }];
          }
          if (queryCall === 5) {
            // lockInventoryProduct
            return [{ id: prodId, name: 'Rosas Rojas', price: 10, stock: 10 }];
          }
          if (queryCall === 6) {
            // product lock: product category concurrently changed to cat-B (unlocked!)
            return [
              {
                id: prodId,
                name: 'Rosas Rojas',
                sku: 'ROS-01',
                price: 10,
                stock: 10,
                priceCents: 1000n,
                isPublished: true,
                categoryId: 'cat-B', // Changed concurrently!
                categoryIsActive: true,
              },
            ];
          }
          if (queryCall === 7) {
            // card lock
            return [
              {
                id: 'card-1',
                fixtureId: 'DEMO_APPROVED',
                last4: '0001',
                active: true,
                balanceCents: 100000n,
              },
            ];
          }
          if (queryCall === 8) {
            // nowDb
            return [{ instant: Temporal.Now.instant() }];
          }
          return [];
        }),
      };
      return cb(tx);
    });

    await expect(
      service.confirmCheckout(
        buyerUserId,
        '77777777-7777-4777-8777-777777777777',
        {
          items: [{ productId: prodId, quantity: 1 }],
          delivery: {
            recipient: { name: 'Juan', phone: '0991234567' },
            zoneId,
            deliveryAddress: 'Av. Cevallos 100',
            deliveryLocation: { lat: -1.24, lng: -78.61 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
          },
          quoteToken,
          paymentCard: {
            number: '9000 0000 0000 0001',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
        } as any,
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        error: {
          code: 'PRODUCT_UNPUBLISHED',
          message: expect.stringContaining('su categoría cambió concurrentemente'),
        },
      },
    });
  });
});
