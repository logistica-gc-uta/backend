import { ConflictException } from '@nestjs/common';
import { DispatchInterventionService } from './dispatch-intervention.service.js';
import { RouteAssignmentService } from './route-assignment.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { nowInstant } from '../../common/temporal.util.js';
import type { DispatchInterventionDto } from './dto/dispatch-intervention.dto.js';

// Unit adapters exercise the public services. Real PostgreSQL guards and rollback
// are tested separately through JWT HTTP in urgent-dispatch.e2e-spec.ts.
describe('ADMIN dispatch services: decisions, replay, schedule and central invariants', () => {
  let rows: Record<string, any[]>;
  let service: DispatchInterventionService;
  let assignment: RouteAssignmentService;
  let availability: RouteAvailabilityService;
  let propose: jest.Mock;
  let counter: number;
  let clock: Temporal.Instant;
  const currentOrder = (id = 'urgent', extra = {}) => ({
    id,
    userId: 'client',
    zoneId: 'zone',
    status: 'PENDING',
    requiresAdministrativeReview: false,
    routeId: null,
    stopOrder: null,
    scheduledDeliveryDate: nowInstant(),
    deliveryLat: -1.25,
    deliveryLng: -78.62,
    ...extra,
  });
  const call = (body: Record<string, unknown>, actor = 'admin') =>
    service.intervene(
      {
        requestId: 'request-' + ++counter,
        reason: 'Administrative reason',
        ...body,
      } as DispatchInterventionDto,
      actor,
    );
  const insert = () => ({
    kind: 'INSERT',
    orderId: 'urgent',
    routeId: 'route',
    zoneId: 'zone',
    routeDate: rows.Route![0].date.toString(),
    orderIds: ['old', 'urgent'],
    availableDriverIds: [],
    fingerprint: 'fp',
  });
  const departure = () => ({
    kind: 'NEW_ROUTE',
    orderId: 'urgent',
    routeId: null,
    zoneId: 'zone',
    routeDate: rows.Order![0].scheduledDeliveryDate.toString(),
    orderIds: ['urgent'],
    availableDriverIds: ['driver', 'replacement'],
    fingerprint: 'fp',
  });
  const baseRoute = (status = 'DRAFT', count = 1, id = 'route') => {
    rows.Route!.push({
      id,
      status,
      driverId: status === 'DRAFT' ? null : 'driver',
      zoneId: 'zone',
      date: nowInstant(),
      createdAt: nowInstant(),
    });
    for (let i = 0; i < count; i++) {
      const orderId =
        id === 'route' ? (i === 0 ? 'old' : 'old' + i) : id + '-order' + i;
      rows.Order!.push(
        currentOrder(orderId, {
          status: status === 'DRAFT' ? 'PENDING' : 'ASSIGNED',
          routeId: status === 'DRAFT' ? null : id,
        }),
      );
      rows.RouteStop!.push({
        id: id + '-stop' + i,
        routeId: id,
        orderId,
        sequence: i + 1,
        outcome: 'PENDING',
        isLegacy: false,
        createdAt: nowInstant(),
      });
      rows.OrderClaim!.push({
        id: id + '-claim' + i,
        routeId: id,
        orderId,
        claimedAt: nowInstant(),
        releasedAt: null,
      });
    }
    if (status !== 'DRAFT') {
      rows.Driver![0].isAvailable = false;
      rows.DriverReservation!.push({
        id: 'reservation-' + id,
        driverId: 'driver',
        routeId: id,
        reservedAt: nowInstant(),
        releasedAt: null,
      });
    }
  };
  const failed = (status = 'COMPLETED') => {
    baseRoute(status);
    rows.Order![0].requiresAdministrativeReview = true;
    rows.Order![0].status = 'ASSIGNED';
    rows.Order![0].routeId = 'route';
    rows.RouteStop![0].orderId = 'urgent';
    rows.RouteStop![0].outcome = 'FAILED';
    rows.OrderClaim =
      status === 'COMPLETED'
        ? []
        : [
            {
              id: 'claim',
              orderId: 'urgent',
              routeId: 'route',
              claimedAt: nowInstant(),
              releasedAt: null,
            },
          ];
    rows.DeliveryAttempt!.push({
      id: 'failure',
      stopId: 'route-stop0',
      outcome: 'FAILED',
      recordedAt: nowInstant(),
      failureReason: 'RECIPIENT_ABSENT',
    });
  };
  const agreement = (extra: Record<string, unknown> = {}) => {
    const time = nowInstant().add({ minutes: 60 });
    return {
      action: 'CONTACT',
      orderId: 'urgent',
      agreementConfirmed: true,
      scheduledDeliveryDate: time.toString(),
      deliveryWindowStart: time.subtract({ minutes: 10 }).toString(),
      deliveryWindowEnd: time.add({ minutes: 10 }).toString(),
      ...extra,
    };
  };
  beforeEach(() => {
    counter = 0;
    clock = nowInstant();
    rows = {
      User: [
        { id: 'admin', role: 'ADMIN' },
        { id: 'admin2', role: 'ADMIN' },
        { id: 'driver-user', role: 'DRIVER' },
        { id: 'replacement-user', role: 'DRIVER' },
      ],
      Driver: [
        { id: 'driver', userId: 'driver-user', isAvailable: true },
        { id: 'replacement', userId: 'replacement-user', isAvailable: true },
      ],
      Zone: [{ id: 'zone', depotLat: -1.24, depotLng: -78.61 }],
      Order: [currentOrder()],
      Route: [],
      RouteStop: [],
      OrderClaim: [],
      DriverReservation: [],
      DeliveryAttempt: [],
      DispatchIntervention: [],
      LegacyRouteReconciliation: [],
    };
    const models = Object.fromEntries(
      Object.keys(rows).map((name) => {
        const query = (filter: Record<string, unknown> = {}) => {
          const matching = () =>
            rows[name]!.filter((r) =>
              Object.entries(filter).every(([k, v]) => r[k] === v),
            );
          const chain: any = {
            where: (next: Record<string, unknown>) =>
              query({ ...filter, ...next }),
            orderBy: () => chain,
            all: async () => matching().map((r) => ({ ...r })),
            first: async () => (matching()[0] ? { ...matching()[0] } : null),
            update: async (change: Record<string, unknown>) => {
              const row = matching()[0];
              return row ? { ...Object.assign(row, change) } : null;
            },
            delete: async () => {
              const found = matching();
              rows[name] = rows[name]!.filter((r) => !found.includes(r));
              return found;
            },
          };
          return chain;
        };
        return [
          name,
          {
            ...query(),
            where: query,
            create: async (input: Record<string, unknown>) => {
              const value = {
                id: name + '-' + ++counter,
                createdAt: nowInstant(),
                recordedAt: nowInstant(),
                claimedAt: null,
                reservedAt: null,
                releasedAt: null,
                ...input,
              };
              rows[name]!.push(value);
              return { ...value };
            },
          },
        ];
      }),
    );
    const tx: any = {
      orm: { public: models },
      query: async () => [{ instant: clock }],
    };
    const client: any = {
      ...tx,
      raw: { sql: () => ({ returnsRow: () => ({ build: () => ({}) }) }) },
      transaction: async (fn: (tx: any) => Promise<unknown>) => {
        const snapshot = Object.fromEntries(
          Object.entries(rows).map(([name, list]) => [
            name,
            list.map((r) => ({ ...r })),
          ]),
        );
        try {
          return await fn(tx);
        } catch (error) {
          rows = snapshot;
          throw error;
        }
      },
    };
    const prisma: any = { client };
    availability = new RouteAvailabilityService(prisma);
    assignment = new RouteAssignmentService(prisma, availability);
    propose = jest.fn();
    service = new DispatchInterventionService(
      prisma,
      assignment,
      availability,
      { propose } as any,
    );
  });
  it.each(['DRAFT', 'ASSIGNED'])(
    'confirms fourth-order insertion using central %s invariants and audits JWT actor',
    async (status) => {
      baseRoute(status);
      propose.mockResolvedValue(insert());
      const result = await call({
        action: 'CONFIRM',
        orderId: 'urgent',
        fingerprint: 'fp',
      });
      expect(result.actorId).toBe('admin');
      expect(result.action).toBe('CONFIRM');
      expect(result.outcome).toBe('APPLIED');
      expect(result.result).toEqual({ orderId: 'urgent', routeId: 'route' });
      expect(result.recordedAt).toBeTruthy();
      expect(await service.audit()).toEqual([result]);
    },
  );
  it('atomically creates/assigns a new departure and returns persistent identifiers', async () => {
    propose.mockResolvedValue(departure());
    const result = await call({
      action: 'CONFIRM',
      orderId: 'urgent',
      fingerprint: 'fp',
      driverId: 'driver',
    });
    expect(result.routeId).toBeTruthy();
    expect(result.result).toEqual({
      orderId: 'urgent',
      routeId: result.routeId,
    });
    expect((await availability.effective('driver')).isAvailable).toBe(false);
    expect(await service.audit()).toEqual([result]);
  });
  it('rejects proposal without acquiring a claim and leaves driver available', async () => {
    propose.mockResolvedValue(departure());
    const result = await call({
      action: 'REJECT',
      orderId: 'urgent',
      fingerprint: 'fp',
    });
    expect(result.outcome).toBe('REJECTED');
    expect((await availability.effective('driver')).isAvailable).toBe(true);
    expect(await service.audit()).toEqual([result]);
  });
  it.each([
    [{ kind: 'BLOCKED', orderIds: [] }, {}],
    [{}, { fingerprint: 'stale' }],
    [{}, { driverId: 'driver' }],
  ])(
    'rejects blocked/stale or insertion-driver override without accepted audit: %s',
    async (change, extra) => {
      baseRoute();
      propose.mockResolvedValue({ ...insert(), ...change });
      await expect(
        call({
          action: 'CONFIRM',
          orderId: 'urgent',
          fingerprint: 'fp',
          ...extra,
        }),
      ).rejects.toThrow();
      expect(await service.audit()).toEqual([]);
    },
  );
  it.each([undefined, 'replacement'])(
    'new departure requires a selected available driver (%s)',
    async (driverId) => {
      const p = departure();
      p.availableDriverIds = ['driver'];
      propose.mockResolvedValue(p);
      await expect(
        call({
          action: 'CONFIRM',
          orderId: 'urgent',
          fingerprint: 'fp',
          ...(driverId ? { driverId } : {}),
        }),
      ).rejects.toThrow('New departure requires');
      expect(await service.audit()).toEqual([]);
    },
  );
  it('rolls back a proposed departure when availability revalidation fails', async () => {
    rows.Driver![0].isAvailable = false;
    propose.mockResolvedValue(departure());
    await expect(
      call({
        action: 'CONFIRM',
        orderId: 'urgent',
        fingerprint: 'fp',
        driverId: 'driver',
      }),
    ).rejects.toThrow('Driver has an unresolved');
    expect(await service.audit()).toEqual([]);
  });
  it('replays exactly one audit and rejects different actor/payload on the same key', async () => {
    const body = {
      action: 'PRIORITIZE',
      orderId: 'urgent',
      requestId: 'stable',
    };
    const first = await call(body);
    expect(await call(body)).toEqual(first);
    await expect(call({ ...body, reason: 'changed' })).rejects.toThrow(
      'Idempotency key',
    );
    await expect(call(body, 'admin2')).rejects.toThrow('Idempotency key');
    expect(await service.audit()).toEqual([first]);
  });
  it('never leaks a prior outcome after the actor loses ADMIN', async () => {
    const body = {
      action: 'PRIORITIZE',
      orderId: 'urgent',
      requestId: 'stable',
    };
    const first = await call(body);
    rows.User![0].role = 'CLIENT';
    await expect(call(body)).rejects.toThrow('ADMIN confirmation required');
    expect(await service.audit()).toEqual([first]);
  });
  it.each([
    { action: 'PRIORITIZE' },
    { action: 'PRIORITIZE', orderId: 'urgent', actorId: 'body-actor' },
    { action: 'UNKNOWN', orderId: 'urgent' },
    { action: 'REORDER', routeId: 'route' },
  ])(
    'requires exact action fields and never accepts actor identity: %s',
    async (body) => {
      await expect(call(body)).rejects.toThrow(
        'Action requires its exact resource fields',
      );
      expect(await service.audit()).toEqual([]);
    },
  );
  it.each([
    { status: 'DELIVERED' },
    { requiresAdministrativeReview: true },
    { claim: true },
  ])('holds ineligible priorities: %s', async (change) => {
    Object.assign(rows.Order![0], change);
    if (change.claim)
      rows.OrderClaim!.push({ orderId: 'urgent', releasedAt: null });
    await expect(
      call({ action: 'PRIORITIZE', orderId: 'urgent' }),
    ).rejects.toThrow('Only an eligible');
    expect(await service.audit()).toEqual([]);
  });
  it('returns coherent missing-order and missing-route errors without audit', async () => {
    await expect(
      call({ action: 'PRIORITIZE', orderId: 'missing' }),
    ).rejects.toThrow('Order not found');
    await expect(
      call({ action: 'REORDER', routeId: 'missing', orderIds: ['urgent'] }),
    ).rejects.toThrow('Route not found');
    expect(await service.audit()).toEqual([]);
  });
  it('uses exact pre-start permutations and rejects incomplete/duplicate orders', async () => {
    baseRoute('ASSIGNED', 2);
    const ids = ['old1', 'old'];
    const result = await call({
      action: 'REORDER',
      routeId: 'route',
      orderIds: ids,
    });
    expect(result.action).toBe('REORDER');
    expect(result.routeId).toBe('route');
    await expect(
      call({ action: 'REORDER', routeId: 'route', orderIds: ['old'] }),
    ).rejects.toThrow('Reorder must contain exactly');
    await expect(
      call({ action: 'REORDER', routeId: 'route', orderIds: ['old', 'old'] }),
    ).rejects.toThrow();
    expect(await service.audit()).toEqual([result]);
  });
  it.each(['IN_PROGRESS', 'COMPLETED', null])(
    'freezes administrative structure in %s',
    async (status) => {
      baseRoute();
      rows.Route![0].status = status;
      await expect(
        call({ action: 'REORDER', routeId: 'route', orderIds: ['old'] }),
      ).rejects.toThrow('Route structure is frozen');
      expect(await service.audit()).toEqual([]);
    },
  );
  it('moves between compatible pre-start routes via central claim rules', async () => {
    baseRoute('ASSIGNED', 2);
    baseRoute('DRAFT', 1, 'target');
    const result = await call({
      action: 'MOVE',
      orderId: 'old',
      routeId: 'route',
      targetRouteId: 'target',
    });
    expect(result.result).toEqual({
      orderId: 'old',
      routeId: 'route',
      targetRouteId: 'target',
    });
    expect(await service.audit()).toEqual([result]);
  });
  it.each([
    'same',
    'empty',
    'full',
    'claim',
    'zone',
    'date',
    'legacy',
    'coordinates',
  ])(
    'rejects incompatible MOVE and rolls back accepted counters: %s',
    async (mode) => {
      baseRoute('DRAFT', mode === 'empty' ? 1 : 2);
      baseRoute('DRAFT', mode === 'full' ? 4 : 1, 'target');
      if (mode === 'claim')
        rows.OrderClaim = rows.OrderClaim!.filter((c) => c.orderId !== 'old');
      if (mode === 'zone') rows.Route![1].zoneId = 'different';
      if (mode === 'date')
        rows.Route![1].date = nowInstant().add({ hours: 24 });
      if (mode === 'legacy') rows.RouteStop![0].isLegacy = true;
      if (mode === 'coordinates')
        rows.Order!.find((o) => o.id === 'old')!.deliveryLat = null;
      await expect(
        call({
          action: 'MOVE',
          orderId: 'old',
          routeId: 'route',
          targetRouteId: mode === 'same' ? 'route' : 'target',
        }),
      ).rejects.toThrow();
      expect(await service.audit()).toEqual([]);
    },
  );
  it('switches only an ASSIGNED driver and recomputes availability without a depot-return bypass', async () => {
    baseRoute('ASSIGNED');
    const result = await call({
      action: 'REASSIGN_DRIVER',
      routeId: 'route',
      driverId: 'replacement',
    });
    expect(result.result).toEqual({
      routeId: 'route',
      driverId: 'replacement',
    });
    expect((await availability.effective('driver')).isAvailable).toBe(true);
    expect((await availability.effective('replacement')).isAvailable).toBe(
      false,
    );
    expect(await service.audit()).toEqual([result]);
  });
  it.each(['draft', 'same', 'busy', 'profile', 'reservation'])(
    'rejects invalid driver reassignment: %s',
    async (mode) => {
      baseRoute(mode === 'draft' ? 'DRAFT' : 'ASSIGNED');
      if (mode === 'busy') rows.Driver![1].isAvailable = false;
      if (mode === 'profile') rows.User![3].role = 'CLIENT';
      if (mode === 'reservation') rows.DriverReservation = [];
      await expect(
        call({
          action: 'REASSIGN_DRIVER',
          routeId: 'route',
          driverId: mode === 'same' ? 'driver' : 'replacement',
        }),
      ).rejects.toThrow();
      expect(await service.audit()).toEqual([]);
    },
  );
  it('contacts unresolved failure without agreement and never silently schedules', async () => {
    failed();
    const contact = await call({
      action: 'CONTACT',
      orderId: 'urgent',
      attemptId: 'failure',
      agreementConfirmed: false,
    });
    expect(contact.action).toBe('CONTACT');
    await expect(
      call({
        action: 'RESCHEDULE',
        orderId: 'urgent',
        agreementId: contact.id,
      }),
    ).rejects.toThrow('Persisted explicit date/window agreement');
    expect(await service.audit()).toEqual([contact]);
  });
  it.each([
    'missingBoolean',
    'wrongAttempt',
    'unconfirmedDates',
    'missingWindow',
    'invalidInstant',
    'past',
    'crossDay',
  ])('rejects invalid or unagreed contact without audit: %s', async (mode) => {
    failed();
    const body: Record<string, unknown> = agreement({ attemptId: 'failure' });
    if (mode === 'missingBoolean') delete body.agreementConfirmed;
    if (mode === 'wrongAttempt') body.attemptId = 'stale';
    if (mode === 'unconfirmedDates') body.agreementConfirmed = false;
    if (mode === 'missingWindow') delete body.deliveryWindowStart;
    if (mode === 'invalidInstant')
      body.scheduledDeliveryDate = 'not-an-instant';
    if (mode === 'past') {
      const t = nowInstant().subtract({ hours: 1 });
      Object.assign(body, {
        scheduledDeliveryDate: t.toString(),
        deliveryWindowStart: t.subtract({ minutes: 5 }).toString(),
        deliveryWindowEnd: t.add({ minutes: 5 }).toString(),
      });
    }
    if (mode === 'crossDay')
      body.deliveryWindowEnd = nowInstant().add({ hours: 48 }).toString();
    await expect(call(body)).rejects.toThrow();
    expect(await service.audit()).toEqual([]);
  });
  it('resolves latest failed attempt once using a persisted agreement, preserving return hold and exact replay', async () => {
    failed();
    const contact = await call(agreement({ attemptId: 'failure' }));
    const body = {
      action: 'RESCHEDULE',
      orderId: 'urgent',
      agreementId: contact.id,
      requestId: 'schedule-key',
    };
    const result = await call(body);
    expect(result.result).toEqual(
      expect.objectContaining({
        agreementId: contact.id,
        attemptId: 'failure',
        orderId: 'urgent',
      }),
    );
    expect(await call(body)).toEqual(result);
    await expect(call({ ...body, requestId: 'other-key' })).rejects.toThrow(
      'Failed attempt already administratively resolved',
    );
    expect((await availability.effective('driver')).isAvailable).toBe(false);
    expect(await service.audit()).toEqual([contact, result]);
  });
  it('supports explicit date/window reprogramming of unclaimed PENDING and pre-start reserved orders', async () => {
    const contact = await call(agreement());
    const result = await call({
      action: 'RESCHEDULE',
      orderId: 'urgent',
      agreementId: contact.id,
    });
    expect(result.result).toEqual(
      expect.objectContaining({ orderId: 'urgent', agreementId: contact.id }),
    );
    expect(await service.audit()).toHaveLength(2);
  });
  it('reprograms a reserved pre-start order without leaving an invalid empty route', async () => {
    baseRoute('ASSIGNED', 2);
    const contact = await call(agreement({ orderId: 'old' }));
    const result = await call({
      action: 'RESCHEDULE',
      orderId: 'old',
      agreementId: contact.id,
    });
    expect(result.result).toEqual(
      expect.objectContaining({ orderId: 'old', routeId: 'route' }),
    );
    expect(await service.audit()).toEqual([contact, result]);
  });
  it.each(['IN_PROGRESS', null])(
    'contact may record management but cannot reschedule frozen/unverified execution %s',
    async (status) => {
      failed(status as string);
      rows.Route![0].status = status;
      const contact = await call(agreement({ attemptId: 'failure' }));
      await expect(
        call({
          action: 'RESCHEDULE',
          orderId: 'urgent',
          agreementId: contact.id,
        }),
      ).rejects.toThrow('Route structure is frozen or unverified');
      expect(await service.audit()).toEqual([contact]);
    },
  );
  it.each(['agreement', 'latest', 'claim', 'geography', 'expired'])(
    'revalidates agreement and operational state under locks: %s',
    async (mode) => {
      failed();
      const contact = await call(agreement({ attemptId: 'failure' }));
      if (mode === 'latest')
        rows.DeliveryAttempt!.push({
          id: 'later',
          stopId: 'route-stop0',
          outcome: 'FAILED',
          recordedAt: nowInstant().add({ seconds: 1 }),
        });
      if (mode === 'claim')
        rows.OrderClaim!.push({
          id: 'hold',
          orderId: 'urgent',
          routeId: 'route',
          claimedAt: nowInstant(),
          releasedAt: null,
        });
      if (mode === 'geography') rows.Zone![0].depotLat = null;
      if (mode === 'expired') clock = nowInstant().add({ hours: 4 });
      await expect(
        call({
          action: 'RESCHEDULE',
          orderId: 'urgent',
          agreementId: mode === 'agreement' ? 'missing' : contact.id,
        }),
      ).rejects.toThrow();
      expect(await service.audit()).toEqual([contact]);
    },
  );
  it.each(['DELIVERED', 'CANCELLED'])(
    'never reprograms commercially resolved %s orders',
    async (status) => {
      rows.Order![0].status = status;
      await expect(call(agreement())).rejects.toThrow(
        'Commercially resolved order',
      );
      expect(await service.audit()).toEqual([]);
    },
  );
  it('keeps exact audit count after a fault following central structural writes', async () => {
    baseRoute();
    propose.mockResolvedValue(insert());
    const original = assignment.replaceStops.bind(assignment);
    const spy = jest
      .spyOn(assignment, 'replaceStops')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new ConflictException('Injected rollback');
      });
    try {
      await expect(
        call({ action: 'CONFIRM', orderId: 'urgent', fingerprint: 'fp' }),
      ).rejects.toThrow('Injected rollback');
    } finally {
      spy.mockRestore();
    }
    expect(await service.audit()).toEqual([]);
    expect((await availability.effective('driver')).isAvailable).toBe(true);
  });
});
