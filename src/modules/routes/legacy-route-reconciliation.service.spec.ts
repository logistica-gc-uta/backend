import { PrismaService } from '../../database/prisma.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { LegacyRouteReconciliationService } from './legacy-route-reconciliation.service.js';

describe('LegacyRouteReconciliationService conditional bindings', () => {
  let service: LegacyRouteReconciliationService;
  let route: any;
  let driver: any;
  let role: string;
  let audit: any;
  let loseDriver: boolean;
  let loseRoute: boolean;
  let loseReservation: boolean;
  let reservations: any[];
  let projection: jest.Mock;
  let effective: jest.Mock;
  let operations: string[];
  const payload = {
    reason: 'Dispatch checked',
    evidence: 'Independent depot check',
  };
  beforeEach(() => {
    route = { id: 'route', driverId: 'driver', status: null };
    driver = { id: 'driver', userId: 'owner' };
    role = 'ADMIN';
    audit = null;
    loseDriver = loseRoute = loseReservation = false;
    reservations = [
      {
        id: 'reservation',
        driverId: 'driver',
        routeId: 'route',
        reservedAt: null,
        releasedAt: null,
      },
    ];
    operations = [];
    const matches = (row: any, filter: any) =>
      row && Object.entries(filter).every(([key, value]) => row[key] === value);
    const model = (
      read: () => any[],
      update: (row: any, value: any) => any,
    ) => ({
      where: (filter: any) => ({
        first: async () => read().find((row) => matches(row, filter)) ?? null,
        all: async () => read().filter((row) => matches(row, filter)),
        update: async (value: any) => {
          const row = read().find((row) => matches(row, filter));
          return row ? update(row, value) : null;
        },
      }),
    });
    const tx = {
      orm: {
        public: {
          User: model(
            () => [{ id: 'admin', role }],
            () => null,
          ),
          Driver: model(
            () => (driver ? [driver] : []),
            (row, value) => {
              operations.push('driver-lock');
              return loseDriver ? null : Object.assign(row, value);
            },
          ),
          Route: model(
            () => (route ? [route] : []),
            (row, value) => {
              operations.push('route-lock');
              return loseRoute ? null : Object.assign(row, value);
            },
          ),
          DriverReservation: model(
            () => reservations,
            (row, value) => {
              operations.push('reservation-release');
              return loseReservation ? null : Object.assign(row, value);
            },
          ),
          LegacyRouteReconciliation: {
            ...model(
              () => (audit ? [audit] : []),
              () => null,
            ),
            create: async (value: any) => {
              operations.push('audit-insert');
              audit = { id: 'audit', ...value };
              return audit;
            },
          },
        },
      },
    };
    projection = jest.fn(async () => ({ isAvailable: true }));
    effective = jest.fn(async () => ({ isAvailable: false }));
    service = new LegacyRouteReconciliationService(
      {
        client: { transaction: async (fn: any) => fn(tx) },
      } as unknown as PrismaService,
      {
        recomputeProjection: projection,
        effective,
      } as unknown as RouteAvailabilityService,
    );
  });
  it('locks driver then legacy route and releases only the matching reservation', async () => {
    reservations.push({
      id: 'other',
      driverId: 'driver',
      routeId: 'verified',
      releasedAt: null,
    });
    const result = await service.reconcile('route', 'admin', payload);
    expect(operations).toEqual([
      'driver-lock',
      'route-lock',
      'audit-insert',
      'reservation-release',
    ]);
    expect(reservations[0].releasedAt.toString()).toBe(result.audit.recordedAt);
    expect(reservations[1].releasedAt).toBeNull();
    expect(route).toEqual({ id: 'route', driverId: 'driver', status: null });
    expect(projection).toHaveBeenCalledWith(
      'driver',
      'owner',
      expect.anything(),
    );
  });
  it('replays the original audit and current availability without resetting a later false flag', async () => {
    const original = await service.reconcile('route', 'admin', payload);
    projection.mockClear();
    operations = [];
    const replay = await service.reconcile('route', 'admin', payload);
    expect(replay.audit).toEqual(original.audit);
    expect(replay.availability).toEqual({ isAvailable: false });
    expect(projection).not.toHaveBeenCalled();
    expect(operations).toEqual(['driver-lock', 'route-lock']);
  });
  it.each(['DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'])(
    'refuses verified %s without audit',
    async (status) => {
      route.status = status;
      await expect(
        service.reconcile('route', 'admin', payload),
      ).rejects.toThrow('unverified');
      expect(audit).toBeNull();
    },
  );
  it('rejects missing route', async () => {
    route = null;
    await expect(service.reconcile('route', 'admin', payload)).rejects.toThrow(
      'not found',
    );
  });
  it.each(['CLIENT', 'DRIVER'])(
    'checks fresh stored %s role independently of HTTP',
    async (value) => {
      role = value;
      await expect(
        service.reconcile('route', 'admin', payload),
      ).rejects.toThrow('ADMIN');
      expect(audit).toBeNull();
    },
  );
  it('checks driver binding after lock acquisition', async () => {
    loseDriver = true;
    await expect(service.reconcile('route', 'admin', payload)).rejects.toThrow(
      'Driver binding',
    );
    expect(audit).toBeNull();
  });
  it('checks route binding after lock acquisition', async () => {
    loseRoute = true;
    await expect(service.reconcile('route', 'admin', payload)).rejects.toThrow(
      'Route binding',
    );
    expect(audit).toBeNull();
  });
  it('throws on conditional reservation release failure, leaving rollback to the transaction', async () => {
    loseReservation = true;
    await expect(service.reconcile('route', 'admin', payload)).rejects.toThrow(
      'Reservation changed',
    );
    expect(projection).not.toHaveBeenCalled();
  });
  it('audits driverless routes without inventing profile or projection', async () => {
    route.driverId = null;
    const result = await service.reconcile('route', 'admin', payload);
    expect(result.availability).toBeNull();
    expect(operations).toEqual(['route-lock', 'audit-insert']);
    expect(projection).not.toHaveBeenCalled();
  });
  it('conflicting audit evidence never releases or recomputes again', async () => {
    await service.reconcile('route', 'admin', payload);
    projection.mockClear();
    operations = [];
    await expect(
      service.reconcile('route', 'admin', {
        ...payload,
        reason: 'Different reason',
      }),
    ).rejects.toThrow('Conflicting');
    expect(operations).toEqual(['driver-lock', 'route-lock']);
    expect(projection).not.toHaveBeenCalled();
  });
});
