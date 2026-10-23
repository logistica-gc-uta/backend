import { PrismaService } from '../../database/prisma.service.js';
import { AdminRouteHistoryUserDto } from './dto/route-history-response.dto.js';
import { RouteHistoryService } from './route-history.service.js';

describe('Admin route history user DTO', () => {
  it('no declara un miembro password en la relación de usuario', () => {
    const dto = new AdminRouteHistoryUserDto();

    expect(Object.keys(dto)).not.toContain('password');
    expect('password' in dto).toBe(false);
    expect(Object.keys(dto).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'role',
    ]);
  });
});

describe('Batched stable route history', () => {
  const timestamp = { toString: () => '2026-10-10T00:00:00Z' };
  function setup() {
    const stops = [
      {
        id: 'z',
        routeId: 'past',
        orderId: 'one',
        sequence: null,
        outcome: null,
        isLegacy: true,
        createdAt: null,
        order: {
          id: 'one',
          routeId: 'future',
          deliveryAddress: 'Current',
          status: 'PENDING',
          scheduledDeliveryDate: timestamp,
        },
      },
      {
        id: 'b',
        routeId: 'past',
        orderId: 'two',
        sequence: 2,
        outcome: 'FAILED',
        isLegacy: false,
        createdAt: timestamp,
        order: {
          id: 'two',
          status: 'PENDING',
          deliveryAddress: 'Current',
          scheduledDeliveryDate: timestamp,
        },
      },
      {
        id: 'a',
        routeId: 'past',
        orderId: 'three',
        sequence: 2,
        outcome: null,
        isLegacy: true,
        createdAt: null,
        order: {
          id: 'three',
          status: 'DELIVERED',
          deliveryAddress: 'Current',
          scheduledDeliveryDate: null,
        },
      },
    ];
    const attempts = [
      {
        id: 'attempt',
        stopId: 'b',
        driverId: 'actor',
        recordedAt: timestamp,
        outcome: 'FAILED',
        failureReason: 'RECIPIENT_ABSENT',
        context: { description: 'No recipient' },
        requestPayload: { secret: true },
        idempotencyKey: 'private',
      },
    ];
    const stopQuery: any = {
      where: jest.fn().mockReturnThis(),
      include: jest.fn().mockReturnThis(),
      all: jest.fn().mockResolvedValue(stops),
    };
    const attemptQuery: any = {
      where: jest.fn().mockReturnThis(),
      all: jest.fn().mockResolvedValue(attempts),
    };
    return {
      stopQuery,
      attemptQuery,
      attempts,
      service: new RouteHistoryService({
        client: {
          orm: {
            public: { RouteStop: stopQuery, DeliveryAttempt: attemptQuery },
          },
        },
      } as unknown as PrismaService),
    };
  }
  it('preserves nullable/tied legacy sequence and immutable visit association despite commercial pointer movement', async () => {
    const { service, stopQuery, attemptQuery } = setup();
    const [route]: any = await service.project([
      {
        id: 'past',
        status: null,
        startedAt: null,
        startedById: null,
        completedAt: null,
        completedById: null,
        returnedAt: null,
        returnedById: null,
      },
      { id: 'empty', status: 'DRAFT' },
    ]);
    expect(route.status).toBe('UNVERIFIED');
    expect(route.stops.map((stop: any) => stop.id)).toEqual(['a', 'b', 'z']);
    expect(
      route.orders.map((order: any) => [order.id, order.stopOrder]),
    ).toEqual([
      ['three', 2],
      ['two', 2],
      ['one', null],
    ]);
    expect(route.stops[1].attempts[0]).toEqual({
      id: 'attempt',
      stopId: 'b',
      driverId: 'actor',
      recordedAt: timestamp.toString(),
      outcome: 'FAILED',
      failureReason: 'RECIPIENT_ABSENT',
      context: 'No recipient',
    });
    expect(route.events).toEqual([]);
    expect(stopQuery.all).toHaveBeenCalledTimes(1);
    expect(attemptQuery.all).toHaveBeenCalledTimes(1);
    const inRoutes = jest.fn();
    stopQuery.where.mock.calls[0][0]({ routeId: { in: inRoutes } });
    expect(inRoutes).toHaveBeenCalledWith(['past', 'empty']);
    const inStops = jest.fn();
    attemptQuery.where.mock.calls[0][0]({ stopId: { in: inStops } });
    expect(inStops).toHaveBeenCalledWith(['z', 'b', 'a']);
  });
  it('sorts actual instants and equal-time attempt IDs without exposing replay payloads', async () => {
    const { service, attempts } = setup();
    attempts[0].recordedAt = { toString: () => '2026-10-10T00:00:00.001Z' };
    attempts.push({ ...attempts[0], id: 'z-tie', recordedAt: timestamp });
    attempts.push({ ...attempts[0], id: 'a-tie', recordedAt: timestamp });
    const [route] = await service.project([
      {
        id: 'past',
        status: 'COMPLETED',
        completedAt: timestamp,
        completedById: 'actor',
      },
    ]);
    expect(route.stops[1].attempts.map((attempt) => attempt.id)).toEqual([
      'a-tie',
      'z-tie',
      'attempt',
    ]);
    expect(route.events).toEqual([
      { kind: 'COMPLETED', actorId: 'actor', recordedAt: timestamp.toString() },
    ]);
  });
  it.each(['stop', 'direct'] as const)(
    'keeps the legacy ADMIN commercial shape and DRIVER restriction for %s orders',
    async (association) => {
      const { service, stopQuery } = setup();
      const order = {
        id: 'one',
        routeId: 'past',
        deliveryAddress: 'Current',
        status: 'PENDING',
        scheduledDeliveryDate: timestamp,
        stopOrder: 3,
        total: 12.75,
        subtotalCents: 1275n,
      };
      const directQuery = {
        where: jest.fn().mockReturnThis(),
        all: jest.fn().mockResolvedValue([order]),
      };
      (service as any).prisma.client.orm.public.Order = directQuery;
      if (association === 'direct') stopQuery.all.mockResolvedValue([]);
      else
        stopQuery.all.mockResolvedValue([
          { id: 'stop', routeId: 'past', sequence: 3, order },
        ]);
      const route = [{ id: 'past', status: 'DRAFT' }];
      for (const cents of [null, 1275n]) {
        (order as { subtotalCents: bigint | null }).subtotalCents = cents;
        const [admin] = await service.project(route, true);
        expect(admin.orders[0]).toMatchObject({ total: 12.75, stopOrder: 3 });
        expect(Object.keys(admin.orders[0]).sort()).toEqual([
          'deliveryAddress',
          'id',
          'routeId',
          'scheduledDeliveryDate',
          'status',
          'stopOrder',
          'total',
        ]);
        expect(JSON.stringify(admin)).toContain('"total":12.75');
        const [driver] = await service.project(route);
        expect(Object.keys(driver.orders[0]).sort()).toEqual([
          'deliveryAddress',
          'id',
          'scheduledDeliveryDate',
          'status',
          'stopOrder',
        ]);
        expect(JSON.stringify(driver)).not.toContain('subtotalCents');
      }
    },
  );
  it('does not fetch attempts when all selected routes have no stops', async () => {
    const { service, stopQuery, attemptQuery } = setup();
    stopQuery.all.mockResolvedValue([]);
    const [route] = await service.project([{ id: 'empty', status: 'DRAFT' }]);
    expect(route.stops).toEqual([]);
    expect(route.orders).toEqual([]);
    expect(attemptQuery.all).not.toHaveBeenCalled();
  });
  it('returns empty results without empty IN database queries', async () => {
    const { service, stopQuery } = setup();
    expect(await service.project([])).toEqual([]);
    expect(stopQuery.all).not.toHaveBeenCalled();
  });
});
