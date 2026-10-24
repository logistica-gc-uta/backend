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
          sql: jest.fn().mockImplementation(() => ({
            returnsRow: jest.fn().mockImplementation((spec: any) => ({
              build: jest.fn().mockReturnValue({ spec }),
            })),
            affectedCount: jest.fn().mockReturnValue({
              build: jest.fn().mockReturnValue({}),
            }),
            build: jest.fn().mockReturnValue({}),
          })),
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

    let queryCount = 0;
    // The invalid fixture is rejected after ownership is verified.
    const { buildCanonicalIntent, hashCanonicalIntent } = await import('./checkout-intent.util.js');
    const invalidIntent = buildCanonicalIntent({
      items: [{ productId: prodId, quantity: 1 }],
      delivery: {
        recipient: { name: 'Juan', phone: '0991234567' }, zoneId,
        deliveryAddress: 'Av. Cevallos 100',
        deliveryLocation: { lat: -1.24, lng: -78.61 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      }, quoteToken, cardFixtureId: 'UNKNOWN_FIXTURE',
    });
    const invalidHash = hashCanonicalIntent(invalidIntent);
    mockPrisma.client.transaction.mockImplementation(async (cb: any) => cb({
      execute: jest.fn().mockResolvedValue(1),
      query: jest.fn().mockImplementation(async () => {
        queryCount++;
        if (queryCount === 1) return [];
        if (queryCount === 2) return [{ instant: Temporal.Now.instant() }];
        if (queryCount === 3) return [{ locked: 1 }];
        if (queryCount === 4) return [{ id: 'attempt-1', status: 'PROCESSING', requestHash: invalidHash }];
        return [{ instant: Temporal.Now.instant() }];
      }),
    }));
    jest.spyOn(service as any, 'acquireProcessingReservation').mockResolvedValue({ acquired: true, attemptId: 'attempt-1' });

    await expect(
      service.confirmCheckout(buyerUserId, '77777777-7777-4777-8777-777777777777', {
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

    const { buildCanonicalIntent, hashCanonicalIntent } = await import('./checkout-intent.util.js');
    const intent = buildCanonicalIntent({
      items: [{ productId: prodId, quantity: 1 }],
      delivery: {
        recipient: { name: 'Juan', phone: '0991234567' },
        zoneId,
        deliveryAddress: 'Av. Cevallos 100',
        deliveryLocation: { lat: -1.24, lng: -78.61 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      quoteToken,
      cardFixtureId: 'DEMO_APPROVED',
    });
    const matchingHash = hashCanonicalIntent(intent);

    jest.spyOn(service as any, 'acquireProcessingReservation').mockResolvedValue({ acquired: true, attemptId: 'attempt-1' });
    let queryCall = 0;
    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        execute: jest.fn().mockResolvedValue(1),
        query: jest.fn().mockImplementation(async (plan: any) => {
          if (plan?.spec?.instant) {
            return [{ instant: Temporal.Now.instant() }];
          }
          queryCall++;
          if (queryCall === 1) return []; // no existing attempt
          if (queryCall === 2) return []; // advisory lock Level 0
          if (queryCall === 3) {
            return [{ id: 'attempt-1', status: 'PROCESSING', requestHash: matchingHash }];
          }
          if (queryCall === 4) {
            // discovery: product category was cat-A
            return [{ categoryId: 'cat-A' }];
          }
          if (queryCall === 5) {
            // category lock: cat-A locked FOR SHARE
            return [{ id: 'cat-A', isActive: true }];
          }
          if (queryCall === 6) {
            // lockInventoryProduct
            return [{ id: prodId, name: 'Rosas Rojas', price: 10, stock: 10 }];
          }
          if (queryCall === 7) {
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
          if (queryCall === 8) {
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


  it('preflight verifies quote token against authoritative DB clock skew and acquires NO reservation when DB clock shows token expired', async () => {
    const { signQuoteToken } = await import('./quote-token.util.js');
    process.env.JWT_SECRET = 'supersecretlongenough12345678901234567890';
    const prodId = '11111111-1111-4111-8111-111111111111';
    const zoneId = '22222222-2222-4222-8222-222222222222';
    const buyerUserId = 'user-1';

    // Quote valid until 10 seconds in the future according to app clock
    const validUntilIso = new Date(Date.now() + 10_000).toISOString();
    const quoteToken = signQuoteToken({
      buyerUserId,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      validUntil: validUntilIso,
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

    let acquiredCalled = false;
    // Mock DB clock returning a timestamp 20 seconds ahead of validUntil (DB clock skew!)
    const dbClockInstant = Temporal.Instant.from(new Date(Date.now() + 30_000).toISOString());
    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        execute: jest.fn().mockImplementation(async () => {
          acquiredCalled = true;
          return 1;
        }),
        query: jest.fn().mockImplementation(async (plan: any) => {
          return [{ instant: dbClockInstant }];
        }),
      };
      return cb(tx);
    });

    await expect(
      service.confirmCheckout(
        buyerUserId,
        '88888888-8888-4888-8888-888888888888',
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
          code: 'QUOTE_EXPIRED',
        },
      },
    });

    // Verification: Reservation was NEVER acquired!
    expect(acquiredCalled).toBe(false);
  });

  it('preflight validates full canonical delivery binding and acquires NO reservation on delivery mismatch', async () => {
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
        recipient: { name: 'Juan Original', phone: '0991234567' },
        deliveryAddress: 'Av. Cevallos 100',
        deliveryLocation: { lat: -1.24, lng: -78.61 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      subtotalCents: 1000,
      shippingAmountCents: 0,
      tax: { mode: 'SIMULATED', enabled: true, rateBps: 1500, amountCents: 150 },
      totalCents: 1150,
    });

    let acquiredCalled = false;
    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        execute: jest.fn().mockImplementation(async () => {
          acquiredCalled = true;
          return 1;
        }),
        query: jest.fn().mockResolvedValue([{ instant: Temporal.Now.instant() }]),
      };
      return cb(tx);
    });

    // Request payload changes recipient name
    await expect(
      service.confirmCheckout(
        buyerUserId,
        '88888888-8888-4888-8888-888888888889',
        {
          items: [{ productId: prodId, quantity: 1 }],
          delivery: {
            recipient: { name: 'Juan Modificado', phone: '0991234567' },
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
      status: HttpStatus.BAD_REQUEST,
      response: {
        error: {
          code: 'VALIDATION_ERROR',
        },
      },
    });

    expect(acquiredCalled).toBe(false);
  });

  it.each([
    ['missing', null],
    ['different owner', { id: 'another-attempt', status: 'PROCESSING' }],
  ])('fails closed before business work when reserved attempt is %s under key lock', async (_case, lockedRow) => {
    const { signQuoteToken } = await import('./quote-token.util.js');
    process.env.JWT_SECRET = 'unit-only-dummy-secret-12345678901234567890';
    const buyerUserId = 'user-1';
    const productId = '11111111-1111-4111-8111-111111111111';
    const zoneId = '22222222-2222-4222-8222-222222222222';
    const delivery = {
      recipient: { name: 'Juan', phone: '0991234567' }, zoneId,
      deliveryAddress: 'Av. Cevallos 100',
      deliveryLocation: { lat: -1.24, lng: -78.61 },
      scheduledDeliveryDate: '2030-11-15T15:00:00.000Z',
    };
    const quoteToken = signQuoteToken({
      buyerUserId, issuedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 600000).toISOString(),
      settingsVersion: 1, currency: 'USD',
      items: [{ productId, quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000 }],
      delivery, subtotalCents: 1000, shippingAmountCents: 0,
      tax: { mode: 'SIMULATED', enabled: true, rateBps: 1500, amountCents: 150 },
      totalCents: 1150,
    });
    const { buildCanonicalIntent, hashCanonicalIntent } = await import('./checkout-intent.util.js');
    const requestHash = hashCanonicalIntent(buildCanonicalIntent({
      items: [{ productId, quantity: 1 }], delivery, quoteToken,
      cardFixtureId: 'DEMO_APPROVED',
    }));
    let queryCount = 0;
    const execute = jest.fn().mockResolvedValue(1);
    mockPrisma.client.transaction.mockImplementation(async (cb: any) => cb({
      execute,
      query: jest.fn().mockImplementation(async () => {
        queryCount++;
        if (queryCount === 1) return []; // no existing attempt
        if (queryCount === 2) return [{ instant: Temporal.Now.instant() }]; // DB preflight
        if (queryCount === 3) return [{ locked: 1 }]; // advisory lock
        if (queryCount === 4) return lockedRow ? [{ ...lockedRow, requestHash }] : []; // ownership read
        return []; // terminal resolution after rollback
      }),
    }));

    await expect(service.confirmCheckout(buyerUserId, '88888888-8888-4888-8888-888888888891', {
      items: [{ productId, quantity: 1 }], delivery, quoteToken,
      paymentCard: {
        number: '9000 0000 0000 0001', holderName: 'PRUEBA APROBADA',
        expiresMonth: 12, expiresYear: 2030, cvv: '111',
      },
    } as any)).rejects.toMatchObject({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      response: { error: { code: 'INTERNAL_ERROR', details: {} } },
    });
    expect(mockSettings.getPublicSettings).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1); // only reservation INSERT, no stock/card writes
  });

  // Public replay: only the persisted attempt changes between polls; the purchase path stays untouched.
  const replay = async (observations: Array<Record<string, unknown>>) => {
    const { buildCanonicalIntent, hashCanonicalIntent } = await import('./checkout-intent.util.js');
    const key = '88888888-8888-4888-8888-888888888892';
    const dto = {
      items: [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
      delivery: {
        recipient: { name: 'Juan', phone: '0991234567' },
        zoneId: '22222222-2222-4222-8222-222222222222',
        deliveryAddress: 'Av. Cevallos 100',
        deliveryLocation: { lat: -1.24, lng: -78.61 },
        scheduledDeliveryDate: '2030-11-15T15:00:00.000Z',
      },
      quoteToken: 'expired-but-replayable-token',
      paymentCard: {
        number: '9000 0000 0000 0001', holderName: 'PRUEBA APROBADA',
        expiresMonth: 12, expiresYear: 2030, cvv: '111',
      },
    };
    const requestHash = hashCanonicalIntent(buildCanonicalIntent({
      items: dto.items, delivery: dto.delivery, quoteToken: dto.quoteToken,
      cardFixtureId: 'DEMO_APPROVED',
    }));
    const execute = jest.fn();
    const query = jest.fn().mockImplementation(async () => {
      const next = observations.shift();
      return next ? [{ id: 'attempt-1', requestHash, ...next }] : [];
    });
    mockPrisma.client.transaction.mockImplementation(async (cb: any) => cb({ query, execute }));
    return { promise: service.confirmCheckout('user-1', key, dto as any), query, execute, key };
  };

  it('replays the exact stored success after observing PROCESSING, without any purchase work', async () => {
    jest.useFakeTimers();
    try {
      const snapshot = {
        checkoutAttemptId: 'attempt-1', status: 'SUCCEEDED',
        order: { id: 'order-1', totalCents: 8395 },
        payment: { status: 'APPROVED', reference: 'PAY-DEMO-0001' },
        receipt: { id: 'receipt-1', number: 'CMP-1' },
      };
      const { promise, query, execute } = await replay([
        { status: 'PROCESSING' }, { status: 'PROCESSING' },
        { status: 'SUCCEEDED', successSnapshot: snapshot },
      ]);
      await jest.advanceTimersByTimeAsync(100);
      expect(await promise).toBe(snapshot);
      expect(query).toHaveBeenCalledTimes(3);
      expect(execute).not.toHaveBeenCalled();
      expect(mockSettings.getPublicSettings).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['STOCK_UNAVAILABLE', HttpStatus.CONFLICT, { productId: 'product-1', availableStock: 0 }],
    ['INSUFFICIENT_DEMO_FUNDS', HttpStatus.UNPROCESSABLE_ENTITY, { requiredCents: 8395 }],
  ])('replays a persisted %s rejection after PROCESSING, including original details', async (code, status, details) => {
    jest.useFakeTimers();
    try {
      const { promise, execute } = await replay([
        { status: 'PROCESSING' },
        { status: 'REJECTED', errorCode: code, errorMessage: 'Decisión original', errorDetails: details },
      ]);
      const assertion = expect(promise).rejects.toMatchObject({
        status, response: { error: { code, message: 'Decisión original', details } },
      });
      await jest.advanceTimersByTimeAsync(100);
      await assertion;
      expect(execute).not.toHaveBeenCalled();
      expect(mockSettings.getPublicSettings).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed for a previously FAILED attempt after PROCESSING, without creating a purchase', async () => {
    jest.useFakeTimers();
    try {
      const { promise, execute } = await replay([
        { status: 'PROCESSING' }, { status: 'FAILED', errorCode: 'INTERNAL_ERROR' },
      ]);
      const assertion = expect(promise).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        response: { error: { code: 'INTERNAL_ERROR', details: {} } },
      });
      await jest.advanceTimersByTimeAsync(100);
      await assertion;
      expect(execute).not.toHaveBeenCalled();
      expect(mockSettings.getPublicSettings).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['SUCCEEDED', { successSnapshot: { checkoutAttemptId: 'attempt-1', status: 'SUCCEEDED', order: { id: 'order-1' }, receipt: { id: 'receipt-1' } } }],
    ['REJECTED', { errorCode: 'PRICE_CHANGED', errorMessage: 'Precio original', errorDetails: { productId: 'product-1' } }],
    ['PROCESSING', {}],
  ])('makes the deadline final read authoritative when it observes %s', async (status, fields) => {
    jest.useFakeTimers();
    try {
      const observations = [{ status: 'PROCESSING' }];
      // Initial read plus all polling reads; the final read sees the terminal decision (or still PROCESSING).
      for (let i = 0; i < 50; i++) observations.push({ status: 'PROCESSING' });
      observations.push({ status, ...fields });
      const { promise, query, execute, key } = await replay(observations);
      if (status === 'SUCCEEDED' && 'successSnapshot' in fields) {
        const assertion = expect(promise).resolves.toBe(fields.successSnapshot);
        await jest.advanceTimersByTimeAsync(5000);
        await assertion;
      } else {
        const assertion = expect(promise).rejects.toMatchObject(status === 'REJECTED' ? {
          status: HttpStatus.CONFLICT,
          response: { error: { code: 'PRICE_CHANGED', message: 'Precio original', details: { productId: 'product-1' } } },
        } : {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          response: { error: { code: 'INTERNAL_ERROR', details: { idempotencyKey: key } } },
        });
        await jest.advanceTimersByTimeAsync(5000);
        await assertion;
      }
      expect(query).toHaveBeenCalledTimes(52);
      expect(execute).not.toHaveBeenCalled();
      expect(mockSettings.getPublicSettings).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rechecks attempt under key lock and throws immediately without falling through when attempt is FAILED', async () => {
    const { buildCanonicalIntent, hashCanonicalIntent } = await import('./checkout-intent.util.js');
    const prodId = '11111111-1111-4111-8111-111111111111';
    const zoneId = '22222222-2222-4222-8222-222222222222';
    const buyerUserId = 'user-1';
    const idempotencyKey = '88888888-8888-4888-8888-888888888890';

    const intent = buildCanonicalIntent({
      items: [{ productId: prodId, quantity: 1 }],
      delivery: {
        recipient: { name: 'Juan', phone: '0991234567' },
        zoneId,
        deliveryAddress: 'Av. Cevallos 100',
        deliveryLocation: { lat: -1.24, lng: -78.61 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      quoteToken: 'token1234567890',
      cardFixtureId: 'DEMO_APPROVED',
    });
    const requestHash = hashCanonicalIntent(intent);

    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        execute: jest.fn().mockResolvedValue(1),
        query: jest.fn().mockResolvedValue([
          {
            id: 'attempt-failed-1',
            userId: buyerUserId,
            idempotencyKey,
            requestHash,
            status: 'FAILED',
            errorCode: 'INTERNAL_ERROR',
            errorMessage: 'Error interno previo',
          },
        ]),
      };
      return cb(tx);
    });

    await expect(
      service.confirmCheckout(
        buyerUserId,
        idempotencyKey,
        {
          items: [{ productId: prodId, quantity: 1 }],
          delivery: {
            recipient: { name: 'Juan', phone: '0991234567' },
            zoneId,
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
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      response: {
        error: {
          code: 'INTERNAL_ERROR',
        },
      },
    });
  });
});
