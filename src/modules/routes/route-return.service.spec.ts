import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { RouteReturnService } from './route-return.service.js';

describe('RouteReturnService', () => {
  let service: RouteReturnService;
  let route: any;
  let driver: any;
  let reservation: any;
  let lostDriver: boolean;
  let lostRoute: boolean;
  let releaseCount: number;
  let available: jest.Mock;
  beforeEach(() => {
    const time = Temporal.Instant.from('2026-10-10T00:00:00Z');
    route = {
      id: 'route',
      driverId: 'driver',
      status: 'COMPLETED',
      startedAt: time,
      startedById: 'actor',
      completedAt: time,
      completedById: 'actor',
      returnedAt: null,
      returnedById: null,
    };
    driver = { id: 'driver', userId: 'actor', isAvailable: false };
    reservation = {
      id: 'reservation',
      routeId: 'route',
      driverId: 'driver',
      reservedAt: time,
      releasedAt: null,
    };
    lostDriver = false;
    lostRoute = false;
    releaseCount = 0;
    const match = (row: any, filter: any) =>
      row && Object.entries(filter).every(([key, value]) => row[key] === value);
    const model = (row: () => any, update: (value: any) => any) => ({
      where: (filter: any) => ({
        first: async () => (match(row(), filter) ? row() : null),
        update: async (value: any) =>
          match(row(), filter) ? update(value) : null,
      }),
    });
    const tx = {
      orm: {
        public: {
          Driver: model(
            () => driver,
            (value) => (lostDriver ? null : Object.assign(driver, value)),
          ),
          Route: model(
            () => route,
            (value) => (lostRoute ? null : Object.assign(route, value)),
          ),
          DriverReservation: model(
            () => reservation,
            (value) => {
              releaseCount++;
              return Object.assign(reservation, value);
            },
          ),
        },
      },
    };
    available = jest
      .fn()
      .mockResolvedValue({ isAvailable: true, blockingRouteIds: [] });
    service = new RouteReturnService(
      {
        client: { transaction: async (fn: any) => fn(tx) },
      } as unknown as PrismaService,
      {
        effective: available,
        recomputeProjection: async () => {
          const result = await available();
          driver.isAvailable = result.isAvailable;
          return result;
        },
      } as unknown as RouteAvailabilityService,
    );
  });
  it('persists paired return audit and matching reservation release once', async () => {
    const result = await service.returnToDepot('route', 'actor');
    expect(result.returnedAt).toBe(route.returnedAt.toString());
    expect(route.returnedById).toBe('actor');
    expect(reservation.releasedAt.toString()).toBe(result.returnedAt);
    expect(driver.isAvailable).toBe(true);
    expect(await service.returnToDepot('route', 'actor')).toEqual(result);
    expect(releaseCount).toBe(1);
  });
  it('preserves other holds in compatibility projection', async () => {
    available.mockResolvedValue({
      isAvailable: false,
      blockingRouteIds: ['legacy'],
    });
    await service.returnToDepot('route', 'actor');
    expect(available).toHaveBeenCalled();
    expect(driver.isAvailable).toBe(false);
  });
  it.each(['ASSIGNED', 'IN_PROGRESS', 'DRAFT', null])(
    'rejects %s without return writes',
    async (status) => {
      route.status = status;
      await expect(
        service.returnToDepot('route', 'actor'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(route.returnedAt).toBeNull();
      expect(releaseCount).toBe(0);
    },
  );
  it('requires complete genuine paired audit', async () => {
    route.completedById = null;
    await expect(
      service.returnToDepot('route', 'actor'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('requires matching active verified reservation', async () => {
    reservation.routeId = 'other';
    await expect(
      service.returnToDepot('route', 'actor'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects wrong owner', async () => {
    await expect(
      service.returnToDepot('route', 'stranger'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('rejects lost profile lock before stale ownership is used', async () => {
    lostDriver = true;
    await expect(
      service.returnToDepot('route', 'actor'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(route.returnedAt).toBeNull();
  });
  it('rejects missed conditional route lock', async () => {
    lostRoute = true;
    await expect(
      service.returnToDepot('route', 'actor'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('reports missing route', async () => {
    await expect(
      service.returnToDepot('missing', 'actor'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
