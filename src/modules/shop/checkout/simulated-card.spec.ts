import { HttpStatus } from '@nestjs/common';
import { toInstant } from '../../../common/temporal.util.js';
import {
  assertPaymentSimulationEnabled,
  bootstrapSimulatedCards,
  SIMULATED_CARD_FIXTURES,
  validateSimulatedCard,
} from './simulated-card.js';

describe('Simulated Card & Payment Foundation (C1)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Gating & Environment Verification', () => {
    it('throws HTTP 503 PAYMENT_SIMULATION_DISABLED if NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';
      process.env.SIMULATED_PAYMENTS_ENABLED = 'true';
      expect(() => assertPaymentSimulationEnabled()).toThrow(
        expect.objectContaining({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          response: expect.objectContaining({
            error: expect.objectContaining({
              code: 'PAYMENT_SIMULATION_DISABLED',
            }),
          }),
        }),
      );
    });

    it('throws HTTP 503 PAYMENT_SIMULATION_DISABLED if SIMULATED_PAYMENTS_ENABLED is false or unset', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.SIMULATED_PAYMENTS_ENABLED;
      expect(() => assertPaymentSimulationEnabled()).toThrow(
        expect.objectContaining({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          response: expect.objectContaining({
            error: expect.objectContaining({
              code: 'PAYMENT_SIMULATION_DISABLED',
            }),
          }),
        }),
      );

      process.env.SIMULATED_PAYMENTS_ENABLED = 'false';
      expect(() => assertPaymentSimulationEnabled()).toThrow(
        expect.objectContaining({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          response: expect.objectContaining({
            error: expect.objectContaining({
              code: 'PAYMENT_SIMULATION_DISABLED',
            }),
          }),
        }),
      );
    });

    it('passes gating when NODE_ENV is test or demo and SIMULATED_PAYMENTS_ENABLED is true', () => {
      process.env.NODE_ENV = 'test';
      process.env.SIMULATED_PAYMENTS_ENABLED = 'true';
      expect(() => assertPaymentSimulationEnabled()).not.toThrow();

      process.env.NODE_ENV = 'demo';
      expect(() => assertPaymentSimulationEnabled()).not.toThrow();
    });
  });

  describe('Fixtures Definition (MD9 Exact)', () => {
    it('defines exactly the 3 MD9 simulation fixtures with expected constants', () => {
      expect(SIMULATED_CARD_FIXTURES).toHaveLength(3);
      const [approved, limited, empty] = SIMULATED_CARD_FIXTURES;

      expect(approved).toEqual({
        fixtureId: 'DEMO_APPROVED',
        holderName: 'PRUEBA APROBADA',
        last4: '0001',
        normalizedNumber: '9000000000000001',
        cvv: '111',
        expiresMonth: 12,
        expiresYear: 2030,
        initialBalanceCents: 50000n,
      });

      expect(limited).toEqual({
        fixtureId: 'DEMO_LIMITED',
        holderName: 'PRUEBA LIMITADA',
        last4: '0002',
        normalizedNumber: '9000000000000002',
        cvv: '222',
        expiresMonth: 12,
        expiresYear: 2030,
        initialBalanceCents: 2000n,
      });

      expect(empty).toEqual({
        fixtureId: 'DEMO_EMPTY',
        holderName: 'PRUEBA SIN SALDO',
        last4: '0003',
        normalizedNumber: '9000000000000003',
        cvv: '333',
        expiresMonth: 12,
        expiresYear: 2030,
        initialBalanceCents: 0n,
      });
    });
  });

  describe('Validation & Normalization', () => {
    const validInstant = toInstant('2026-10-23T12:00:00Z');

    it('validates and normalizes DEMO_APPROVED card with spaced number and mixed-case holder', () => {
      const result = validateSimulatedCard(
        {
          number: ' 9000 0000 0000 0001 ',
          holderName: '  prueba aprobada  ',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '111',
        },
        validInstant,
      );

      expect(result).toEqual({
        fixtureId: 'DEMO_APPROVED',
        last4: '0001',
      });
      // Ensure no sensitive data leaked in returned object
      expect(result).not.toHaveProperty('number');
      expect(result).not.toHaveProperty('cvv');
      expect(result).not.toHaveProperty('balanceCents');
    });

    it('validates DEMO_LIMITED and DEMO_EMPTY cards', () => {
      expect(
        validateSimulatedCard(
          {
            number: '9000000000000002',
            holderName: 'PRUEBA LIMITADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '222',
          },
          validInstant,
        ),
      ).toEqual({
        fixtureId: 'DEMO_LIMITED',
        last4: '0002',
      });

      expect(
        validateSimulatedCard(
          {
            number: '9000 0000 0000 0003',
            holderName: 'PRUEBA SIN SALDO',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '333',
          },
          validInstant,
        ),
      ).toEqual({
        fixtureId: 'DEMO_EMPTY',
        last4: '0003',
      });
    });

    it('rejects unknown card number with 422 CARD_INVALID without leaking sensitive details', () => {
      try {
        validateSimulatedCard(
          {
            number: '9000 0000 0000 9999',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
          validInstant,
        );
        fail('expected validation error');
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        const res = err.getResponse();
        expect(res.error.code).toBe('CARD_INVALID');
        expect(JSON.stringify(res)).not.toMatch(/9000|111|cvv|number/i);
      }
    });

    it('rejects mismatched holderName with 422 CARD_INVALID', () => {
      expect(() =>
        validateSimulatedCard(
          {
            number: '9000000000000001',
            holderName: 'OTRO TITULAR',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
          validInstant,
        ),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_INVALID' }),
          }),
        }),
      );
    });

    it('rejects mismatched CVV with 422 CARD_INVALID', () => {
      expect(() =>
        validateSimulatedCard(
          {
            number: '9000000000000001',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '999',
          },
          validInstant,
        ),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_INVALID' }),
          }),
        }),
      );
    });

    it('rejects expired card with 422 CARD_EXPIRED against authoritative instant', () => {
      const expiredInstant = toInstant('2031-01-01T05:00:00Z');
      expect(() =>
        validateSimulatedCard(
          {
            number: '9000000000000001',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
          expiredInstant,
        ),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_EXPIRED' }),
          }),
        }),
      );
    });

    it('accepts card up to the very last second of its expiry month in America/Guayaquil', () => {
      // 2030-12-31T23:59:59-05:00 is 2031-01-01T04:59:59Z
      const justBeforeExpiry = toInstant('2031-01-01T04:59:59Z');
      expect(
        validateSimulatedCard(
          {
            number: '9000000000000001',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
          justBeforeExpiry,
        ),
      ).toEqual({
        fixtureId: 'DEMO_APPROVED',
        last4: '0001',
      });
    });

    it('rejects card if number, holder, or cvv is null or empty', () => {
      expect(() =>
        validateSimulatedCard(
          {
            number: '',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
          validInstant,
        ),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_INVALID' }),
          }),
        }),
      );

      expect(() =>
        validateSimulatedCard(
          {
            number: '9000000000000001',
            holderName: '',
            expiresMonth: 12,
            expiresYear: 2030,
            cvv: '111',
          },
          validInstant,
        ),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_INVALID' }),
          }),
        }),
      );
    });

    it('rejects invalid month or year values with 422 CARD_INVALID', () => {
      expect(() =>
        validateSimulatedCard(
          {
            number: '9000000000000001',
            holderName: 'PRUEBA APROBADA',
            expiresMonth: 13,
            expiresYear: 2030,
            cvv: '111',
          },
          validInstant,
        ),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_INVALID' }),
          }),
        }),
      );
    });

    it('rejects string or float expiry month or year without coercion (strict integer check)', () => {
      const base = {
        number: '9000000000000001',
        holderName: 'PRUEBA APROBADA',
        expiresMonth: 12,
        expiresYear: 2030,
        cvv: '111',
      };

      // String month should NOT be coerced to number
      expect(() =>
        validateSimulatedCard({ ...base, expiresMonth: '12' as any }, validInstant),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_INVALID' }),
          }),
        }),
      );

      // String year should NOT be coerced to number
      expect(() =>
        validateSimulatedCard({ ...base, expiresYear: '2030' as any }, validInstant),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_INVALID' }),
          }),
        }),
      );

      // Non-integer float month
      expect(() =>
        validateSimulatedCard({ ...base, expiresMonth: 12.5 }, validInstant),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_INVALID' }),
          }),
        }),
      );

      // Non-integer float year
      expect(() =>
        validateSimulatedCard({ ...base, expiresYear: 2030.5 }, validInstant),
      ).toThrow(
        expect.objectContaining({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            error: expect.objectContaining({ code: 'CARD_INVALID' }),
          }),
        }),
      );
    });
  });

  describe('Bootstrap Idempotency & Balance Preservation', () => {
    it('refuses bootstrap when simulation is disabled (fails closed)', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SIMULATED_PAYMENTS_ENABLED = 'true';
      const fakeDb = { client: { rawSql: jest.fn() } };
      await expect(bootstrapSimulatedCards(fakeDb as any)).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.SERVICE_UNAVAILABLE,
        }),
      );
    });

    it('bootstraps missing fixtures via Prisma 8 raw.sql parameterized INSERT ON CONFLICT DO NOTHING', async () => {
      process.env.NODE_ENV = 'test';
      process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

      const executedPlans: any[] = [];
      const mockTx = {
        execute: jest.fn().mockImplementation(async (plan: any) => {
          executedPlans.push(plan);
          return { count: 1 };
        }),
      };

      const mockDb = {
        client: {
          raw: {
            sql: (strings: TemplateStringsArray, ...values: any[]) => ({
              affectedCount: () => ({
                build: () => ({
                  sqlText: strings.join('?'),
                  params: values,
                }),
              }),
            }),
          },
          transaction: jest.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => {
            return fn(mockTx);
          }),
        },
      };

      await bootstrapSimulatedCards(mockDb as any);

      expect(mockDb.client.transaction).toHaveBeenCalledTimes(1);
      expect(mockTx.execute).toHaveBeenCalledTimes(3);

      // Verify that every plan is an INSERT ON CONFLICT ("fixtureId") DO NOTHING
      for (const plan of executedPlans) {
        expect(plan.sqlText).toContain('INSERT INTO public."simulatedCard"');
        expect(plan.sqlText).toContain('ON CONFLICT ("fixtureId") DO NOTHING');
      }
    });

    it('supports caller passing PrismaService or db.client', async () => {
      process.env.NODE_ENV = 'test';
      process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

      const executedPlans: any[] = [];
      const mockTx = {
        execute: jest.fn().mockImplementation(async (plan: any) => {
          executedPlans.push(plan);
          return { count: 1 };
        }),
      };

      const mockClient = {
        raw: {
          sql: (strings: TemplateStringsArray, ...values: any[]) => ({
            affectedCount: () => ({
              build: () => ({ sqlText: strings.join('?'), params: values }),
            }),
          }),
        },
        transaction: jest.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => {
          return fn(mockTx);
        }),
      };

      // 1. Pass PrismaService instance wrapper { client: mockClient }
      await bootstrapSimulatedCards({ client: mockClient } as any);
      expect(mockTx.execute).toHaveBeenCalledTimes(3);

      // 2. Pass direct client
      mockTx.execute.mockClear();
      await bootstrapSimulatedCards(mockClient as any);
      expect(mockTx.execute).toHaveBeenCalledTimes(3);
    });

    it('resolves concurrent bootstrap invocations safely without race conditions', async () => {
      process.env.NODE_ENV = 'test';
      process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

      const executedPlans: any[] = [];
      const mockTx = {
        execute: jest.fn().mockImplementation(async (plan: any) => {
          executedPlans.push(plan);
          return { count: 1 };
        }),
      };

      const mockClient = {
        raw: {
          sql: (strings: TemplateStringsArray, ...values: any[]) => ({
            affectedCount: () => ({
              build: () => ({ sqlText: strings.join('?'), params: values }),
            }),
          }),
        },
        transaction: jest.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => {
          return fn(mockTx);
        }),
      };

      // Two concurrent bootstrap attempts resolve concurrently
      const results = await Promise.allSettled([
        bootstrapSimulatedCards(mockClient as any),
        bootstrapSimulatedCards(mockClient as any),
      ]);

      expect(results[0]?.status).toBe('fulfilled');
      expect(results[1]?.status).toBe('fulfilled');
      expect(mockClient.transaction).toHaveBeenCalledTimes(2);
      expect(mockTx.execute).toHaveBeenCalledTimes(6);
    });
  });
});
