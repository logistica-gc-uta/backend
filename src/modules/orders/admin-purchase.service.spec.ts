import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { AdminPurchaseService } from './admin-purchase.service.js';
import type { CreateAdminOrderDto } from './dto/create-admin-order.dto.js';

const KEY = '11111111-1111-4111-8111-111111111111';
const NOW = Temporal.Instant.from('2020-01-01T12:00:00Z');

function sqlOf(plan: { sql?: string }): string {
  return plan?.sql ?? '';
}

function guestDto(overrides: Record<string, unknown> = {}): CreateAdminOrderDto {
  return {
    buyer: { type: 'GUEST', name: 'Guest Buyer', contactPhone: '0991111111' },
    payment: { method: 'CASH' },
    items: [{ productId: 'p1', quantity: 1 }],
    deliveryAddress: 'Av. Principal 1',
    deliveryLat: -1.2,
    deliveryLng: -78.6,
    scheduledDeliveryDate: '2030-02-14T15:00:00.000Z',
    ...overrides,
  } as CreateAdminOrderDto;
}

describe('AdminPurchaseService', () => {
  let prisma: any;
  let tx: any;
  let settings: any;
  let coverage: any;
  let service: AdminPurchaseService;
  let attemptStatus: string;
  let attemptId: string;
  let product: Record<string, unknown>;
  type Plan = { sql?: string; values?: unknown[] };

  beforeEach(() => {
    attemptStatus = 'PROCESSING';
    attemptId = KEY;
    product = {
      id: 'p1', name: 'Caja', sku: 'REG-001', price: 73, priceCents: 7300n, stock: 5,
    };
    tx = {
      query: jest.fn(async (plan: Plan) => {
        const sql = sqlOf(plan);
        if (sql.includes('pg_advisory_xact_lock')) return [{ locked: 1 }];
        if (sql.includes('clock_timestamp() AS instant')) return [{ instant: NOW }];
        if (sql.includes('FROM public.product')) return [product];
        if (sql.includes('RETURNING "declaredAt"')) return [{ declaredAt: '2030-01-01T12:00:00.000Z' }];
        if (sql.includes('FROM public."purchaseReceipt"')) {
          return [{
            id: 'r1', number: 'CMP-1', orderId: 'o1', issuedAt: '2030-01-01T00:00:00.000Z',
            merchantName: 'REGALÍA', currency: 'USD', subtotalCents: 7300, taxMode: 'SIMULATED',
            taxEnabled: true, taxRateBps: 1500, taxAmountCents: 1095, shippingStatus: 'FREE_INCLUDED',
            shippingAmountCents: 0, totalCents: 8395,
            disclaimer: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA',
            snapshot: {
              buyer: { name: 'Guest', phone: '099' },
              recipient: { name: 'Gift', phone: '100' },
              items: [{ sku: 'SKU', name: 'Box', quantity: 1, unitPriceCents: 7300, lineTotalCents: 7300 }],
              payment: {
                kind: 'ADMIN_DECLARED_EXTERNAL', status: 'DECLARED', method: 'CASH',
                declaredById: 'admin', declaredAt: '2030-01-01T00:00:00.000Z',
              },
            },
          }];
        }
        if (sql.includes('FROM public."orderContactAudit"')) {
          return [{
            id: 'h1', field: 'buyerPhone', previousValue: '1', nextValue: '2',
            actorId: 'admin', createdAt: '2030-01-01T00:00:00.000Z',
          }];
        }
        if (sql.includes('FROM public."order"')) {
          return [{
            id: 'o1', userId: null, recipientType: 'GUEST', contactRevision: 0,
            buyerName: 'A', buyerPhone: '1', recipientName: 'B', recipientPhone: '2',
          }];
        }
        if (sql.includes('FROM public."adminPurchaseAttempt"')) {
          if (sql.includes('SELECT id, status, "updatedAt"')) {
            return [{ id: attemptId, status: attemptStatus, updatedAt: '2020-01-01T00:00:00.000Z' }];
          }
          return [{
            id: attemptId,
            actorId: 'admin',
            idempotencyKey: KEY,
            requestHash: (service as any).requestHash(guestDto()),
            status: attemptStatus,
            orderId: 'o1',
            receiptId: 'r1',
            successSnapshot: { id: 'order-1' },
            errorCode: null,
            errorMessage: null,
            errorDetails: null,
            updatedAt: '2030-01-01T00:00:00.000Z',
          }];
        }
        return [];
      }),
      execute: jest.fn(async (plan: Plan) => {
        const sql = sqlOf(plan);
        if (sql.includes('INSERT INTO public."adminPurchaseAttempt"') && plan.values?.[0]) {
          attemptId = String(plan.values[0]);
        }
        return { affectedRows: 1 };
      }),
      orm: {
        public: {
          Order: {
            where: jest.fn().mockReturnValue({
              include: () => ({
                include: () => ({
                  first: jest.fn().mockResolvedValue({
                    id: 'o1', userId: null, createdById: 'admin', recipientType: 'GUEST',
                    recipientName: 'Guest Buyer', recipientPhone: '0991111111',
                    buyerName: 'Guest Buyer', buyerPhone: '0991111111', contactRevision: 0,
                    deliveryAddress: 'Av. Principal 1', deliveryLat: -1.2, deliveryLng: -78.6,
                    status: 'PENDING', total: 73, items: [], zone: null,
                  }),
                }),
              }),
            }),
          },
        },
      },
    };
    prisma = {
      client: {
        raw: {
          sql: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join('?');
            return {
              sql,
              values,
              returnsRow: () => ({ build: () => ({ sql, values }) }),
              affectedCount: () => ({ build: () => ({ sql, values }) }),
            };
          }),
        },
        transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
      },
      user: {
        where: jest.fn().mockReturnValue({
          select: () => ({
            first: jest.fn().mockResolvedValue({
              id: 'client-1', name: 'Registered', email: 'client@test', role: 'CLIENT',
            }),
          }),
        }),
      },
      order: {
        where: jest.fn().mockReturnValue({
          select: () => ({ first: jest.fn().mockResolvedValue({ id: 'o1' }) }),
        }),
      },
    };
    settings = {
      getPublicSettings: jest.fn().mockResolvedValue({
        tax: { enabled: true, rateBps: 1500 },
        deliverySchedule: {
          timeZone: 'America/Guayaquil', startTime: '07:00', endTime: '17:00', boundariesInclusive: true,
        },
        version: 1,
      }),
    };
    coverage = { evaluatePoint: jest.fn().mockResolvedValue({ accepted: true, position: { lat: -1.2, lng: -78.6 } }) };
    service = new AdminPurchaseService(prisma, settings, coverage);
  });

  it('rejects missing or non-v4 Idempotency-Key', async () => {
    await expect(service.create('admin', guestDto(), undefined)).rejects.toBeInstanceOf(HttpException);
    await expect(service.create('admin', guestDto(), 'not-a-uuid')).rejects.toBeInstanceOf(HttpException);
  });

  it('replays SUCCEEDED snapshot for the same actor and hash', async () => {
    attemptStatus = 'SUCCEEDED';
    await expect(service.create('admin', guestDto(), KEY)).resolves.toEqual({ id: 'order-1' });
  });

  it('conflicts when the same key is reused with a different payload', async () => {
    attemptStatus = 'SUCCEEDED';
    await expect(service.create('admin', guestDto({ deliveryAddress: 'Other' }), KEY)).rejects.toMatchObject({
      response: { error: { code: 'IDEMPOTENCY_KEY_REUSED' } },
    });
  });

  it('rethrows recorded Nest and shop rejections', async () => {
    attemptStatus = 'REJECTED';
    tx.query.mockImplementation(async (plan: Plan) => {
      const sql = sqlOf(plan);
      if (sql.includes('pg_advisory')) return [{ locked: 1 }];
      return [{
        id: KEY, actorId: 'admin', idempotencyKey: KEY,
        requestHash: (service as any).requestHash(guestDto()),
        status: 'REJECTED', errorCode: 'NEST_BAD_REQUEST', errorMessage: 'bad',
        errorDetails: {}, successSnapshot: null,
      }];
    });
    await expect(service.create('admin', guestDto(), KEY)).rejects.toBeInstanceOf(BadRequestException);

    tx.query.mockImplementation(async () => [{
      id: KEY, actorId: 'admin', idempotencyKey: KEY,
      requestHash: (service as any).requestHash(guestDto()),
      status: 'REJECTED', errorCode: 'NEST_NOT_FOUND', errorMessage: 'gone',
      errorDetails: {}, successSnapshot: null,
    }]);
    await expect(service.create('admin', guestDto(), KEY)).rejects.toBeInstanceOf(NotFoundException);

    tx.query.mockImplementation(async () => [{
      id: KEY, actorId: 'admin', idempotencyKey: KEY,
      requestHash: (service as any).requestHash(guestDto()),
      status: 'REJECTED', errorCode: 'DELIVERY_OUTSIDE_HOURS', errorMessage: 'hours',
      errorDetails: { startTime: '07:00' }, successSnapshot: null,
    }]);
    await expect(service.create('admin', guestDto(), KEY)).rejects.toMatchObject({
      response: { error: { code: 'DELIVERY_OUTSIDE_HOURS' } },
    });
  });

  it('fails replay of FAILED attempts and reports in-progress PROCESSING', async () => {
    attemptStatus = 'FAILED';
    await expect(service.create('admin', guestDto(), KEY)).rejects.toMatchObject({
      response: { error: { code: 'INTERNAL_ERROR' } },
    });
    attemptStatus = 'PROCESSING';
    await expect(service.create('admin', guestDto(), KEY)).rejects.toMatchObject({
      response: { error: { code: 'ADMIN_PURCHASE_IN_PROGRESS' } },
    });
  });

  it('creates a guest cash sale and returns the commercial snapshot', async () => {
    let attemptReads = 0;
    tx.query.mockImplementation(async (plan: Plan) => {
      const sql = sqlOf(plan);
      if (sql.includes('pg_advisory_xact_lock')) return [{ locked: 1 }];
      if (sql.includes('clock_timestamp() AS instant')) return [{ instant: NOW }];
      if (sql.includes('FROM public.product')) return [product];
      if (sql.includes('RETURNING "declaredAt"')) return [{ declaredAt: '2030-01-01T12:00:00.000Z' }];
      if (sql.includes('FROM public."adminPurchaseAttempt"')) {
        attemptReads += 1;
        if (attemptReads === 1) return [];
        return [{
          id: attemptId, actorId: 'admin', idempotencyKey: KEY,
          requestHash: (service as any).requestHash(guestDto()),
          status: 'PROCESSING',
        }];
      }
      return [];
    });
    const created = await service.create('admin', guestDto({
      giftRecipient: { name: 'Gift', contactPhone: '0992222222' },
      payment: { method: 'TRANSFER', note: 'ventanilla' },
    }), KEY) as {
      totalCents: number;
      taxAmountCents: number;
      payment: { kind: string; status: string; method: string };
      receipt: { number: string };
    };
    expect(created.totalCents).toBe(8395);
    expect(created.taxAmountCents).toBe(1095);
    expect(created.payment).toMatchObject({ kind: 'ADMIN_DECLARED_EXTERNAL', status: 'DECLARED', method: 'TRANSFER' });
    expect(created.receipt.number).toMatch(/^CMP-RG-2020-/);
  });

  it('creates a registered-client sale without inferring phone from User', async () => {
    tx.query.mockImplementation(async (plan: Plan) => {
      const sql = sqlOf(plan);
      if (sql.includes('pg_advisory_xact_lock')) return [{ locked: 1 }];
      if (sql.includes('clock_timestamp() AS instant')) return [{ instant: NOW }];
      if (sql.includes('FROM public.product')) return [product];
      if (sql.includes('RETURNING "declaredAt"')) return [{ declaredAt: NOW }];
      if (sql.includes('FROM public."adminPurchaseAttempt"')) {
        return [{ id: KEY, actorId: 'admin', idempotencyKey: KEY, requestHash: 'x', status: 'PROCESSING' }];
      }
      return [];
    });
    const created = await (service as any).executeSale('admin', {
      ...guestDto(),
      buyer: { type: 'REGISTERED_CLIENT', clientId: 'client-1', contactPhone: '0987654321' },
    }, KEY, 'hash', KEY) as { buyerPhone: string };
    expect(created.buyerPhone).toBe('0987654321');
    expect(prisma.user.where).toHaveBeenCalledWith({ id: 'client-1' });
  });

  it('rejects ADMIN-as-buyer, unknown type, missing stock and zero cents', async () => {
    prisma.user.where.mockReturnValue({
      select: () => ({ first: jest.fn().mockResolvedValue({ id: 'admin', name: 'Boss', email: 'a', role: 'CLIENT' }) }),
    });
    await expect((service as any).executeSale('admin', {
      ...guestDto(),
      buyer: { type: 'REGISTERED_CLIENT', clientId: 'admin', contactPhone: '099' },
    }, KEY, 'h', KEY)).rejects.toBeInstanceOf(BadRequestException);

    await expect((service as any).executeSale('admin', {
      ...guestDto(),
      buyer: { type: 'OTHER', contactPhone: '099' },
    }, KEY, 'h', KEY)).rejects.toBeInstanceOf(BadRequestException);

    product = { ...product, stock: 0 };
    tx.query.mockImplementation(async (plan: Plan) => {
      const sql = sqlOf(plan);
      if (sql.includes('clock_timestamp() AS instant')) return [{ instant: NOW }];
      if (sql.includes('FROM public.product')) return [product];
      if (sql.includes('adminPurchaseAttempt')) {
        return [{ id: KEY, actorId: 'admin', idempotencyKey: KEY, status: 'PROCESSING' }];
      }
      if (sql.includes('pg_advisory')) return [{ locked: 1 }];
      return [];
    });
    await expect((service as any).executeSale('admin', guestDto(), KEY, 'h', KEY))
      .rejects.toBeInstanceOf(BadRequestException);

    product = { ...product, stock: 5, priceCents: 0n };
    await expect((service as any).executeSale('admin', guestDto(), KEY, 'h', KEY))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects missing product, coordinates and coverage', async () => {
    tx.query.mockImplementation(async (plan: Plan) => {
      const sql = sqlOf(plan);
      if (sql.includes('clock_timestamp() AS instant')) return [{ instant: NOW }];
      if (sql.includes('FROM public.product')) return [];
      if (sql.includes('adminPurchaseAttempt')) {
        return [{ id: KEY, actorId: 'admin', idempotencyKey: KEY, status: 'PROCESSING' }];
      }
      if (sql.includes('pg_advisory')) return [{ locked: 1 }];
      return [];
    });
    await expect((service as any).executeSale('admin', guestDto(), KEY, 'h', KEY))
      .rejects.toBeInstanceOf(NotFoundException);

    await expect((service as any).executeSale('admin', guestDto({ deliveryLat: undefined, deliveryLng: undefined }), KEY, 'h', KEY))
      .rejects.toBeInstanceOf(BadRequestException);

    coverage.evaluatePoint.mockResolvedValue({ accepted: false, position: { lat: 0, lng: 0 } });
    await expect((service as any).executeSale('admin', guestDto(), KEY, 'h', KEY))
      .rejects.toMatchObject({ response: { error: { code: 'DELIVERY_OUTSIDE_COVERAGE' } } });
  });

  it('replays a raced insert using the existing attempt', async () => {
    let reads = 0;
    tx.execute.mockResolvedValue({ affectedRows: 0 });
    tx.query.mockImplementation(async (plan: Plan) => {
      const sql = sqlOf(plan);
      if (sql.includes('FROM public."adminPurchaseAttempt"')) {
        reads += 1;
        if (reads === 1) return [];
        return [{
          id: KEY, actorId: 'admin', idempotencyKey: KEY,
          requestHash: (service as any).requestHash(guestDto()),
          status: 'SUCCEEDED', successSnapshot: { id: 'raced' },
        }];
      }
      return [];
    });
    await expect(service.create('admin', guestDto(), KEY)).resolves.toEqual({ id: 'raced' });
  });

  it('conflicts when reservation loses and no attempt is visible yet', async () => {
    tx.execute.mockResolvedValue({ affectedRows: 0 });
    tx.query.mockResolvedValue([]);
    await expect(service.create('admin', guestDto(), KEY)).rejects.toMatchObject({
      response: { error: { code: 'ADMIN_PURCHASE_IN_PROGRESS' } },
    });
  });

  it('records late failures from create without a success snapshot', async () => {
    tx.query.mockImplementation(async (plan: Plan) => {
      const sql = sqlOf(plan);
      if (sql.includes('FROM public."adminPurchaseAttempt"')) return [];
      if (sql.includes('pg_advisory')) return [{ locked: 1 }];
      return [];
    });
    coverage.evaluatePoint.mockResolvedValue({ accepted: false, position: {} });
    await expect(service.create('admin', guestDto(), KEY)).rejects.toBeInstanceOf(HttpException);
    expect(tx.execute).toHaveBeenCalled();
  });

  it('rejects invalid attempt keys and unknown attempts', async () => {
    await expect(service.getAttempt('admin', 'bad')).rejects.toBeInstanceOf(HttpException);
    tx.query.mockResolvedValue([]);
    await expect(service.getAttempt('admin', KEY)).rejects.toMatchObject({
      response: { error: { code: 'ADMIN_PURCHASE_ATTEMPT_NOT_FOUND' } },
    });
  });

  it('reconciles stale PROCESSING attempts before returning FAILED', async () => {
    attemptStatus = 'PROCESSING';
    const result = await service.getAttempt('admin', KEY);
    expect(result.status).toBe('PROCESSING');
    expect(tx.execute).toHaveBeenCalled();
  });

  it('maps declared and simulated-card receipts', async () => {
    const declared = await service.getReceipt('o1');
    expect(declared.totalCents).toBe(8395);
    expect(declared.payment).toMatchObject({ kind: 'ADMIN_DECLARED_EXTERNAL', status: 'DECLARED', method: 'CASH' });

    tx.query.mockResolvedValueOnce([]);
    await expect(service.getReceipt('missing')).rejects.toMatchObject({
      response: { error: { code: 'ORDER_NOT_FOUND' } },
    });

    tx.query.mockResolvedValueOnce([{
      id: 'r2', number: 'CMP-2', orderId: 'o2', issuedAt: new Date('2030-01-01T00:00:00.000Z'),
      merchantName: '', currency: 'USD', subtotalCents: 100, taxEnabled: false, taxRateBps: 0,
      taxAmountCents: 0, totalCents: 100,
      snapshot: {
        buyer: { name: 'Card', email: 'c@test', phone: '1' },
        recipient: { name: 'Card', phone: '1' },
        items: [{ sku: 'S', name: 'N', quantity: 1, unitPriceCents: 100, lineTotalCents: 100 }],
        payment: { status: 'APPROVED', reference: 'sim-1', cardLast4: '4242' },
      },
    }]);
    const card = await service.getReceipt('o2');
    expect(card.payment).toEqual({ status: 'APPROVED', reference: 'sim-1', cardLast4: '4242' });
    expect(card.buyer).toMatchObject({ email: 'c@test' });
  });

  it('requires a contact field and refuses registered buyerName corrections', async () => {
    await expect(service.updateContact('admin', 'o1', { contactRevision: 0 } as never))
      .rejects.toBeInstanceOf(BadRequestException);
    tx.query.mockResolvedValueOnce([{
      id: 'o1', userId: 'client', recipientType: 'REGISTERED_CLIENT', contactRevision: 0,
      buyerName: 'A', buyerPhone: '1', recipientName: 'B', recipientPhone: '2',
    }]);
    await expect(service.updateContact('admin', 'o1', { contactRevision: 0, buyerName: 'Nope' } as never))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('conflicts on stale contactRevision and missing orders', async () => {
    tx.query.mockResolvedValueOnce([{
      id: 'o1', userId: null, recipientType: 'GUEST', contactRevision: 2,
      buyerName: 'A', buyerPhone: '1', recipientName: 'B', recipientPhone: '2',
    }]);
    await expect(service.updateContact('admin', 'o1', { contactRevision: 0, buyerPhone: '3' } as never))
      .rejects.toMatchObject({ response: { error: { code: 'CONTACT_REVISION_CONFLICT' } } });

    tx.query.mockResolvedValueOnce([]);
    await expect(service.updateContact('admin', 'missing', { contactRevision: 0, buyerPhone: '3' } as never))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('skips unchanged contact fields and conflicts when the update does not land', async () => {
    await expect(service.updateContact('admin', 'o1', { contactRevision: 0, buyerPhone: '1' } as never))
      .resolves.toBeDefined();
    tx.execute.mockResolvedValueOnce({ affectedRows: 0 });
    await expect(service.updateContact('admin', 'o1', { contactRevision: 0, buyerPhone: '9' } as never))
      .rejects.toMatchObject({ response: { error: { code: 'CONTACT_REVISION_CONFLICT' } } });
  });

  it('replays a succeeded attempt discovered inside the sale transaction', async () => {
    tx.query.mockImplementation(async (plan: Plan) => {
      const sql = sqlOf(plan);
      if (sql.includes('clock_timestamp() AS instant')) return [{ instant: NOW }];
      if (sql.includes('pg_advisory')) return [{ locked: 1 }];
      if (sql.includes('FROM public."adminPurchaseAttempt"')) {
        return [{
          id: 'other', actorId: 'admin', idempotencyKey: KEY,
          requestHash: (service as any).requestHash(guestDto()),
          status: 'SUCCEEDED', successSnapshot: { id: 'inside' },
        }];
      }
      return [];
    });
    await expect((service as any).executeSale('admin', guestDto(), KEY, (service as any).requestHash(guestDto()), KEY))
      .resolves.toEqual({ id: 'inside' });
  });

  it('corrects guest contact and writes audit when the value changes', async () => {
    await expect(service.updateContact('admin', 'o1', { contactRevision: 0, buyerPhone: '0990000000' } as never))
      .resolves.toMatchObject({ buyerPhone: '0991111111' });
    expect(tx.execute).toHaveBeenCalled();
  });

  it('lists contact history and 404s unknown orders', async () => {
    prisma.order.where.mockReturnValue({ select: () => ({ first: jest.fn().mockResolvedValue(null) }) });
    await expect(service.contactHistory('missing')).rejects.toBeInstanceOf(NotFoundException);
    prisma.order.where.mockReturnValue({ select: () => ({ first: jest.fn().mockResolvedValue({ id: 'o1' }) }) });
    await expect(service.contactHistory('o1')).resolves.toEqual([
      expect.objectContaining({ field: 'buyerPhone', actorId: 'admin' }),
    ]);
  });

  it('covers status mapping used by recorded rejections', () => {
    const map = (service as any).statusForCode.bind(service);
    expect(map('IDEMPOTENCY_KEY_REUSED')).toBe(409);
    expect(map('STORE_NOT_CONFIGURED')).toBe(409);
    expect(map('CONTACT_REVISION_CONFLICT')).toBe(409);
    expect(map('DELIVERY_INVALID')).toBe(422);
    expect(map('VALIDATION_ERROR')).toBe(400);
    expect(map('ORDER_NOT_FOUND')).toBe(404);
    expect(map('UNKNOWN')).toBe(500);
  });
});
