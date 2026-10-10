import { ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteProgressService } from './route-progress.service.js';
import { FailedVisitReason } from './dto/record-failed-visit.dto.js';
import { OrderStatus } from '../orders/dto/update-order-status.dto.js';

describe('Route progress authorization boundary', () => {
  const dto = {
    reason: FailedVisitReason.RECIPIENT_ABSENT,
    context: 'No recipient',
    requestId: 'request',
  };
  it('rejects a missing driver before any route mutation', async () => {
    const update = jest.fn();
    const tx = {
      orm: {
        public: {
          Driver: { where: () => ({ first: async () => null }) },
          Route: { update },
        },
      },
    };
    const service = new RouteProgressService({
      client: { transaction: async (fn: any) => fn(tx) },
    } as unknown as PrismaService);
    await expect(
      service.fail('route', 'stop', 'actor', dto),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });
  it('rejects profile ownership lost while acquiring the driver lock', async () => {
    const tx = {
      orm: {
        public: {
          Driver: {
            where: () => ({
              first: async () => ({ id: 'driver' }),
              update: async () => null,
            }),
          },
        },
      },
    };
    const service = new RouteProgressService({
      client: { transaction: async (fn: any) => fn(tx) },
    } as unknown as PrismaService);
    await expect(service.complete('route', 'actor')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('rejects unresolved completion without writing completion audit', async () => {
    const route = {
      id: 'route',
      driverId: 'driver',
      status: 'IN_PROGRESS',
      startedAt: {},
      startedById: 'actor',
    };
    const model = (value: unknown) => ({
      where: () => ({
        first: async () => value,
        update: async () => value,
        all: async () => [value],
      }),
    });
    const tx = {
      orm: {
        public: {
          Driver: model({ id: 'driver', userId: 'actor' }),
          Route: model(route),
          DriverReservation: model({ reservedAt: {} }),
          RouteStop: model({
            isLegacy: false,
            sequence: 1,
            outcome: 'PENDING',
          }),
          OrderClaim: model({ claimedAt: {} }),
        },
      },
    };
    const service = new RouteProgressService({
      client: { transaction: async (fn: any) => fn(tx) },
    } as unknown as PrismaService);
    await expect(service.complete('route', 'actor')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('Route progress transactional decisions', () => {
  let rows: Record<string, any[]>;
  let service: RouteProgressService;
  const dto = {
    reason: FailedVisitReason.RECIPIENT_REFUSED,
    context: 'Exact context',
    requestId: 'request',
  };
  beforeEach(() => {
    rows = {
      Driver: [{ id: 'driver', userId: 'actor', isAvailable: false }],
      Route: [
        {
          id: 'route',
          driverId: 'driver',
          zoneId: 'zone',
          status: 'IN_PROGRESS',
          startedAt: Temporal.Now.instant(),
          startedById: 'actor',
        },
      ],
      RouteStop: [
        {
          id: 'stop',
          routeId: 'route',
          orderId: 'order',
          sequence: 1,
          isLegacy: false,
          outcome: 'PENDING',
        },
      ],
      Order: [
        {
          id: 'order',
          routeId: 'route',
          zoneId: 'zone',
          status: 'ASSIGNED',
          requiresAdministrativeReview: false,
        },
      ],
      OrderClaim: [
        {
          id: 'claim',
          routeId: 'route',
          orderId: 'order',
          claimedAt: Temporal.Now.instant(),
          releasedAt: null,
        },
      ],
      DriverReservation: [
        {
          id: 'reservation',
          routeId: 'route',
          driverId: 'driver',
          reservedAt: Temporal.Now.instant(),
          releasedAt: null,
        },
      ],
      DeliveryAttempt: [],
    };
    const model = (name: string) => ({
      where: (filter: Record<string, unknown>) => {
        const matches = () =>
          rows[name].filter((row) =>
            Object.entries(filter).every(([key, value]) => row[key] === value),
          );
        return {
          first: async () => matches()[0] ?? null,
          all: async () => matches(),
          update: async (data: object) => {
            const row = matches()[0];
            return row ? Object.assign(row, data) : null;
          },
        };
      },
      create: async (data: object) => {
        const row = { id: 'attempt', ...data };
        rows[name].push(row);
        return row;
      },
    });
    const tx = {
      orm: {
        public: Object.fromEntries(
          Object.keys(rows).map((name) => [name, model(name)]),
        ),
      },
    };
    service = new RouteProgressService({
      client: { transaction: async (fn: any) => fn(tx) },
    } as unknown as PrismaService);
  });
  it('moves an assigned order into transit and replays that transition', async () => {
    const first = await service.updateOrder(
      'order',
      'actor',
      OrderStatus.IN_TRANSIT,
    );

    expect(first).toMatchObject({ status: OrderStatus.IN_TRANSIT });
    expect(rows.RouteStop[0].outcome).toBe('PENDING');
    expect(rows.DeliveryAttempt).toHaveLength(0);
    await expect(
      service.updateOrder('order', 'actor', OrderStatus.IN_TRANSIT),
    ).resolves.toEqual(first);
    expect(rows.DeliveryAttempt).toHaveLength(0);
  });
  it('records successful delivery and resolves its pending stop', async () => {
    await service.updateOrder('order', 'actor', OrderStatus.IN_TRANSIT);
    const delivered = await service.updateOrder(
      'order',
      'actor',
      OrderStatus.DELIVERED,
    );

    expect(delivered).toMatchObject({ status: OrderStatus.DELIVERED });
    expect(rows.RouteStop[0].outcome).toBe('SUCCESSFUL');
    expect(rows.DeliveryAttempt).toHaveLength(1);
    expect(rows.DeliveryAttempt[0]).toMatchObject({
      outcome: 'SUCCESSFUL',
      failureReason: null,
      idempotencyKey: 'delivery:stop',
    });
    expect(rows.Route[0].status).toBe('IN_PROGRESS');
    expect(rows.OrderClaim[0].releasedAt).toBeNull();
    expect(rows.DriverReservation[0].releasedAt).toBeNull();
  });
  it('rejects driver cancellation without changing the order', async () => {
    await expect(
      service.updateOrder('order', 'actor', OrderStatus.CANCELLED),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(rows.Order[0].status).toBe('ASSIGNED');
    expect(rows.RouteStop[0].outcome).toBe('PENDING');
    expect(rows.DeliveryAttempt).toHaveLength(0);
  });
  it('rejects ownership observed without successfully acquiring the route lock', async () => {
    const route = Object.assign(rows.Route[0], {
      status: 'COMPLETED',
      completedAt: Temporal.Now.instant(),
      completedById: 'actor',
    });
    const tx = {
      orm: {
        public: {
          Driver: {
            where: () => ({
              first: async () => rows.Driver[0],
              update: async () => rows.Driver[0],
            }),
          },
          Route: {
            where: () => ({
              first: async () => route,
              update: async () => null,
            }),
          },
        },
      },
    };
    const raced = new RouteProgressService({
      client: { transaction: async (fn: any) => fn(tx) },
    } as unknown as PrismaService);
    await expect(raced.complete('route', 'actor')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  it.each([null, 'DRAFT', 'ASSIGNED', 'COMPLETED'])(
    'rejects a new failure from lifecycle %s',
    async (status) => {
      rows.Route[0].status = status;
      await expect(
        service.fail('route', 'stop', 'actor', dto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(rows.DeliveryAttempt).toHaveLength(0);
    },
  );
  it.each(['claim', 'reservation', 'legacy', 'audit', 'review'])(
    'rejects missing operational evidence: %s',
    async (defect) => {
      if (defect === 'claim') rows.OrderClaim = [];
      if (defect === 'reservation') rows.DriverReservation = [];
      if (defect === 'legacy') rows.RouteStop[0].isLegacy = true;
      if (defect === 'audit') rows.Route[0].startedAt = null;
      if (defect === 'review')
        rows.Order[0].requiresAdministrativeReview = true;
      await expect(
        service.fail('route', 'stop', 'actor', dto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(rows.DeliveryAttempt).toHaveLength(0);
    },
  );
  it('persists failure once, compares reordered payload structurally and replays after closure', async () => {
    const first = await service.fail('route', 'stop', 'actor', dto);
    rows.DeliveryAttempt[0].requestPayload = {
      context: dto.context,
      reason: dto.reason,
      actorId: 'actor',
    };
    await expect(service.fail('route', 'stop', 'actor', dto)).resolves.toEqual(
      first,
    );
    const closed = await service.complete('route', 'actor');
    await expect(service.complete('route', 'actor')).resolves.toEqual(closed);
    await expect(service.fail('route', 'stop', 'actor', dto)).resolves.toEqual(
      first,
    );
    await expect(
      service.fail('route', 'stop', 'actor', { ...dto, context: 'Changed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(rows.DeliveryAttempt).toHaveLength(1);
    expect(rows.Order[0]).toMatchObject({
      status: 'ASSIGNED',
      requiresAdministrativeReview: true,
    });
    expect(rows.DriverReservation[0].releasedAt).toBeNull();
    expect(rows.Driver[0].isAvailable).toBe(false);
    expect(rows.OrderClaim[0].releasedAt).not.toBeNull();
  });
  it('rejects completion when attempt identity does not match the resolved visit', async () => {
    await service.fail('route', 'stop', 'actor', dto);
    rows.DeliveryAttempt[0].driverId = 'other-driver';
    await expect(service.complete('route', 'actor')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(rows.Route[0].completedAt).toBeUndefined();
    expect(rows.OrderClaim[0].releasedAt).toBeNull();
  });
  it.each(['payload', 'context', 'timestamp'])(
    'rejects malformed canonical attempt %s',
    async (defect) => {
      await service.fail('route', 'stop', 'actor', dto);
      if (defect === 'payload')
        rows.DeliveryAttempt[0].requestPayload.actorId = 'other';
      if (defect === 'context') rows.DeliveryAttempt[0].context = {};
      if (defect === 'timestamp')
        rows.DeliveryAttempt[0].recordedAt = Temporal.Instant.from(
          '2000-01-01T00:00:00Z',
        );
      await expect(service.complete('route', 'actor')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(rows.OrderClaim[0].releasedAt).toBeNull();
    },
  );
  it('rejects an empty route even when no claims remain', async () => {
    rows.RouteStop = [];
    rows.OrderClaim = [];
    await expect(service.complete('route', 'actor')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  it('blocks administrative cancellation with stable operational history', async () => {
    await expect(service.cancelOrder('order')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(rows.Order[0].status).toBe('ASSIGNED');
  });
  it('preserves administrative cancellation for an unassociated pending order', async () => {
    rows.Order[0].routeId = null;
    rows.Order[0].status = 'PENDING';
    rows.RouteStop = [];
    rows.OrderClaim = [];
    await expect(service.cancelOrder('order')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });
});

describe('Cancellation identity lock before claim and history validation', () => {
  it('locks even a pointerless PENDING order and rejects a newly visible DRAFT claim', async () => {
    const order = { id: 'order', routeId: null, status: 'PENDING' };
    const calls: string[] = [];
    const update = jest.fn(async (data) => {
      calls.push('lock');
      expect(data).toEqual({ id: 'order' });
      return order;
    });
    const tx = {
      orm: {
        public: {
          Order: {
            where: () => ({
              first: async () => {
                calls.push('read');
                return order;
              },
              update,
            }),
          },
          OrderClaim: {
            where: () => ({
              first: async () => {
                calls.push('claim');
                return { routeId: 'draft' };
              },
            }),
          },
          RouteStop: { where: () => ({ all: async () => [] }) },
        },
      },
    };
    const service = new RouteProgressService({
      client: { transaction: async (fn: any) => fn(tx) },
    } as unknown as PrismaService);
    await expect(service.cancelOrder('order')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(calls).toEqual(['read', 'lock', 'read', 'claim']);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
