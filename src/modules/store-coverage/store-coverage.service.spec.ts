import { HttpException, HttpStatus } from '@nestjs/common';
import { StoreCoverageService } from './store-coverage.service.js';

const coverageA = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};

describe('StoreCoverageService', () => {
  let service: StoreCoverageService;
  let mockPrisma: any;
  const row = {
    id: 'store-1',
    singletonKey: 'GLOBAL',
    lat: 1,
    lng: 1,
    coverage: coverageA,
    updatedById: 'admin-1',
    createdAt: new Date('2026-11-11T00:00:00.000Z'),
    updatedAt: new Date('2026-11-11T00:00:00.000Z'),
  };

  beforeEach(() => {
    mockPrisma = {
      client: {
        raw: {
          sql: jest.fn().mockReturnValue({
            affectedCount: jest.fn().mockReturnValue({
              build: jest.fn().mockReturnValue({ query: 'ADVISORY_LOCK' }),
            }),
            returnsRow: jest.fn().mockReturnValue({
              build: jest.fn().mockReturnValue({ query: 'ROW_LOCK' }),
            }),
          }),
        },
        orm: {
          public: {
            StoreCoverage: {
              where: jest.fn().mockReturnValue({
                first: jest.fn().mockResolvedValue(null),
              }),
            },
          },
        },
        transaction: jest.fn(),
      },
    };
    service = new StoreCoverageService(mockPrisma);
  });

  it('returns configured:false when no singleton exists', async () => {
    await expect(service.getCoverage()).resolves.toEqual({ configured: false });
  });

  it('returns the persisted store without inventing coordinates', async () => {
    mockPrisma.client.orm.public.StoreCoverage.where.mockReturnValue({
      first: jest.fn().mockResolvedValue(row),
    });
    await expect(service.getCoverage()).resolves.toEqual({
      configured: true,
      location: { lat: 1, lng: 1 },
      coverage: coverageA,
      updatedAt: '2026-11-11T00:00:00.000Z',
      updatedById: 'admin-1',
    });
  });

  it('rejects invalid coverage before opening a write transaction', async () => {
    await expect(
      service.upsertCoverage('admin-1', {
        location: { lat: 1, lng: 1 },
        coverage: { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'STORE_COVERAGE_INVALID' } },
    });
    expect(mockPrisma.client.transaction).not.toHaveBeenCalled();
  });

  it('rejects a zero-area ring without opening a write transaction', async () => {
    await expect(
      service.upsertCoverage('admin-1', {
        location: { lat: 1, lng: 1 },
        coverage: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [2, 0],
              [0, 0],
            ],
          ],
        },
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'STORE_COVERAGE_INVALID' } },
    });
    expect(mockPrisma.client.transaction).not.toHaveBeenCalled();
  });

  it('creates the singleton on the first valid write', async () => {
    mockPrisma.client.transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        execute: jest.fn().mockResolvedValue({ count: 1 }),
        query: jest.fn().mockResolvedValue([]),
        orm: {
          public: {
            StoreCoverage: {
              create: jest.fn().mockResolvedValue(row),
              where: jest.fn(),
            },
          },
        },
      };
      return cb(tx);
    });

    const result = await service.upsertCoverage('admin-1', {
      location: { lat: 1, lng: 1 },
      coverage: coverageA,
    });
    expect(result.configured).toBe(true);
    expect(result.location).toEqual({ lat: 1, lng: 1 });
  });

  it('retries a unique-violation race on the first singleton insert', async () => {
    const uniqueError = { code: '23505', constraint: 'storeCoverage_singletonKey_key', message: 'unique singleton' };
    mockPrisma.client.transaction
      .mockImplementationOnce(async () => {
        throw uniqueError;
      })
      .mockImplementationOnce(async (cb: (tx: any) => Promise<unknown>) => {
        const tx = {
          execute: jest.fn().mockResolvedValue({ count: 1 }),
          query: jest.fn().mockResolvedValue([{ id: row.id }]),
          orm: {
            public: {
              StoreCoverage: {
                where: jest.fn().mockReturnValue({
                  update: jest.fn().mockResolvedValue({ ...row, lat: 2, lng: 2 }),
                }),
              },
            },
          },
        };
        return cb(tx);
      });

    const result = await service.upsertCoverage('admin-1', {
      location: { lat: 2, lng: 2 },
      coverage: coverageA,
    });
    expect(result.location).toEqual({ lat: 2, lng: 2 });
    expect(mockPrisma.client.transaction).toHaveBeenCalledTimes(2);
  });

  it('throws STORE_NOT_CONFIGURED instead of accepting a point', async () => {
    try {
      await service.evaluatePoint({ lat: 5, lng: 5 });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
      expect((error as HttpException).getResponse()).toMatchObject({
        error: { code: 'STORE_NOT_CONFIGURED' },
      });
    }
  });

  it('classifies interior, boundary, and exterior points against saved coverage', async () => {
    mockPrisma.client.orm.public.StoreCoverage.where.mockReturnValue({
      first: jest.fn().mockResolvedValue(row),
    });
    await expect(service.evaluatePoint({ lat: 5, lng: 5 })).resolves.toEqual({
      accepted: true,
      position: 'INTERIOR',
    });
    await expect(service.evaluatePoint({ lat: 0, lng: 5 })).resolves.toEqual({
      accepted: true,
      position: 'BOUNDARY',
    });
    await expect(service.evaluatePoint({ lat: 5, lng: 15 })).resolves.toEqual({
      accepted: false,
      position: 'EXTERIOR',
    });
  });
});
