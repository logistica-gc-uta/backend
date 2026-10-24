import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';
import {
  bootstrapSimulatedCards,
} from '../src/modules/shop/checkout/simulated-card.js';

jest.setTimeout(240_000);

describe('Shop Payments Foundation v1.2 Database & Schema Verification (owned PostgreSQL fixture)', () => {
  let app: INestApplication;
  let db: any;
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);
  let dbUrl: string;
  let ownedContainerId: string | null = null;
  let testUserId: string;
  let testZoneId: string;
  let testOrderId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

    const receipt = startOwnedContainer();
    ownedContainerId = receipt.containerId;
    console.log(`[TEST-CONTAINER-RECEIPT] containerId=${receipt.containerId}`);
    dbUrl = createOwnedDatabase(`shop_payments_${dbSuffix}`);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get(PrismaService);

    // Setup initial baseline user, zone, order for relational tests
    testUserId = randomUUID();
    await db.user.create({
      id: testUserId,
      name: 'Test Buyer',
      email: `buyer-${testUserId}@example.test`,
      password: 'fixture-password',
      role: 'CLIENT',
    });

    testZoneId = randomUUID();
    await db.client.orm.public.Zone.create({
      id: testZoneId,
      name: `Test Zone ${dbSuffix}`,
      code: `TZ-${dbSuffix.toUpperCase()}`,
      depotLat: -1.24,
      depotLng: -78.62,
    });

    testOrderId = randomUUID();
    await db.client.orm.public.Order.create({
      id: testOrderId,
      userId: testUserId,
      zoneId: testZoneId,
      deliveryAddress: 'Av. Cevallos 123',
      status: 'PENDING',
      total: 50.0,
      subtotalCents: 5000n,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
    if (ownedContainerId) {
      console.log(`[TEST-CONTAINER-CLEANUP] containerId=${ownedContainerId}`);
    }
  });

  describe('Empty Foundation State on Migration', () => {
    it('migration creates simulatedCard table with 0 rows by default (no auto-bootstrap)', async () => {
      const cards = await db.client.orm.public.SimulatedCard.all();
      expect(cards).toHaveLength(0);
    });

    it('migration creates checkoutAttempt, paymentAttempt, purchaseReceipt tables empty', async () => {
      const attempts = await db.client.orm.public.CheckoutAttempt.all();
      expect(attempts).toHaveLength(0);
      const payments = await db.client.orm.public.PaymentAttempt.all();
      expect(payments).toHaveLength(0);
      const receipts = await db.client.orm.public.PurchaseReceipt.all();
      expect(receipts).toHaveLength(0);
    });
  });

  describe('Explicit Idempotent Bootstrap', () => {
    it('bootstraps exactly the 3 simulated cards when simulation is enabled in test (concurrent initial bootstrap)', async () => {
      // Execute two simultaneous bootstrap calls while the table is completely empty:
      // one passing PrismaService handle (db) and one passing db.client
      const [res1, res2] = await Promise.allSettled([
        bootstrapSimulatedCards(db),
        bootstrapSimulatedCards(db.client),
      ]);
      expect(res1.status).toBe('fulfilled');
      expect(res2.status).toBe('fulfilled');

      const cards = await db.client.orm.public.SimulatedCard.all();
      expect(cards).toHaveLength(3);

      const approved = cards.find((c: any) => c.fixtureId === 'DEMO_APPROVED');
      expect(approved).toBeDefined();
      expect(approved.last4).toBe('0001');
      expect(approved.active).toBe(true);
      expect(approved.balanceCents).toBe(50000n);

      const limited = cards.find((c: any) => c.fixtureId === 'DEMO_LIMITED');
      expect(limited).toBeDefined();
      expect(limited.last4).toBe('0002');
      expect(limited.active).toBe(true);
      expect(limited.balanceCents).toBe(2000n);

      const emptyCard = cards.find((c: any) => c.fixtureId === 'DEMO_EMPTY');
      expect(emptyCard).toBeDefined();
      expect(emptyCard.last4).toBe('0003');
      expect(emptyCard.active).toBe(true);
      expect(emptyCard.balanceCents).toBe(0n);
    });

    it('preserves spent balances and deactivated states upon repeated bootstrap (idempotent)', async () => {
      // Spend balance on DEMO_LIMITED from 2000n to 450n
      await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_LIMITED' }).update({
        balanceCents: 450n,
      });

      // Deactivate DEMO_EMPTY
      await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_EMPTY' }).update({
        active: false,
      });

      // Re-run bootstrap
      await bootstrapSimulatedCards(db);

      // Verify that balances and active states are untouched
      const cards = await db.client.orm.public.SimulatedCard.all();
      expect(cards).toHaveLength(3);

      const limited = cards.find((c: any) => c.fixtureId === 'DEMO_LIMITED');
      expect(limited.balanceCents).toBe(450n);

      const emptyCard = cards.find((c: any) => c.fixtureId === 'DEMO_EMPTY');
      expect(emptyCard.active).toBe(false);

      const approved = cards.find((c: any) => c.fixtureId === 'DEMO_APPROVED');
      expect(approved.balanceCents).toBe(50000n);
    });

    it('resolves cleanly under concurrent bootstrap without race conditions or duplicate fixtures', async () => {
      // Re-run two concurrent bootstrap calls simultaneously against real PostgreSQL:
      // one passing PrismaService handle (db) and one passing db.client
      const [res1, res2] = await Promise.allSettled([
        bootstrapSimulatedCards(db),
        bootstrapSimulatedCards(db.client),
      ]);
      expect(res1.status).toBe('fulfilled');
      expect(res2.status).toBe('fulfilled');

      const cards = await db.client.orm.public.SimulatedCard.all();
      expect(cards).toHaveLength(3);

      // Verify that balances and deactivation remain untouched after concurrent bootstrap
      const limited = cards.find((c: any) => c.fixtureId === 'DEMO_LIMITED');
      expect(limited.balanceCents).toBe(450n);

      const emptyCard = cards.find((c: any) => c.fixtureId === 'DEMO_EMPTY');
      expect(emptyCard.active).toBe(false);

      const approved = cards.find((c: any) => c.fixtureId === 'DEMO_APPROVED');
      expect(approved.balanceCents).toBe(50000n);
    });
  });

  describe('Database Integrity & CHECK Constraints', () => {
    it('enforces simulatedCard balance non-negative check constraint', async () => {
      await expect(
        db.client.orm.public.SimulatedCard.create({
          id: randomUUID(),
          fixtureId: 'TEST_NEGATIVE',
          last4: '9999',
          active: true,
          balanceCents: -100n,
        }),
      ).rejects.toThrow(/simulated_card_valid/i);
    });

    it('enforces simulatedCard balance maximum safe integer check constraint', async () => {
      await expect(
        db.client.orm.public.SimulatedCard.create({
          id: randomUUID(),
          fixtureId: 'TEST_OVERFLOW',
          last4: '9999',
          active: true,
          balanceCents: 9007199254740992n,
        }),
      ).rejects.toThrow(/simulated_card_valid/i);
    });

    it('enforces checkoutAttempt unique (userId, idempotencyKey) constraint', async () => {
      const idempotencyKey = `idemp-${randomUUID()}`;
      const attemptId1 = randomUUID();
      const attemptId2 = randomUUID();

      await db.client.orm.public.CheckoutAttempt.create({
        id: attemptId1,
        userId: testUserId,
        idempotencyKey,
        requestHash: 'hash-abc-123',
        status: 'PROCESSING',
      });

      // Same user and idempotencyKey must fail unique constraint
      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: attemptId2,
          userId: testUserId,
          idempotencyKey,
          requestHash: 'hash-abc-123',
          status: 'PROCESSING',
        }),
      ).rejects.toThrow(/checkoutAttempt_userId_idempotencyKey_key/i);
    });

    it('enforces purchaseReceipt unique orderId, number, commercialOrderNumber constraints', async () => {
      const receiptId = randomUUID();
      const receiptNumber = `CMP-RG-2026-${randomUUID().slice(0, 6)}`;
      const commercialNumber = `RG-2026-${randomUUID().slice(0, 6)}`;

      await db.client.orm.public.PurchaseReceipt.create({
        id: receiptId,
        orderId: testOrderId,
        number: receiptNumber,
        commercialOrderNumber: commercialNumber,
        buyerId: testUserId,
        subtotalCents: 5000n,
        taxEnabled: true,
        taxRateBps: 1500,
        taxAmountCents: 750n,
        totalCents: 5750n,
        snapshot: { items: [], delivery: {} },
      });

      // Duplicate orderId must be rejected
      const secondOrder = randomUUID();
      await db.client.orm.public.Order.create({
        id: secondOrder,
        userId: testUserId,
        zoneId: testZoneId,
        deliveryAddress: 'Av. Bolivar 456',
        status: 'PENDING',
        total: 50.0,
        subtotalCents: 5000n,
      });

      await expect(
        db.client.orm.public.PurchaseReceipt.create({
          id: randomUUID(),
          orderId: testOrderId, // duplicate orderId
          number: `CMP-RG-2026-${randomUUID().slice(0, 6)}`,
          commercialOrderNumber: `RG-2026-${randomUUID().slice(0, 6)}`,
          buyerId: testUserId,
          subtotalCents: 5000n,
          taxEnabled: true,
          taxRateBps: 1500,
          taxAmountCents: 750n,
          totalCents: 5750n,
          snapshot: {},
        }),
      ).rejects.toThrow(/purchaseReceipt_orderId_key/i);

      // Duplicate receipt number must be rejected
      await expect(
        db.client.orm.public.PurchaseReceipt.create({
          id: randomUUID(),
          orderId: secondOrder,
          number: receiptNumber, // duplicate number
          commercialOrderNumber: `RG-2026-${randomUUID().slice(0, 6)}`,
          buyerId: testUserId,
          subtotalCents: 5000n,
          taxEnabled: true,
          taxRateBps: 1500,
          taxAmountCents: 750n,
          totalCents: 5750n,
          snapshot: {},
        }),
      ).rejects.toThrow(/purchaseReceipt_number_key/i);

      // Duplicate commercial order number must be rejected
      await expect(
        db.client.orm.public.PurchaseReceipt.create({
          id: randomUUID(),
          orderId: secondOrder,
          number: `CMP-RG-2026-${randomUUID().slice(0, 6)}`,
          commercialOrderNumber: commercialNumber, // duplicate commercialOrderNumber
          buyerId: testUserId,
          subtotalCents: 5000n,
          taxEnabled: true,
          taxRateBps: 1500,
          taxAmountCents: 750n,
          totalCents: 5750n,
          snapshot: {},
        }),
      ).rejects.toThrow(/purchaseReceipt_commercialOrderNumber_key/i);
    });

    it('enforces purchaseReceipt totalCents = subtotalCents + taxAmountCents invariant', async () => {
      const thirdOrder = randomUUID();
      await db.client.orm.public.Order.create({
        id: thirdOrder,
        userId: testUserId,
        zoneId: testZoneId,
        deliveryAddress: 'Calle Sucre 789',
        status: 'PENDING',
        total: 50.0,
        subtotalCents: 5000n,
      });

      // Mismatched total (5000 + 750 != 6000)
      await expect(
        db.client.orm.public.PurchaseReceipt.create({
          id: randomUUID(),
          orderId: thirdOrder,
          number: `CMP-RG-2026-${randomUUID().slice(0, 6)}`,
          commercialOrderNumber: `RG-2026-${randomUUID().slice(0, 6)}`,
          buyerId: testUserId,
          subtotalCents: 5000n,
          taxEnabled: true,
          taxRateBps: 1500,
          taxAmountCents: 750n,
          totalCents: 6000n, // Inconsistent total!
          snapshot: {},
        }),
      ).rejects.toThrow(/purchase_receipt_valid/i);
    });

    it('enforces paymentAttempt money snapshots and mathematical invariants', async () => {
      // Mismatched amountCents != totalCents
      await expect(
        db.client.orm.public.PaymentAttempt.create({
          id: randomUUID(),
          orderId: testOrderId,
          buyerId: testUserId,
          cardFixtureId: 'DEMO_APPROVED',
          amountCents: 5000n, // Mismatched: totalCents is 5750n
          subtotalCents: 5000n,
          taxEnabled: true,
          taxRateBps: 1500,
          taxAmountCents: 750n,
          shippingAmountCents: 0,
          totalCents: 5750n,
          cardLast4: '0001',
          reference: `PAY-DEMO-${randomUUID().slice(0, 8)}`,
        }),
      ).rejects.toThrow(/payment_attempt_valid/i);

      // Mismatched totalCents != subtotalCents + taxAmountCents
      await expect(
        db.client.orm.public.PaymentAttempt.create({
          id: randomUUID(),
          orderId: testOrderId,
          buyerId: testUserId,
          cardFixtureId: 'DEMO_APPROVED',
          amountCents: 6000n,
          subtotalCents: 5000n,
          taxEnabled: true,
          taxRateBps: 1500,
          taxAmountCents: 750n,
          shippingAmountCents: 0,
          totalCents: 6000n, // Inconsistent total: 5000 + 750 != 6000
          cardLast4: '0001',
          reference: `PAY-DEMO-${randomUUID().slice(0, 8)}`,
        }),
      ).rejects.toThrow(/payment_attempt_valid/i);

      // Disabled tax with non-zero taxAmountCents
      await expect(
        db.client.orm.public.PaymentAttempt.create({
          id: randomUUID(),
          orderId: testOrderId,
          buyerId: testUserId,
          cardFixtureId: 'DEMO_APPROVED',
          amountCents: 5750n,
          subtotalCents: 5000n,
          taxEnabled: false, // Tax disabled!
          taxRateBps: 1500,
          taxAmountCents: 750n, // Must be 0 when tax is disabled
          shippingAmountCents: 0,
          totalCents: 5750n,
          cardLast4: '0001',
          reference: `PAY-DEMO-${randomUUID().slice(0, 8)}`,
        }),
      ).rejects.toThrow(/payment_attempt_valid/i);

      // Non-zero shipping amount
      await expect(
        db.client.orm.public.PaymentAttempt.create({
          id: randomUUID(),
          orderId: testOrderId,
          buyerId: testUserId,
          cardFixtureId: 'DEMO_APPROVED',
          amountCents: 5750n,
          subtotalCents: 5000n,
          taxEnabled: true,
          taxRateBps: 1500,
          taxAmountCents: 750n,
          shippingAmountCents: 500, // Illegal: shipping must be 0
          totalCents: 5750n,
          cardLast4: '0001',
          reference: `PAY-DEMO-${randomUUID().slice(0, 8)}`,
        }),
      ).rejects.toThrow(/payment_attempt_valid/i);

      // Valid paymentAttempt succeeds
      const validPayment = await db.client.orm.public.PaymentAttempt.create({
        id: randomUUID(),
        orderId: testOrderId,
        buyerId: testUserId,
        cardFixtureId: 'DEMO_APPROVED',
        amountCents: 5750n,
        subtotalCents: 5000n,
        taxEnabled: true,
        taxRateBps: 1500,
        taxAmountCents: 750n,
        shippingAmountCents: 0,
        totalCents: 5750n,
        cardLast4: '0001',
        reference: `PAY-DEMO-${randomUUID().slice(0, 8)}`,
      });
      expect(validPayment).toBeDefined();
      expect(validPayment.subtotalCents).toBe(5000n);
      expect(validPayment.taxAmountCents).toBe(750n);
      expect(validPayment.totalCents).toBe(5750n);
      expect(validPayment.amountCents).toBe(5750n);
      expect(validPayment.shippingAmountCents).toBe(0);
    });

    it('enforces checkoutAttempt status and link consistency constraint', async () => {
      // 1. PROCESSING tests
      // PROCESSING must not allow orderId/receiptId/paymentAttemptId, errorCode, or successSnapshot
      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: randomUUID(),
          userId: testUserId,
          idempotencyKey: `idemp-proc-order-${randomUUID()}`,
          requestHash: 'hash-xyz',
          status: 'PROCESSING',
          orderId: testOrderId, // Illegal for PROCESSING
        }),
      ).rejects.toThrow(/checkout_attempt_status_consistency/i);

      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: randomUUID(),
          userId: testUserId,
          idempotencyKey: `idemp-proc-err-${randomUUID()}`,
          requestHash: 'hash-xyz',
          status: 'PROCESSING',
          errorCode: 'CARD_INVALID', // Illegal for PROCESSING
        }),
      ).rejects.toThrow(/checkout_attempt_status_consistency/i);

      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: randomUUID(),
          userId: testUserId,
          idempotencyKey: `idemp-proc-snap-${randomUUID()}`,
          requestHash: 'hash-xyz',
          status: 'PROCESSING',
          successSnapshot: { order: { id: testOrderId } }, // Illegal for PROCESSING
        }),
      ).rejects.toThrow(/checkout_attempt_status_consistency/i);

      // Valid PROCESSING attempt succeeds
      const validProcessing = await db.client.orm.public.CheckoutAttempt.create({
        id: randomUUID(),
        userId: testUserId,
        idempotencyKey: `idemp-valid-proc-${randomUUID()}`,
        requestHash: 'hash-xyz',
        status: 'PROCESSING',
      });
      expect(validProcessing.status).toBe('PROCESSING');
      expect(validProcessing.orderId).toBeNull();
      expect(validProcessing.errorCode).toBeNull();
      expect(validProcessing.successSnapshot).toBeNull();

      // 2. SUCCEEDED tests
      // Set up secondary order, payment, receipt for valid SUCCEEDED test
      const succeededOrderId = randomUUID();
      await db.client.orm.public.Order.create({
        id: succeededOrderId,
        userId: testUserId,
        zoneId: testZoneId,
        deliveryAddress: 'Av. Guayaquil 101',
        status: 'PENDING',
        total: 50.0,
        subtotalCents: 5000n,
      });

      const paymentAttemptId = randomUUID();
      await db.client.orm.public.PaymentAttempt.create({
        id: paymentAttemptId,
        orderId: succeededOrderId,
        buyerId: testUserId,
        cardFixtureId: 'DEMO_APPROVED',
        amountCents: 5750n,
        subtotalCents: 5000n,
        taxEnabled: true,
        taxRateBps: 1500,
        taxAmountCents: 750n,
        shippingAmountCents: 0,
        totalCents: 5750n,
        cardLast4: '0001',
        reference: `PAY-DEMO-${randomUUID().slice(0, 8)}`,
      });

      const receiptId = randomUUID();
      await db.client.orm.public.PurchaseReceipt.create({
        id: receiptId,
        orderId: succeededOrderId,
        number: `CMP-RG-2026-${randomUUID().slice(0, 6)}`,
        commercialOrderNumber: `RG-2026-${randomUUID().slice(0, 6)}`,
        buyerId: testUserId,
        subtotalCents: 5000n,
        taxEnabled: true,
        taxRateBps: 1500,
        taxAmountCents: 750n,
        totalCents: 5750n,
        snapshot: { items: [], delivery: {} },
      });

      // SUCCEEDED without links rejected
      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: randomUUID(),
          userId: testUserId,
          idempotencyKey: `idemp-succ-nolinks-${randomUUID()}`,
          requestHash: 'hash-xyz',
          status: 'SUCCEEDED',
          orderId: null,
          receiptId: null,
          paymentAttemptId: null,
          successSnapshot: { order: { id: succeededOrderId } },
        }),
      ).rejects.toThrow(/checkout_attempt_status_consistency/i);

      // SUCCEEDED without successSnapshot (SQL null) rejected
      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: randomUUID(),
          userId: testUserId,
          idempotencyKey: `idemp-succ-nosnap-${randomUUID()}`,
          requestHash: 'hash-xyz',
          status: 'SUCCEEDED',
          orderId: succeededOrderId,
          receiptId,
          paymentAttemptId,
          successSnapshot: null, // Illegal for SUCCEEDED
        }),
      ).rejects.toThrow(/checkout_attempt_status_consistency/i);

      // SUCCEEDED with errorCode rejected
      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: randomUUID(),
          userId: testUserId,
          idempotencyKey: `idemp-succ-err-${randomUUID()}`,
          requestHash: 'hash-xyz',
          status: 'SUCCEEDED',
          orderId: succeededOrderId,
          receiptId,
          paymentAttemptId,
          errorCode: 'SOME_ERROR', // Illegal for SUCCEEDED
          successSnapshot: { order: { id: succeededOrderId } },
        }),
      ).rejects.toThrow(/checkout_attempt_status_consistency/i);

      // Valid SUCCEEDED attempt succeeds
      const validSucceeded = await db.client.orm.public.CheckoutAttempt.create({
        id: randomUUID(),
        userId: testUserId,
        idempotencyKey: `idemp-valid-succ-${randomUUID()}`,
        requestHash: 'hash-xyz',
        status: 'SUCCEEDED',
        orderId: succeededOrderId,
        receiptId,
        paymentAttemptId,
        successSnapshot: {
          order: { id: succeededOrderId, totalCents: 5750 },
          payment: { id: paymentAttemptId, amountCents: 5750 },
          receipt: { id: receiptId },
        },
      });
      expect(validSucceeded.status).toBe('SUCCEEDED');
      expect(validSucceeded.orderId).toBe(succeededOrderId);
      expect(validSucceeded.receiptId).toBe(receiptId);
      expect(validSucceeded.paymentAttemptId).toBe(paymentAttemptId);
      expect(validSucceeded.successSnapshot).toBeDefined();

      // 3. REJECTED and FAILED tests
      // REJECTED status must have non-null errorCode and null orderId
      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: randomUUID(),
          userId: testUserId,
          idempotencyKey: `idemp-rejected-order-${randomUUID()}`,
          requestHash: 'hash-xyz',
          status: 'REJECTED',
          orderId: testOrderId, // Illegal for REJECTED
          errorCode: 'CARD_INVALID',
        }),
      ).rejects.toThrow(/checkout_attempt_status_consistency/i);

      // REJECTED must not allow successSnapshot
      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: randomUUID(),
          userId: testUserId,
          idempotencyKey: `idemp-rej-snap-${randomUUID()}`,
          requestHash: 'hash-xyz',
          status: 'REJECTED',
          errorCode: 'CARD_INVALID',
          successSnapshot: { order: { id: testOrderId } }, // Illegal for REJECTED
        }),
      ).rejects.toThrow(/checkout_attempt_status_consistency/i);

      // FAILED status must have non-null errorCode and null orderId/receiptId/paymentAttemptId/successSnapshot
      await expect(
        db.client.orm.public.CheckoutAttempt.create({
          id: randomUUID(),
          userId: testUserId,
          idempotencyKey: `idemp-failed-order-${randomUUID()}`,
          requestHash: 'hash-xyz',
          status: 'FAILED',
          orderId: testOrderId, // Illegal for FAILED
          errorCode: 'SYSTEM_ERROR',
        }),
      ).rejects.toThrow(/checkout_attempt_status_consistency/i);

      // Valid REJECTED attempt succeeds
      const validRejected = await db.client.orm.public.CheckoutAttempt.create({
        id: randomUUID(),
        userId: testUserId,
        idempotencyKey: `idemp-valid-rejected-${randomUUID()}`,
        requestHash: 'hash-xyz',
        status: 'REJECTED',
        errorCode: 'CARD_INVALID',
        errorMessage: 'Los datos de la tarjeta son inválidos',
      });
      expect(validRejected.status).toBe('REJECTED');
      expect(validRejected.errorCode).toBe('CARD_INVALID');

      // Valid FAILED attempt succeeds
      const validFailed = await db.client.orm.public.CheckoutAttempt.create({
        id: randomUUID(),
        userId: testUserId,
        idempotencyKey: `idemp-valid-failed-${randomUUID()}`,
        requestHash: 'hash-xyz',
        status: 'FAILED',
        errorCode: 'PROCESSING_TIMEOUT',
        errorMessage: 'El procesamiento de la solicitud expiró',
      });
      expect(validFailed.status).toBe('FAILED');
      expect(validFailed.errorCode).toBe('PROCESSING_TIMEOUT');
    });
  });

  describe('Legacy Compatibility Preserved', () => {
    it('Order model retains existing columns and relations without default leaks', async () => {
      const fetchedOrder = await db.client.orm.public.Order.where({ id: testOrderId }).first();
      expect(fetchedOrder).toBeDefined();
      expect(fetchedOrder.total).toBe(50.0);
      expect(fetchedOrder.subtotalCents).toBe(5000n);
      // Ensure no new scalar columns on Order
      expect(fetchedOrder).not.toHaveProperty('paymentStatus');
      expect(fetchedOrder).not.toHaveProperty('receiptNumber');
    });
  });
});
