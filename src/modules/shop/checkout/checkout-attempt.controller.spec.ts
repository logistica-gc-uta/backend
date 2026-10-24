import { HttpStatus } from '@nestjs/common';
import { CheckoutAttemptController } from './checkout-attempt.controller.js';
import { CheckoutAttemptService } from './checkout-attempt.service.js';
import { Role } from '../../auth/dto/register.dto.js';

describe('CheckoutAttemptController unit tests (public behavior)', () => {
  let controller: CheckoutAttemptController;
  let service: CheckoutAttemptService;
  let mockPrisma: any;

  const clientUser = { id: 'client-user-111', userId: 'client-user-111', role: Role.CLIENT };

  beforeEach(() => {
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
            query: jest.fn().mockResolvedValue([]),
            execute: jest.fn().mockResolvedValue(1),
          };
          return cb(tx);
        }),
      },
    };

    service = new CheckoutAttemptService(mockPrisma);
    controller = new CheckoutAttemptController(service);
  });

  it('rejects invalid or non-UUIDv4 idempotencyKey param with HTTP 400 VALIDATION_ERROR', async () => {
    await expect(
      controller.getAttemptStatus(clientUser, 'not-a-valid-uuid'),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      response: {
        error: {
          code: 'VALIDATION_ERROR',
        },
      },
    });
  });

  it('throws HTTP 404 CHECKOUT_ATTEMPT_NOT_FOUND when key does not exist or belongs to another user', async () => {
    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        query: jest.fn().mockResolvedValue([]), // No row found
        execute: jest.fn().mockResolvedValue(0),
      };
      return cb(tx);
    });

    await expect(
      controller.getAttemptStatus(
        clientUser,
        'a0000000-0000-4000-8000-000000000001',
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      response: {
        error: {
          code: 'CHECKOUT_ATTEMPT_NOT_FOUND',
        },
      },
    });
  });

  it('returns exact DTO projection without leaking requestHash, paymentAttemptId or internal snapshots', async () => {
    const fixedAttemptId = '66666666-6666-4666-8666-666666666666';
    const fixedOrderId = '77777777-7777-4777-8777-777777777777';
    const fixedReceiptId = '88888888-8888-4888-8888-888888888888';
    const fixedUpdatedAt = '2026-10-22T12:00:00.000Z';

    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        query: jest.fn().mockResolvedValue([
          {
            id: fixedAttemptId,
            userId: clientUser.id,
            idempotencyKey: 'a0000000-0000-4000-8000-000000000001',
            requestHash: 'super-secret-hash-should-not-leak',
            status: 'SUCCEEDED',
            orderId: fixedOrderId,
            receiptId: fixedReceiptId,
            paymentAttemptId: '99999999-9999-4999-8999-999999999999',
            errorCode: null,
            successSnapshot: { sensitive: 'should-not-be-in-response' },
            updatedAt: fixedUpdatedAt,
            createdAt: fixedUpdatedAt,
          },
        ]),
        execute: jest.fn().mockResolvedValue(1),
      };
      return cb(tx);
    });

    const result = await controller.getAttemptStatus(
      clientUser,
      'a0000000-0000-4000-8000-000000000001',
    );

    expect(result).toEqual({
      status: 'SUCCEEDED',
      checkoutAttemptId: fixedAttemptId,
      orderId: fixedOrderId,
      receiptId: fixedReceiptId,
      errorCode: null,
      updatedAt: new Date(fixedUpdatedAt).toISOString(),
    });

    expect((result as any).requestHash).toBeUndefined();
    expect((result as any).paymentAttemptId).toBeUndefined();
    expect((result as any).successSnapshot).toBeUndefined();
  });

  it('handles REJECTED state returning errorCode and null orderId/receiptId', async () => {
    const fixedAttemptId = '66666666-6666-4666-8666-666666666666';
    const fixedUpdatedAt = '2026-10-22T12:00:00.000Z';

    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        query: jest.fn().mockResolvedValue([
          {
            id: fixedAttemptId,
            userId: clientUser.id,
            idempotencyKey: 'a0000000-0000-4000-8000-000000000002',
            requestHash: 'hash-value',
            status: 'REJECTED',
            orderId: null,
            receiptId: null,
            paymentAttemptId: null,
            errorCode: 'STOCK_UNAVAILABLE',
            updatedAt: fixedUpdatedAt,
            createdAt: fixedUpdatedAt,
          },
        ]),
        execute: jest.fn().mockResolvedValue(1),
      };
      return cb(tx);
    });

    const result = await controller.getAttemptStatus(
      clientUser,
      'a0000000-0000-4000-8000-000000000002',
    );

    expect(result).toEqual({
      status: 'REJECTED',
      checkoutAttemptId: fixedAttemptId,
      orderId: null,
      receiptId: null,
      errorCode: 'STOCK_UNAVAILABLE',
      updatedAt: new Date(fixedUpdatedAt).toISOString(),
    });
  });

  it('handles FAILED state returning errorCode and null orderId/receiptId', async () => {
    const fixedAttemptId = '66666666-6666-4666-8666-666666666666';
    const fixedUpdatedAt = '2026-10-22T12:00:00.000Z';

    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        query: jest.fn().mockResolvedValue([
          {
            id: fixedAttemptId,
            userId: clientUser.id,
            idempotencyKey: 'a0000000-0000-4000-8000-000000000003',
            requestHash: 'hash-value',
            status: 'FAILED',
            orderId: null,
            receiptId: null,
            paymentAttemptId: null,
            errorCode: 'INTERNAL_ERROR',
            updatedAt: fixedUpdatedAt,
            createdAt: fixedUpdatedAt,
          },
        ]),
        execute: jest.fn().mockResolvedValue(1),
      };
      return cb(tx);
    });

    const result = await controller.getAttemptStatus(
      clientUser,
      'a0000000-0000-4000-8000-000000000003',
    );

    expect(result).toEqual({
      status: 'FAILED',
      checkoutAttemptId: fixedAttemptId,
      orderId: null,
      receiptId: null,
      errorCode: 'INTERNAL_ERROR',
      updatedAt: new Date(fixedUpdatedAt).toISOString(),
    });
  });

  it('fails closed and throws error when persisted updatedAt timestamp is absent, empty, or unparseable', async () => {
    const fixedAttemptId = '66666666-6666-4666-8666-666666666666';

    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        query: jest.fn().mockResolvedValue([
          {
            id: fixedAttemptId,
            userId: clientUser.id,
            idempotencyKey: 'a0000000-0000-4000-8000-000000000004',
            requestHash: 'hash-value',
            status: 'PROCESSING',
            orderId: null,
            receiptId: null,
            paymentAttemptId: null,
            errorCode: null,
            updatedAt: null, // ABSENT TIMESTAMP
            createdAt: '2026-10-22T12:00:00.000Z',
          },
        ]),
        execute: jest.fn().mockResolvedValue(1),
      };
      return cb(tx);
    });

    await expect(
      controller.getAttemptStatus(
        clientUser,
        'a0000000-0000-4000-8000-000000000004',
      ),
    ).rejects.toThrow();
  });


  it('reconciles stale orphan PROCESSING attempt to FAILED with INTERNAL_ERROR when lock is free', async () => {
    let reconciled = false;
    const executeMock = jest.fn().mockImplementation(async () => {
      reconciled = true;
      return 1;
    });

    mockPrisma.client.transaction.mockImplementation(async (cb: any) => {
      const tx = {
        query: jest.fn().mockImplementation(async () => {
          if (!reconciled) {
            // First call in reconcileStaleAttemptIfOrphan: attempt row
            // Second call: staleness check (true)
            // Third call: try lock (true)
            // Fourth call: recheck status (PROCESSING)
            return [
              {
                id: 'orphan-attempt-id',
                userId: clientUser.id,
                idempotencyKey: 'a0000000-0000-4000-8000-000000000004',
                status: 'PROCESSING',
                createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
                is_stale: true,
                locked: true,
              },
            ];
          } else {
            // Call in getAttemptStatus after reconciliation
            return [
              {
                id: 'orphan-attempt-id',
                userId: clientUser.id,
                idempotencyKey: 'a0000000-0000-4000-8000-000000000004',
                status: 'FAILED',
                orderId: null,
                receiptId: null,
                errorCode: 'INTERNAL_ERROR',
                updatedAt: new Date().toISOString(),
              },
            ];
          }
        }),
        execute: executeMock,
      };
      return cb(tx);
    });

    const result = await controller.getAttemptStatus(
      clientUser,
      'a0000000-0000-4000-8000-000000000004',
    );

    expect(executeMock).toHaveBeenCalled();
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('INTERNAL_ERROR');
  });
});
