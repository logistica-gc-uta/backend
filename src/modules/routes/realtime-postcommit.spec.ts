import { OrderStatus } from '../orders/dto/update-order-status.dto.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DispatchInterventionService } from './dispatch-intervention.service.js';
import { RouteAssignmentService } from './route-assignment.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { RouteExecutionService } from './route-execution.service.js';
import { RouteProgressService } from './route-progress.service.js';
import { RouteReturnService } from './route-return.service.js';
import { FailedVisitReason } from './dto/record-failed-visit.dto.js';

const instant = Temporal.Instant.from('2026-10-10T12:00:00Z');

type Rows = Record<string, Record<string, any>[]>;

function database(rows: Rows, onCallbackComplete?: () => Promise<void>) {
  let nextId = 0;
  const models = Object.fromEntries(
    Object.keys(rows).map((name) => {
      const query = (filter: Record<string, unknown> = {}) => {
        const matching = () =>
          rows[name].filter((row) =>
            Object.entries(filter).every(([key, value]) => row[key] === value),
          );
        return {
          first: async () => matching()[0] ?? null,
          all: async () => matching(),
          update: async (change: Record<string, unknown>) => {
            const row = matching()[0];
            return row ? Object.assign(row, change) : null;
          },
        };
      };
      return [
        name,
        {
          where: query,
          create: async (value: Record<string, unknown>) => {
            const row = {
              id: `${name.toLowerCase()}-${++nextId}`,
              ...(name === 'Route' ? { createdAt: instant } : {}),
              ...value,
            };
            rows[name].push(row);
            return row;
          },
        },
      ];
    }),
  );
  const tx = {
    orm: { public: models },
    query: async () => [{ instant: Temporal.Now.instant() }],
  };
  const client = {
    raw: {
      sql: () => ({ returnsRow: () => ({ build: () => ({}) }) }),
    },
    transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      await onCallbackComplete?.();
      return result;
    },
  };
  return { client, tx };
}

function commitLatch() {
  let callbackFinished!: () => void;
  let commit!: () => void;
  let rejectCommit!: (error: Error) => void;
  const callbackDone = new Promise<void>((resolve) => {
    callbackFinished = resolve;
  });
  const pendingCommit = new Promise<void>((resolve, reject) => {
    commit = resolve;
    rejectCommit = reject;
  });
  return {
    callbackDone,
    finishCallback: callbackFinished,
    pendingCommit,
    commit,
    rejectCommit,
  };
}

function publisher() {
  return { publish: jest.fn().mockResolvedValue(undefined) };
}

