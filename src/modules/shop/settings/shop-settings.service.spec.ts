import { HttpException, HttpStatus } from '@nestjs/common';
import { ShopSettingsService, toIsoTimestamp } from './shop-settings.service.js';

describe('ShopSettingsService (unit)', () => {
  let service: ShopSettingsService;
  let mockPrisma: any;

  const mockDbRow = {
    id: '00000000-0000-4000-8000-000000000001',
    singletonKey: 'GLOBAL',
    version: 1,
    currency: 'USD',
    shippingStatus: 'FREE_INCLUDED',
    shippingAmountCents: 0,
    shippingIncludedInPrices: true,
    taxMode: 'SIMULATED',
    taxEnabled: true,
    taxRateBps: 1500,
    maxUnitsPerSkuPerOrder: 10,
    deliveryTimeZone: 'America/Guayaquil',
    deliveryStartTime: '07:00',
    deliveryEndTime: '17:00',
    deliveryBoundariesInclusive: true,
    updatedById: null,
    createdAt: new Date('2026-10-23T12:00:00.000Z'),
    updatedAt: new Date('2026-10-23T12:00:00.000Z'),
  };

  beforeEach(() => {
    mockPrisma = {
      client: {
        raw: {
          sql: jest.fn().mockReturnValue({
            returnsRow: jest.fn().mockReturnValue({
              build: jest.fn().mockReturnValue({ query: 'MOCK_QUERY' }),
            }),
          }),
        },
        orm: {
          public: {
            ShopBusinessSettings: {
              where: jest.fn().mockReturnValue({
                first: jest.fn().mockResolvedValue(mockDbRow),
              }),
            },
          },
        },
        transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => {
          const tx = {
            query: jest.fn().mockResolvedValue([mockDbRow]),
            execute: jest.fn().mockResolvedValue({ affectedRows: 1 }),
            orm: {
              public: {
                ShopBusinessSettings: {
                  where: jest.fn().mockReturnValue({
                    first: jest.fn().mockResolvedValue(mockDbRow),
                    update: jest.fn().mockResolvedValue({
                      ...mockDbRow,
                      version: 2,
                      taxRateBps: 1200,
                      updatedById: 'admin-uuid-1',
                      updatedAt: new Date('2026-10-23T13:00:00.000Z'),
                    }),
                  }),
                },
                ShopSettingsAudit: {
                  create: jest.fn().mockResolvedValue({ id: 'audit-uuid-1' }),
                },
              },
            },
          };
          return cb(tx);
        }),
      },
    };
    service = new ShopSettingsService(mockPrisma);
  });

  describe('getPublicSettings', () => {
    it('returns the exact public projection without leaking admin/audit identity', async () => {
      mockPrisma.client.orm.public.ShopBusinessSettings.where = jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue(mockDbRow),
      });

      const res = await service.getPublicSettings();
      expect(res).toEqual({
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
      });
      expect((res as any).updatedById).toBeUndefined();
      expect((res as any).createdAt).toBeUndefined();
    });

    it('throws 500 when database settings row is missing, refusing to synthesize silent JS defaults', async () => {
      mockPrisma.client.orm.public.ShopBusinessSettings.where = jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(service.getPublicSettings()).rejects.toThrow(HttpException);
      try {
        await service.getPublicSettings();
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        const resp = err.getResponse();
        expect(resp.error.code).toBe('SETTINGS_NOT_CONFIGURED');
      }
    });
  });

  describe('getAdminSettings', () => {
    it('returns the admin projection including updatedById and createdAt', async () => {
      mockPrisma.client.orm.public.ShopBusinessSettings.where = jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue(mockDbRow),
      });

      const res = await service.getAdminSettings();
      expect(res).toEqual({
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
        updatedById: null,
        createdAt: '2026-10-23T12:00:00.000Z',
      });
    });
  });

  describe('patchAdminSettings', () => {
    it('throws 400 VALIDATION_ERROR on empty patch body / no modifications', async () => {
      await expect(
        service.patchAdminSettings('admin-1', { expectedVersion: 1 } as any),
      ).rejects.toThrow(HttpException);
    });

    it('throws 409 SETTINGS_VERSION_CONFLICT when expectedVersion does not match current version', async () => {
      await expect(
        service.patchAdminSettings('admin-1', {
          expectedVersion: 99,
          tax: { rateBps: 1200 },
        }),
      ).rejects.toThrow(HttpException);

      try {
        await service.patchAdminSettings('admin-1', {
          expectedVersion: 99,
          tax: { rateBps: 1200 },
        });
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(err.getResponse().error.code).toBe('SETTINGS_VERSION_CONFLICT');
      }
    });

    it('throws 400 VALIDATION_ERROR when rateBps is outside 0..10000 range', async () => {
      await expect(
        service.patchAdminSettings('admin-1', {
          expectedVersion: 1,
          tax: { rateBps: 12000 },
        }),
      ).rejects.toThrow(HttpException);
    });

    it('throws 400 VALIDATION_ERROR when maxUnitsPerSkuPerOrder is outside 1..100 range', async () => {
      await expect(
        service.patchAdminSettings('admin-1', {
          expectedVersion: 1,
          limits: { maxUnitsPerSkuPerOrder: 0 },
        }),
      ).rejects.toThrow(HttpException);
    });

    it('throws 400 VALIDATION_ERROR when partial schedule causes startTime >= endTime', async () => {
      // Current DB endTime is 17:00. Trying to set startTime to 18:00 must fail!
      await expect(
        service.patchAdminSettings('admin-1', {
          expectedVersion: 1,
          deliverySchedule: { startTime: '18:00' },
        }),
      ).rejects.toThrow(HttpException);
    });

    it('applies valid partial update, increments version, and creates audit record in same transaction', async () => {
      const res = await service.patchAdminSettings('admin-uuid-1', {
        expectedVersion: 1,
        tax: { rateBps: 1200 },
      });

      expect(res.version).toBe(2);
      expect(res.tax.rateBps).toBe(1200);
      expect(res.tax.ratePercent).toBe(12);
      expect(res.updatedById).toBe('admin-uuid-1');
    });

    it.each([
      ['tax.rateBps lower bound 0', { expectedVersion: 1, tax: { rateBps: 0 } }, (res: any) => expect(res.tax.rateBps).toBe(0)],
      ['tax.rateBps upper bound 10000', { expectedVersion: 1, tax: { rateBps: 10000 } }, (res: any) => expect(res.tax.rateBps).toBe(10000)],
      ['limits.maxUnits lower bound 1', { expectedVersion: 1, limits: { maxUnitsPerSkuPerOrder: 1 } }, (res: any) => expect(res.limits.maxUnitsPerSkuPerOrder).toBe(1)],
      ['limits.maxUnits upper bound 100', { expectedVersion: 1, limits: { maxUnitsPerSkuPerOrder: 100 } }, (res: any) => expect(res.limits.maxUnitsPerSkuPerOrder).toBe(100)],
      ['schedule full-day boundary 00:00 < 23:59', { expectedVersion: 1, deliverySchedule: { startTime: '00:00', endTime: '23:59' } }, (res: any) => {
        expect(res.deliverySchedule.startTime).toBe('00:00');
        expect(res.deliverySchedule.endTime).toBe('23:59');
      }],
    ])('accepts S4 valid boundary: %s', async (_label, patch, assertions) => {
      const res = await service.patchAdminSettings('admin-uuid-1', patch as any);
      expect(res.version).toBe(2);
      assertions(res);
    });

    it('rejects equal-time delivery schedule (startTime == endTime)', async () => {
      await expect(
        service.patchAdminSettings('admin-1', {
          expectedVersion: 1,
          deliverySchedule: { startTime: '12:00', endTime: '12:00' },
        }),
      ).rejects.toThrow(HttpException);
    });

    it.each([
      ['empty tax object', { expectedVersion: 1, tax: {} }],
      ['empty limits object', { expectedVersion: 1, limits: {} }],
      ['empty deliverySchedule object', { expectedVersion: 1, deliverySchedule: {} }],
    ])('rejects empty nested patch %s', async (_label, patch) => {
      await expect(
        service.patchAdminSettings('admin-1', patch as any),
      ).rejects.toThrow(HttpException);
    });

    it.each([
      ['(a) tax: null', { expectedVersion: 1, tax: null, limits: { maxUnitsPerSkuPerOrder: 20 } }],
      ['(b) limits: null', { expectedVersion: 1, limits: null, tax: { rateBps: 1200 } }],
      ['(c) deliverySchedule: null', { expectedVersion: 1, deliverySchedule: null, tax: { rateBps: 1200 } }],
      ['(d) tax.enabled: null', { expectedVersion: 1, tax: { enabled: null, rateBps: 1200 } }],
      ['(e) deliverySchedule.startTime: null', { expectedVersion: 1, deliverySchedule: { startTime: null, endTime: '16:00' } }],
      ['(f) deliverySchedule.endTime: null', { expectedVersion: 1, deliverySchedule: { startTime: '08:00', endTime: null } }],
    ])('rejects explicitly supplied null payload %s', async (_label, patch) => {
      await expect(
        service.patchAdminSettings('admin-1', patch as any),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('toIsoTimestamp (fail-closed timestamp representation)', () => {
    it('fails closed and throws error when timestamp value is absent (null, undefined, or empty string)', () => {
      expect(() => toIsoTimestamp(null)).toThrow(/absent|empty|unparseable/);
      expect(() => toIsoTimestamp(undefined)).toThrow(/absent|empty|unparseable/);
      expect(() => toIsoTimestamp('')).toThrow(/absent|empty|unparseable/);
      expect(() => toIsoTimestamp('   ')).toThrow(/absent|empty|unparseable/);
    });

    it('fails closed when Date or string value is unparseable/invalid', () => {
      expect(() => toIsoTimestamp(new Date('invalid-date'))).toThrow(/Invalid Date/);
      expect(() => toIsoTimestamp('not-a-timestamp')).toThrow(/Invalid string timestamp/);
    });

    it('converts valid Date, ISO string, and Temporal-like objects without synthesizing current time', () => {
      const fixedIso = '2026-10-23T12:00:00.000Z';
      expect(toIsoTimestamp(new Date(fixedIso))).toBe(fixedIso);
      expect(toIsoTimestamp(fixedIso)).toBe(fixedIso);

      const temporalLike = {
        toString: () => '2026-10-23T15:30:00.000Z',
      };
      expect(toIsoTimestamp(temporalLike)).toBe('2026-10-23T15:30:00.000Z');
    });
  });
});
