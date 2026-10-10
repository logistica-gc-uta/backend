import { PrismaService } from '../../database/prisma.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';

describe('RouteAvailabilityService', () => {
  const evaluate = (
    routes: unknown[],
    reservations: unknown[] = [],
    audits: unknown[] = [],
    flag = true,
    actorRole = 'ADMIN',
  ) => {
    const model = (rows: unknown[]) => ({
      where: () => ({
        all: async () => rows,
        first: async () => rows[0] ?? null,
      }),
    });
    const tx = {
      orm: {
        public: {
          Route: model(routes),
          DriverReservation: model(reservations),
          LegacyRouteReconciliation: model(audits),
          Driver: model([{ isAvailable: flag }]),
          User: {
            where: (filter: any) => ({
              first: async () =>
                !filter.role || filter.role === actorRole
                  ? { role: actorRole }
                  : null,
            }),
          },
        },
      },
    };
    return new RouteAvailabilityService({
      client: tx,
    } as unknown as PrismaService).effective('driver');
  };
  it.each(['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', null])(
    'blocks unresolved %s routes',
    async (status) => {
      expect(
        await evaluate([{ id: 'route', status, returnedAt: null }]),
      ).toEqual({
        isAvailable: false,
        hasPersistedHolds: true,
        compatibilityFlagBlocks: false,
        blockingRouteIds: ['route'],
      });
    },
  );
  it('does not report assignable availability when the compatibility flag is unverified false', async () => {
    expect(await evaluate([], [], [], false)).toEqual({
      isAvailable: false,
      hasPersistedHolds: false,
      compatibilityFlagBlocks: true,
      blockingRouteIds: [],
    });
  });
  it('active reservations override returned routes and compatibility flags', async () => {
    expect(await evaluate([], [{ routeId: 'route' }])).toEqual({
      isAvailable: false,
      hasPersistedHolds: true,
      compatibilityFlagBlocks: false,
      blockingRouteIds: ['route'],
    });
  });
  it('does not hold a driver for DRAFT or genuinely returned COMPLETED', async () => {
    expect(
      await evaluate([
        { id: 'draft', status: 'DRAFT' },
        {
          id: 'returned',
          status: 'COMPLETED',
          returnedAt: Temporal.Instant.from('2026-10-10T00:00:00Z'),
          returnedById: 'actor',
          completedAt: Temporal.Instant.from('2026-10-10T00:00:00Z'),
          completedById: 'actor',
          startedAt: Temporal.Instant.from('2026-10-10T00:00:00Z'),
          startedById: 'actor',
        },
      ]),
    ).toEqual({
      isAvailable: true,
      hasPersistedHolds: false,
      compatibilityFlagBlocks: false,
      blockingRouteIds: [],
    });
  });
  it('accepts only persisted validated structured legacy release evidence', async () => {
    const audit = {
      id: 'audit',
      administratorId: 'admin',
      reason: 'Verified dispatch stopped',
      evidence: { evidence: 'Depot operator confirmation' },
      releaseDriverHold: true,
      recordedAt: Temporal.Instant.from('2026-10-10T00:00:00Z'),
    };
    expect(
      (
        await evaluate(
          [{ id: 'legacy', status: null }],
          [],
          [audit],
          true,
          'CLIENT',
        )
      ).isAvailable,
    ).toBe(true);
    expect(
      (await evaluate([{ id: 'legacy', status: null }], [], [audit]))
        .isAvailable,
    ).toBe(true);
    expect(
      (
        await evaluate(
          [{ id: 'legacy', status: null }],
          [],
          [{ ...audit, evidence: {} }],
        )
      ).isAvailable,
    ).toBe(false);
  });
});