describe('post-commit realtime producers', () => {
  it('publishes a route start only after the outer transaction commits', async () => {
    const route = {
      id: 'route',
      driverId: 'driver',
      zoneId: 'zone',
      status: 'ASSIGNED',
      startedAt: null,
      startedById: null,
      completedAt: null,
      returnedAt: null,
    };
    const rows: Rows = {
      Driver: [{ id: 'driver', userId: 'actor' }],
      Route: [route],
      DriverReservation: [
        { id: 'reservation', driverId: 'driver', routeId: 'route', reservedAt: instant, releasedAt: null },
      ],
      RouteStop: [
        { id: 'stop', routeId: 'route', orderId: 'order', sequence: 1, outcome: 'PENDING', isLegacy: false },
      ],
      OrderClaim: [
        { id: 'claim', routeId: 'route', orderId: 'order', claimedAt: instant, releasedAt: null },
      ],
      Order: [
        { id: 'order', zoneId: 'zone', routeId: 'route', status: 'ASSIGNED', requiresAdministrativeReview: false },
      ],
    };
    const latch = commitLatch();
    const { client } = database(rows, async () => {
      latch.finishCallback();
      await latch.pendingCommit;
    });
    const events = publisher();
    const service = new RouteExecutionService(
      { client } as unknown as PrismaService,
      events,
    );

    const operation = service.start('route', 'actor');
    await latch.callbackDone;
    expect(events.publish).not.toHaveBeenCalled();
    latch.commit();
    await expect(operation).resolves.toMatchObject({ status: 'IN_PROGRESS' });
    expect(events.publish).toHaveBeenCalledWith([
      { type: 'route.updated', routeId: 'route', status: 'IN_PROGRESS' },
    ]);
  });

  it('publishes nothing when commit rejects after the transaction callback succeeds', async () => {
    const rows: Rows = {
      Driver: [{ id: 'driver', userId: 'actor' }],
      Route: [{ id: 'route', driverId: 'driver', zoneId: 'zone', status: 'ASSIGNED', startedAt: null, startedById: null, completedAt: null, returnedAt: null }],
      DriverReservation: [{ id: 'reservation', driverId: 'driver', routeId: 'route', reservedAt: instant, releasedAt: null }],
      RouteStop: [{ id: 'stop', routeId: 'route', orderId: 'order', sequence: 1, outcome: 'PENDING', isLegacy: false }],
      OrderClaim: [{ id: 'claim', routeId: 'route', orderId: 'order', claimedAt: instant, releasedAt: null }],
      Order: [{ id: 'order', zoneId: 'zone', routeId: 'route', status: 'ASSIGNED', requiresAdministrativeReview: false }],
    };
    const latch = commitLatch();
    const { client } = database(rows, async () => {
      latch.finishCallback();
      await latch.pendingCommit;
    });
    const events = publisher();
    const service = new RouteExecutionService(
      { client } as unknown as PrismaService,
      events,
    );

    const operation = service.start('route', 'actor');
    await latch.callbackDone;
    latch.rejectCommit(new Error('commit failed'));
    await expect(operation).rejects.toThrow('commit failed');
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('publishes nothing for a rejected route transition', async () => {
    const rows: Rows = {
      Driver: [{ id: 'driver', userId: 'actor' }],
      Route: [{ id: 'route', driverId: 'driver', status: 'DRAFT' }],
      DriverReservation: [],
      RouteStop: [],
      OrderClaim: [],
      Order: [],
    };
    const { client } = database(rows);
    const events = publisher();
    const service = new RouteExecutionService(
      { client } as unknown as PrismaService,
      events,
    );

    await expect(service.start('route', 'actor')).rejects.toThrow();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('publishes a failed visit once, including review hold, and not on exact replay', async () => {
    const rows: Rows = {
      Driver: [{ id: 'driver', userId: 'actor' }],
      Route: [
        { id: 'route', driverId: 'driver', status: 'IN_PROGRESS', startedAt: instant, startedById: 'actor', completedAt: null, returnedAt: null },
      ],
      RouteStop: [
        { id: 'stop', routeId: 'route', orderId: 'order', sequence: 1, outcome: 'PENDING', isLegacy: false },
      ],
      OrderClaim: [
        { id: 'claim', routeId: 'route', orderId: 'order', claimedAt: instant, releasedAt: null },
      ],
      DriverReservation: [
        { id: 'reservation', driverId: 'driver', routeId: 'route', reservedAt: instant, releasedAt: null },
      ],
      Order: [
        { id: 'order', routeId: 'route', status: 'ASSIGNED', requiresAdministrativeReview: false },
      ],
      DeliveryAttempt: [],
    };
    const { client } = database(rows);
    const events = publisher();
    const service = new RouteProgressService(
      { client } as unknown as PrismaService,
      events,
    );
    const request = {
      reason: FailedVisitReason.RECIPIENT_ABSENT,
      context: 'Recipient unavailable',
      requestId: 'request',
    };

    await service.fail('route', 'stop', 'actor', request);
    await service.fail('route', 'stop', 'actor', request);

    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith([
      { type: 'order.status.updated', orderId: 'order', status: 'ASSIGNED', requiresAdministrativeReview: true },
      { type: 'dispatch.incident.updated', orderId: 'order', requiresAdministrativeReview: true },
    ]);
    expect(rows.DeliveryAttempt).toHaveLength(1);
  });

  it('publishes successful delivery once and preserves the order response on replay', async () => {
    const rows: Rows = {
      Driver: [{ id: 'driver', userId: 'actor' }],
      Route: [{ id: 'route', driverId: 'driver', status: 'IN_PROGRESS', startedAt: instant, startedById: 'actor', completedAt: null, returnedAt: null }],
      RouteStop: [{ id: 'stop', routeId: 'route', orderId: 'order', sequence: 1, outcome: 'PENDING', isLegacy: false }],
      OrderClaim: [{ id: 'claim', routeId: 'route', orderId: 'order', claimedAt: instant, releasedAt: null }],
      DriverReservation: [{ id: 'reservation', driverId: 'driver', routeId: 'route', reservedAt: instant, releasedAt: null }],
      Order: [{ id: 'order', routeId: 'route', status: 'IN_TRANSIT', requiresAdministrativeReview: false }],
      DeliveryAttempt: [],
    };
    const { client } = database(rows);
    const events = publisher();
    const service = new RouteProgressService(
      { client } as unknown as PrismaService,
      events,
    );

    const result = await service.updateOrder('order', 'actor', OrderStatus.DELIVERED);
    await expect(service.updateOrder('order', 'actor', OrderStatus.DELIVERED)).resolves.toEqual(result);

    expect(result.status).toBe(OrderStatus.DELIVERED);
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith([
      { type: 'order.status.updated', orderId: 'order', status: 'DELIVERED' },
    ]);
  });

  it('publishes administrative cancellation only after the order transaction succeeds', async () => {
    const rows: Rows = {
      Order: [{ id: 'order', routeId: null, status: 'PENDING', requiresAdministrativeReview: false }],
      OrderClaim: [],
      RouteStop: [],
    };
    const { client } = database(rows);
    const events = publisher();
    const service = new RouteProgressService(
      { client } as unknown as PrismaService,
      events,
    );

    const result = await service.cancelOrder('order');

    expect(result.status).toBe('CANCELLED');
    expect(events.publish).toHaveBeenCalledWith([
      { type: 'order.status.updated', orderId: 'order', status: 'CANCELLED' },
    ]);
  });

  it('does not advertise driver availability when a route completes', async () => {
    const rows: Rows = {
      Driver: [{ id: 'driver', userId: 'actor' }],
      Route: [
        { id: 'route', driverId: 'driver', zoneId: 'zone', status: 'IN_PROGRESS', startedAt: instant, startedById: 'actor', completedAt: null, completedById: null, returnedAt: null },
      ],
      DriverReservation: [
        { id: 'reservation', driverId: 'driver', routeId: 'route', reservedAt: instant, releasedAt: null },
      ],
      RouteStop: [
        { id: 'stop', routeId: 'route', orderId: 'order', sequence: 1, outcome: 'SUCCESSFUL', isLegacy: false },
      ],
      OrderClaim: [
        { id: 'claim', routeId: 'route', orderId: 'order', claimedAt: instant, releasedAt: null },
      ],
      DeliveryAttempt: [
        { id: 'attempt', stopId: 'stop', driverId: 'driver', recordedAt: instant, outcome: 'SUCCESSFUL', failureReason: null, context: {}, idempotencyKey: 'delivery:stop', requestPayload: { actorId: 'actor', status: OrderStatus.DELIVERED } },
      ],
      Order: [
        { id: 'order', routeId: 'route', zoneId: 'zone', status: 'DELIVERED', requiresAdministrativeReview: false },
      ],
    };
    const { client } = database(rows);
    const events = publisher();
    const service = new RouteProgressService(
      { client } as unknown as PrismaService,
      events,
    );

    await service.complete('route', 'actor');

    expect(events.publish).toHaveBeenCalledWith([
      { type: 'route.updated', routeId: 'route', status: 'COMPLETED' },
    ]);
    expect(events.publish.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ type: 'driver.availability.updated' }),
    );
  });

  it('publishes actual computed availability only after confirmed depot return', async () => {
    const rows: Rows = {
      Driver: [{ id: 'driver', userId: 'actor', isAvailable: false }],
      Route: [
        { id: 'route', driverId: 'driver', status: 'COMPLETED', startedAt: instant, startedById: 'actor', completedAt: instant, completedById: 'actor', returnedAt: null, returnedById: null },
      ],
      DriverReservation: [
        { id: 'reservation', driverId: 'driver', routeId: 'route', reservedAt: instant, releasedAt: null },
      ],
    };
    const { client } = database(rows);
    const events = publisher();
    const availability = {
      effective: jest.fn(async () => ({ isAvailable: false })),
      recomputeProjection: jest.fn(async () => ({ isAvailable: false })),
    };
    const service = new RouteReturnService(
      { client } as unknown as PrismaService,
      availability as unknown as RouteAvailabilityService,
      events,
    );

    await service.returnToDepot('route', 'actor');
    await service.returnToDepot('route', 'actor');

    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith([
      { type: 'route.updated', routeId: 'route', status: 'COMPLETED' },
      { type: 'driver.availability.updated', driverId: 'driver', available: false },
    ]);
  });

  it('publishes ADMIN contact and reschedule invalidations with persisted status only', async () => {
    const rows: Rows = {
      User: [{ id: 'admin', role: 'ADMIN' }],
      Order: [{ id: 'order', userId: 'client', zoneId: 'zone', routeId: null, status: 'PENDING', requiresAdministrativeReview: false, deliveryLat: -1.25, deliveryLng: -78.62 }],
      Zone: [{ id: 'zone', depotLat: -1.24, depotLng: -78.61 }],
      Route: [],
      RouteStop: [],
      DeliveryAttempt: [],
      OrderClaim: [],
      DispatchIntervention: [],
    };
    const { client } = database(rows);
    const events = publisher();
    const prisma = { client } as unknown as PrismaService;
    const availability = new RouteAvailabilityService(prisma);
    const assignment = new RouteAssignmentService(prisma, availability, events);
    const service = new DispatchInterventionService(
      prisma,
      assignment,
      availability,
      { propose: jest.fn() } as never,
      events,
    );
    const scheduledAt = Temporal.Now.instant().add({ hours: 48 });
    const contact = await service.intervene(
      {
        requestId: 'contact',
        action: 'CONTACT',
        orderId: 'order',
        reason: 'Agreement recorded',
        agreementConfirmed: true,
        scheduledDeliveryDate: scheduledAt.toString(),
        deliveryWindowStart: scheduledAt.subtract({ minutes: 10 }).toString(),
        deliveryWindowEnd: scheduledAt.add({ minutes: 10 }).toString(),
      },
      'admin',
    );
    const rescheduled = await service.intervene(
      {
        requestId: 'reschedule',
        action: 'RESCHEDULE',
        orderId: 'order',
        agreementId: contact.id,
        reason: 'Agreed new delivery time',
      },
      'admin',
    );

    expect(rescheduled.action).toBe('RESCHEDULE');
    expect(events.publish).toHaveBeenNthCalledWith(1, [
      { type: 'dispatch.incident.updated', orderId: 'order', action: 'CONTACT', requiresAdministrativeReview: false },
    ]);
    expect(events.publish).toHaveBeenNthCalledWith(2, [
      { type: 'order.status.updated', orderId: 'order', status: 'PENDING', requiresAdministrativeReview: false },
      { type: 'dispatch.incident.updated', orderId: 'order', action: 'RESCHEDULE', requiresAdministrativeReview: false },
    ]);
  });

  it('publishes ADMIN decision invalidations after commit and never replays them twice', async () => {
    const rows: Rows = {
      User: [{ id: 'admin', role: 'ADMIN' }],
      Driver: [],
      Route: [],
      Order: [{ id: 'order', status: 'PENDING', requiresAdministrativeReview: false }],
      OrderClaim: [],
      DispatchIntervention: [],
    };
    const latch = commitLatch();
    const { client } = database(rows, async () => {
      latch.finishCallback();
      await latch.pendingCommit;
    });
    const events = publisher();
    const prisma = { client } as unknown as PrismaService;
    const availability = new RouteAvailabilityService(prisma);
    const assignment = new RouteAssignmentService(prisma, availability, events);
    const service = new DispatchInterventionService(
      prisma,
      assignment,
      availability,
      { propose: jest.fn() } as never,
      events,
    );
    const decision = {
      requestId: 'decision',
      action: 'PRIORITIZE' as const,
      orderId: 'order',
      reason: 'Urgent delivery',
    };

    const operation = service.intervene(decision, 'admin');
    await latch.callbackDone;
    expect(events.publish).not.toHaveBeenCalled();
    latch.commit();
    const result = await operation;
    await service.intervene(decision, 'admin');

    expect(result.action).toBe('PRIORITIZE');
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith([
      { type: 'dispatch.incident.updated', orderId: 'order', action: 'PRIORITIZE' },
    ]);
  });

  it('publishes assignment route and order state without early availability', async () => {
    const rows: Rows = {
      User: [
        { id: 'admin', role: 'ADMIN' },
        { id: 'driver-user', role: 'DRIVER' },
      ],
      Driver: [{ id: 'driver', userId: 'driver-user', isAvailable: true }],
      Route: [{ id: 'route', status: 'DRAFT', driverId: null, zoneId: 'zone', date: instant, createdAt: instant }],
      RouteStop: [{ id: 'stop', routeId: 'route', orderId: 'order', sequence: 1, outcome: 'PENDING', isLegacy: false }],
      OrderClaim: [{ id: 'claim', routeId: 'route', orderId: 'order', claimedAt: instant, releasedAt: null }],
      DriverReservation: [],
      Order: [{ id: 'order', zoneId: 'zone', routeId: null, status: 'PENDING', requiresAdministrativeReview: false, scheduledDeliveryDate: instant }],
    };
    const { client } = database(rows);
    const events = publisher();
    const prisma = { client } as unknown as PrismaService;
    const availability = {
      effective: jest.fn(async () => ({ isAvailable: true })),
    } as unknown as RouteAvailabilityService;
    const service = new RouteAssignmentService(prisma, availability, events);

    const result = await service.assignDraft(
      'route',
      { driverId: 'driver' },
      'admin',
    );

    expect(result).toMatchObject({ id: 'route', status: 'ASSIGNED' });
    expect(rows.Order[0]).toMatchObject({ status: 'ASSIGNED', routeId: 'route' });
    expect(events.publish).toHaveBeenCalledWith([
      { type: 'order.status.updated', orderId: 'order', status: 'ASSIGNED' },
      { type: 'route.updated', routeId: 'route', status: 'ASSIGNED' },
    ]);
    expect(events.publish.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ type: 'driver.availability.updated' }),
    );
  });

  it('publishes a draft route created through the public assignment method', async () => {
    const rows: Rows = {
      User: [{ id: 'admin', role: 'ADMIN' }],
      Zone: [{ id: 'zone' }],
      Route: [],
      Order: [{ id: 'order', zoneId: 'zone', status: 'PENDING', requiresAdministrativeReview: false, scheduledDeliveryDate: instant }],
      OrderClaim: [],
      RouteStop: [],
    };
    const { client } = database(rows);
    const events = publisher();
    const prisma = { client } as unknown as PrismaService;
    const service = new RouteAssignmentService(
      prisma,
      new RouteAvailabilityService(prisma),
      events,
    );

    const result = await service.confirmDraft(
      { zoneId: 'zone', routeDate: instant.toString(), orderIds: ['order'] },
      'admin',
    );

    expect(result.status).toBe('DRAFT');
    expect(events.publish).toHaveBeenCalledWith([
      { type: 'route.updated', routeId: result.id, status: 'DRAFT' },
    ]);
  });
});
