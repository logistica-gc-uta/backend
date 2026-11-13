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
    // cerca de la medianoche de Guayaquil la ventana acordada pasa al mediodía del día siguiente
    const zone = 'America/Guayaquil';
    const day = (i: Temporal.Instant) => i.toZonedDateTimeISO(zone).toPlainDate().toString();
    const soon = nowInstant().add({ minutes: 60 });
    const time = day(soon.subtract({ minutes: 20 })) === day(soon.add({ minutes: 20 }))
      ? soon
      : Temporal.Now.zonedDateTimeISO(zone).toPlainDate().add({ days: 1 })
        .toZonedDateTime({ timeZone: zone, plainTime: '12:00' }).toInstant().add({ minutes: 60 });
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
      DriverAbsence: [],
      OrderPickup: [],
      StoreCoverage: [],
      OrderItem: [],
      OrderItemLoss: [],
      RouteEmergency: [],
      RouteUnitRecovery: [],
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
                confirmedAt: null,
                confirmedById: null,
                confirmationRequestId: null,
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

  describe('retiro en tienda acordado (#50)', () => {
    const pickup = (body: Record<string, unknown>, actor = 'admin') => call({ orderId: 'urgent', ...body }, actor);
    const routesBefore = () => rows.Route!.length;

    it('registrar el acuerdo deja el pedido pendiente de retiro, sin crear otra ruta y sin marcarlo entregado', async () => {
      const before = routesBefore();
      const audit = await pickup({ action: 'PICKUP_AGREE' });

      expect(audit).toMatchObject({ action: 'PICKUP_AGREE', outcome: 'APPLIED', actorId: 'admin' });
      expect(rows.Order![0]).toMatchObject({ status: 'PENDING', requiresAdministrativeReview: true, routeId: null });
      expect(rows.OrderPickup).toHaveLength(1);
      expect(rows.OrderPickup![0]).toMatchObject({ orderId: 'urgent', agreedById: 'admin', confirmedAt: null, confirmedById: null });
      expect(rows.Route).toHaveLength(before);
      expect((audit.result as Record<string, unknown>).pickupId).toBe(rows.OrderPickup![0].id);
    });

    it('tras una entrega fallida exige referirse al último intento fallido, y solo entonces registra el acuerdo', async () => {
      failed('COMPLETED');
      await expect(pickup({ action: 'PICKUP_AGREE' })).rejects.toThrow('latest failed attempt');
      await expect(pickup({ action: 'PICKUP_AGREE', attemptId: 'otro' })).rejects.toThrow('latest failed attempt');
      expect(rows.OrderPickup).toHaveLength(0);

      const audit = await pickup({ action: 'PICKUP_AGREE', attemptId: 'failure' });
      expect(audit.outcome).toBe('APPLIED');
      expect(rows.Order![0]).toMatchObject({ status: 'PENDING', requiresAdministrativeReview: true, routeId: null });
      expect((audit.result as Record<string, unknown>).attemptId).toBe('failure');
      // El historial de la ruta original y del intento fallido se conserva.
      expect(rows.DeliveryAttempt).toHaveLength(1);
      expect(rows.RouteStop![0].outcome).toBe('FAILED');
    });

    it('sin intento fallido pendiente no acepta un attemptId', async () => {
      await expect(pickup({ action: 'PICKUP_AGREE', attemptId: 'failure' })).rejects.toThrow('No unresolved failed attempt');
      expect(rows.OrderPickup).toHaveLength(0);
    });

    it('si el pedido tiene una reserva en una ruta aún no iniciada, la suelta de forma segura sin dejar la ruta vacía', async () => {
      baseRoute('DRAFT', 2);
      const audit = await call({ action: 'PICKUP_AGREE', orderId: 'old' });
      expect(audit.outcome).toBe('APPLIED');
      expect(rows.OrderClaim!.find((c) => c.orderId === 'old')!.releasedAt).not.toBeNull();
      expect(rows.OrderClaim!.find((c) => c.orderId === 'old1')!.releasedAt).toBeNull(); // el otro pedido conserva su reserva
      expect(rows.RouteStop!.map((stop) => stop.orderId)).toEqual(['old1']);
      expect(rows.Order!.find((o) => o.id === 'old')).toMatchObject({ status: 'PENDING', requiresAdministrativeReview: true, routeId: null });
      expect(rows.OrderPickup).toHaveLength(1);
    });

    it('no vacía una ruta reservada: con una sola parada se rechaza sin cambios', async () => {
      baseRoute('DRAFT', 1);
      await expect(call({ action: 'PICKUP_AGREE', orderId: 'old' })).rejects.toThrow('cannot empty a reserved route');
      expect(rows.OrderPickup).toHaveLength(0);
      expect(rows.RouteStop).toHaveLength(1);
      expect(rows.OrderClaim![0].releasedAt).toBeNull();
    });

    it('una ruta ya iniciada no pierde paradas: se rechaza y nada cambia', async () => {
      baseRoute('IN_PROGRESS', 2);
      const stopsBefore = rows.RouteStop!.length;
      await expect(call({ action: 'PICKUP_AGREE', orderId: 'old' })).rejects.toThrow('frozen');
      expect(rows.OrderPickup).toHaveLength(0);
      expect(rows.RouteStop).toHaveLength(stopsBefore);
      expect(rows.OrderClaim!.every((c) => c.releasedAt === null)).toBe(true);
      expect(await service.audit()).toEqual([]);
    });

    it('si el cliente no acepta el retiro solo se audita: no se entrega, no se crea ruta y se admite otra alternativa', async () => {
      const before = routesBefore();
      const declined = await pickup({ action: 'PICKUP_DECLINE' });
      expect(declined).toMatchObject({ action: 'PICKUP_DECLINE', outcome: 'APPLIED' });
      expect(rows.OrderPickup).toHaveLength(0);
      expect(rows.Order![0]).toMatchObject({ status: 'PENDING', requiresAdministrativeReview: false });
      expect(rows.Route).toHaveLength(before);

      // Otra alternativa acordada después: ahora sí acepta el retiro.
      expect((await pickup({ action: 'PICKUP_AGREE' })).outcome).toBe('APPLIED');
      expect(rows.OrderPickup).toHaveLength(1);
      expect((await service.audit()).map((a) => a.action).sort()).toEqual(['PICKUP_AGREE', 'PICKUP_DECLINE']);
    });

    it('un rechazo tras una entrega fallida mantiene el pedido pendiente de gestión', async () => {
      failed('COMPLETED');
      await pickup({ action: 'PICKUP_DECLINE', attemptId: 'failure' });
      expect(rows.Order![0]).toMatchObject({ status: 'ASSIGNED', requiresAdministrativeReview: true });
      expect(rows.OrderPickup).toHaveLength(0);
    });

    it('acordar y retirar son dos eventos: solo la confirmación entrega el pedido, con actor y momento', async () => {
      await pickup({ action: 'PICKUP_AGREE' });
      expect(rows.Order![0].status).not.toBe('DELIVERED');

      const confirmed = await pickup({ action: 'PICKUP_CONFIRM' }, 'admin2');

      expect(confirmed).toMatchObject({ action: 'PICKUP_CONFIRM', outcome: 'APPLIED', actorId: 'admin2' });
      expect(rows.Order![0]).toMatchObject({ status: 'DELIVERED', requiresAdministrativeReview: false });
      expect(rows.OrderPickup![0]).toMatchObject({ agreedById: 'admin', confirmedById: 'admin2' });
      expect(rows.OrderPickup![0].confirmedAt).toBeTruthy();
      expect(rows.OrderPickup![0].confirmationRequestId).toBe(confirmed.requestId);
      expect((await service.audit()).map((a) => a.action).sort()).toEqual(['PICKUP_AGREE', 'PICKUP_CONFIRM']);
    });

    it('no se confirma un retiro que no se acordó ni se confirma dos veces; el reintento con la misma clave devuelve lo mismo', async () => {
      await expect(pickup({ action: 'PICKUP_CONFIRM' })).rejects.toMatchObject({ response: { code: 'PICKUP_NOT_AGREED' } });
      await pickup({ action: 'PICKUP_AGREE' });
      const first = await call({ action: 'PICKUP_CONFIRM', orderId: 'urgent', requestId: 'confirm-once' });

      // Misma clave: es el mismo evento (idempotente), no una doble confirmación.
      expect(await call({ action: 'PICKUP_CONFIRM', orderId: 'urgent', requestId: 'confirm-once' })).toEqual(first);
      // Clave nueva: el pedido ya está entregado y el retiro confirmado.
      await expect(pickup({ action: 'PICKUP_CONFIRM' })).rejects.toThrow('Commercially resolved order');
      expect((await service.audit()).filter((a) => a.action === 'PICKUP_CONFIRM')).toHaveLength(1);
    });

    it('un retiro confirmado en la base pero no entregado se rechaza como ya confirmado', async () => {
      await pickup({ action: 'PICKUP_AGREE' });
      rows.OrderPickup![0].confirmedAt = nowInstant();
      await expect(pickup({ action: 'PICKUP_CONFIRM' })).rejects.toMatchObject({ response: { code: 'PICKUP_ALREADY_CONFIRMED' } });
    });

    it('un pedido ya con retiro acordado no admite otro acuerdo ni un rechazo', async () => {
      await pickup({ action: 'PICKUP_AGREE' });
      await expect(pickup({ action: 'PICKUP_AGREE' })).rejects.toMatchObject({ response: { code: 'PICKUP_ALREADY_AGREED' } });
      await expect(pickup({ action: 'PICKUP_DECLINE' })).rejects.toMatchObject({ response: { code: 'PICKUP_ALREADY_AGREED' } });
      expect(rows.OrderPickup).toHaveLength(1);
    });

    it.each(['DELIVERED', 'CANCELLED'])('un pedido %s no se gestiona para retiro', async (status) => {
      rows.Order![0].status = status;
      for (const action of ['PICKUP_AGREE', 'PICKUP_DECLINE', 'PICKUP_CONFIRM']) {
        await expect(pickup({ action })).rejects.toThrow('Commercially resolved order');
      }
      expect(rows.OrderPickup).toHaveLength(0);
      expect(await service.audit()).toEqual([]);
    });

    it('valida los campos exactos de cada acción y que el pedido exista', async () => {
      await expect(call({ action: 'PICKUP_AGREE' })).rejects.toThrow('exact resource fields');
      await expect(pickup({ action: 'PICKUP_CONFIRM', attemptId: 'failure' })).rejects.toThrow('exact resource fields');
      await expect(pickup({ action: 'PICKUP_AGREE', fingerprint: 'fp' })).rejects.toThrow('exact resource fields');
      await expect(call({ action: 'PICKUP_AGREE', orderId: 'no-existe' })).rejects.toThrow('Order not found');
      expect(rows.OrderPickup).toHaveLength(0);
    });

    it('no repone stock ni toca reservas de repartidor: solo cambia el pedido y su retiro', async () => {
      await pickup({ action: 'PICKUP_AGREE' });
      await pickup({ action: 'PICKUP_CONFIRM' });
      expect((await availability.effective('driver')).isAvailable).toBe(true);
      expect(rows.DriverReservation).toHaveLength(0);
    });
  });

  describe('liberación auditada de DRAFT expirado (RELEASE_DRAFT)', () => {
    it('elimina paradas, libera OrderClaim activos y audita sin perder trazabilidad', async () => {
      baseRoute('DRAFT', 2, 'stale-draft');
      rows.Route![0].date = nowInstant().subtract({ hours: 24 });

      const first = await call({
        action: 'RELEASE_DRAFT',
        routeId: 'stale-draft',
        requestId: 'release-stale-1',
      });
      expect(first).toMatchObject({
        action: 'RELEASE_DRAFT',
        outcome: 'APPLIED',
        routeId: 'stale-draft',
        orderId: null,
      });
      expect(rows.RouteStop).toHaveLength(0);
      expect(rows.OrderClaim!.every((c) => c.releasedAt !== null)).toBe(true);
      expect(rows.Order!.every((o) => o.status === 'PENDING' && o.routeId === null)).toBe(true);

      // Idempotent replay
      const replay = await call({
        action: 'RELEASE_DRAFT',
        routeId: 'stale-draft',
        requestId: 'release-stale-1',
      });
      expect(replay).toEqual(first);
      expect(rows.DispatchIntervention).toHaveLength(1);
    });

    it.each(['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'])('rechaza RELEASE_DRAFT en ruta %s', async (status) => {
      baseRoute(status, 1, 'locked-route');
      await expect(
        call({ action: 'RELEASE_DRAFT', routeId: 'locked-route' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(rows.RouteStop).toHaveLength(1);
      expect(rows.OrderClaim![0].releasedAt).toBeNull();
    });

    it('rechaza RELEASE_DRAFT sobre un DRAFT ya liberado (sin paradas ni claims)', async () => {
      rows.Route!.push({
        id: 'empty-draft',
        status: 'DRAFT',
        driverId: null,
        zoneId: 'zone',
        date: nowInstant().subtract({ hours: 24 }),
        createdAt: nowInstant(),
      });
      await expect(
        call({ action: 'RELEASE_DRAFT', routeId: 'empty-draft' }),
      ).rejects.toMatchObject({ response: { code: 'DRAFT_ALREADY_RELEASED' } });
    });
  });

  describe('cobertura global sin Zone (zoneId null)', () => {
    it('confirma NEW_ROUTE urgente cuando proposal.zoneId es null usando StoreCoverage', async () => {
      rows.Zone = [];
      rows.Order = [currentOrder('urgent', { zoneId: null })];
      rows.StoreCoverage!.push({ singletonKey: 'GLOBAL', lat: -1.24, lng: -78.61 });
      propose.mockResolvedValue({
        kind: 'NEW_ROUTE',
        orderId: 'urgent',
        routeId: null,
        zoneId: null,
        routeDate: rows.Order[0]!.scheduledDeliveryDate.toString(),
        orderIds: ['urgent'],
        availableDriverIds: ['driver'],
        fingerprint: 'fp-null-new',
      });

      const outcome = await call({
        action: 'CONFIRM',
        orderId: 'urgent',
        driverId: 'driver',
        fingerprint: 'fp-null-new',
      });

      expect(outcome).toMatchObject({
        action: 'CONFIRM',
        outcome: 'APPLIED',
        orderId: 'urgent',
      });
      expect(rows.Route[0]).toMatchObject({
        zoneId: null,
        status: 'ASSIGNED',
        driverId: 'driver',
      });
    });

    it('reprograma (RESCHEDULE) un pedido con zoneId null cuando StoreCoverage está configurada', async () => {
      failed('COMPLETED');
      rows.Zone = [];
      rows.Order![0].zoneId = null;
      rows.StoreCoverage!.push({ singletonKey: 'GLOBAL', lat: -1.24, lng: -78.61 });

      const agreed = await call(agreement({ attemptId: 'failure' }));
      const outcome = await call({
        action: 'RESCHEDULE',
        orderId: 'urgent',
        agreementId: agreed.id,
      });

      expect(outcome).toMatchObject({
        action: 'RESCHEDULE',
        outcome: 'APPLIED',
        orderId: 'urgent',
      });
      expect(rows.Order![0]).toMatchObject({
        status: 'PENDING',
        requiresAdministrativeReview: false,
      });
    });

    it('rechaza RESCHEDULE de pedido con zoneId null si falta StoreCoverage', async () => {
      failed('COMPLETED');
      rows.Zone = [];
      rows.Order![0].zoneId = null;

      const agreed = await call(agreement({ attemptId: 'failure' }));
      await expect(
        call({
          action: 'RESCHEDULE',
          orderId: 'urgent',
          agreementId: agreed.id,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('gestión de emergencia en ruta (#51)', () => {
    it('ejecuta EMERGENCY_DECLARE -> UNIT_RECOVERY_CONFIRM -> EMERGENCY_CLOSE -> EMERGENCY_DRIVER_RELEASE -> EMERGENCY_REQUEUE con replay idempotente', async () => {
      baseRoute('IN_PROGRESS', 2, 'em-route');
      rows.Route![0]!.startedAt = nowInstant();
      rows.Route![0]!.startedById = 'driver-user';
      rows.Route![0]!.completedAt = null;
      rows.Route![0]!.completedById = null;
      rows.Route![0]!.returnedAt = null;
      rows.Route![0]!.returnedById = null;
      rows.Order!.forEach((o) => {
        if (o.routeId === 'em-route') o.status = 'IN_TRANSIT';
      });
      rows.OrderItem!.push(
        { id: 'em-item-1', orderId: 'em-route-order0', productId: 'prod-1', quantity: 2 },
        { id: 'em-item-2', orderId: 'em-route-order1', productId: 'prod-1', quantity: 1 },
      );

      const declared = await call({
        action: 'EMERGENCY_DECLARE',
        routeId: 'em-route',
        requestId: 'em-declare-1',
      });
      expect(declared).toMatchObject({
        action: 'EMERGENCY_DECLARE',
        outcome: 'APPLIED',
        routeId: 'em-route',
      });
      expect(await call({
        action: 'EMERGENCY_DECLARE',
        routeId: 'em-route',
        requestId: 'em-declare-1',
      })).toEqual(declared);
      expect(rows.Route![0]!.status).toBe('INTERRUPTED');
      expect(rows.RouteUnitRecovery).toHaveLength(3);

      const emergencyId = rows.RouteEmergency![0]!.id;
      const order0Units = rows.RouteUnitRecovery!.filter(
        (u) => u.orderId === 'em-route-order0',
      );
      await call({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: order0Units[0]!.id });
      await expect(
        call({
          action: 'EMERGENCY_REQUEUE',
          orderId: 'em-route-order0',
          emergencyId,
        }),
      ).rejects.toMatchObject({ response: { code: 'RECOVERY_PENDING' } });

      await call({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: order0Units[1]!.id });
      const closed = await call({ action: 'EMERGENCY_CLOSE', routeId: 'em-route' });
      expect(closed.action).toBe('EMERGENCY_CLOSE');

      const released = await call({
        action: 'EMERGENCY_DRIVER_RELEASE',
        routeId: 'em-route',
      });
      expect(released.action).toBe('EMERGENCY_DRIVER_RELEASE');
      expect((await availability.effective('driver')).isAvailable).toBe(true);

      const requeued = await call({
        action: 'EMERGENCY_REQUEUE',
        orderId: 'em-route-order0',
        emergencyId,
      });
      expect(requeued).toMatchObject({
        action: 'EMERGENCY_REQUEUE',
        outcome: 'APPLIED',
        orderId: 'em-route-order0',
      });
      expect(
        rows.Order!.find((o) => o.id === 'em-route-order0')!
          .requiresAdministrativeReview,
      ).toBe(false);
    });

    it('valida los campos exactos requeridos para cada acción #51', async () => {
      await expect(call({ action: 'EMERGENCY_DECLARE' })).rejects.toThrow(
        'exact resource fields',
      );
      await expect(call({ action: 'UNIT_RECOVERY_CONFIRM' })).rejects.toThrow(
        'exact resource fields',
      );
      await expect(call({ action: 'EMERGENCY_CLOSE' })).rejects.toThrow(
        'exact resource fields',
      );
      await expect(
        call({ action: 'EMERGENCY_DRIVER_RELEASE' }),
      ).rejects.toThrow('exact resource fields');
      await expect(
        call({ action: 'EMERGENCY_REQUEUE', orderId: 'urgent' }),
      ).rejects.toThrow('exact resource fields');
      await expect(call({ action: 'LOSS_CANCEL' })).rejects.toThrow(
        'exact resource fields',
      );
    });

    it('bloquea CONTACT, RESCHEDULE y PICKUP_AGREE con RECOVERY_PENDING mientras queden unidades sin recuperar o con reemplazo PENDING', async () => {
      baseRoute('IN_PROGRESS', 1, 'em-guard-route');
      rows.Route![0]!.startedAt = nowInstant();
      rows.Route![0]!.startedById = 'driver-user';
      rows.Order!.forEach((o) => {
        if (o.routeId === 'em-guard-route') o.status = 'IN_TRANSIT';
      });
      rows.OrderItem!.push({
        id: 'em-guard-item',
        orderId: 'em-guard-route-order0',
        productId: 'prod-guard',
        quantity: 2,
      });

      await call({ action: 'EMERGENCY_DECLARE', routeId: 'em-guard-route' });
      const emergencyId = rows.RouteEmergency![0]!.id;
      const units = rows.RouteUnitRecovery!.filter(
        (u) => u.orderId === 'em-guard-route-order0',
      );

      // 1 unit recovered, 1 unit still pending (or with PENDING replacement).
      await call({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: units[0]!.id });
      await expect(
        call(agreement({ orderId: 'em-guard-route-order0', emergencyId })),
      ).rejects.toMatchObject({ response: { code: 'RECOVERY_PENDING' } });
      await expect(
        call({
          action: 'PICKUP_AGREE',
          orderId: 'em-guard-route-order0',
          emergencyId,
        }),
      ).rejects.toMatchObject({ response: { code: 'RECOVERY_PENDING' } });

      // PENDING loss (replacementPreparedAt: null) still blocks CONTACT/RESCHEDULE/PICKUP_AGREE.
      rows.OrderItemLoss!.push({
        id: 'loss-pending-guard',
        orderId: 'em-guard-route-order0',
        orderItemId: units[1]!.orderItemId,
        unitNumber: units[1]!.unitNumber,
        replacementPreparedAt: null,
        recoveredAt: null,
        cancelledAt: null,
      });
      await expect(
        call(agreement({ orderId: 'em-guard-route-order0', emergencyId })),
      ).rejects.toMatchObject({ response: { code: 'RECOVERY_PENDING' } });

      // Once replacement is PREPARED, CONTACT + RESCHEDULE with emergencyId succeed.
      rows.OrderItemLoss![0]!.replacementPreparedAt = nowInstant();
      const contact = await call(
        agreement({ orderId: 'em-guard-route-order0', emergencyId }),
      );
      expect(contact.action).toBe('CONTACT');
      const rescheduled = await call({
        action: 'RESCHEDULE',
        orderId: 'em-guard-route-order0',
        agreementId: contact.id,
      });
      expect(rescheduled.outcome).toBe('APPLIED');
      expect(
        rows.Order!.find((o) => o.id === 'em-guard-route-order0')!
          .requiresAdministrativeReview,
      ).toBe(false);
    });

    it('permite PICKUP_AGREE con emergencyId una vez resueltas todas las unidades y rechaza si hay intento FAILED posterior a la emergencia', async () => {
      baseRoute('IN_PROGRESS', 1, 'em-pickup-route');
      rows.Route![0]!.startedAt = nowInstant();
      rows.Route![0]!.startedById = 'driver-user';
      rows.Order!.forEach((o) => {
        if (o.routeId === 'em-pickup-route') o.status = 'IN_TRANSIT';
      });
      rows.OrderItem!.push({
        id: 'em-pickup-item',
        orderId: 'em-pickup-route-order0',
        productId: 'prod-pickup',
        quantity: 1,
      });

      await call({ action: 'EMERGENCY_DECLARE', routeId: 'em-pickup-route' });
      const emergencyId = rows.RouteEmergency![0]!.id;
      const unit = rows.RouteUnitRecovery!.find(
        (u) => u.orderId === 'em-pickup-route-order0',
      )!;
      await call({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unit.id });

      // Later failed attempt >= emergency.declaredAt blocks emergencyId resolution.
      rows.DeliveryAttempt!.push({
        id: 'later-fail',
        stopId: 'em-pickup-route-stop0',
        outcome: 'FAILED',
        recordedAt: rows.RouteEmergency![0]!.declaredAt,
      });
      await expect(
        call({
          action: 'PICKUP_AGREE',
          orderId: 'em-pickup-route-order0',
          emergencyId,
        }),
      ).rejects.toThrow('failed delivery attempt');

      rows.DeliveryAttempt = [];
      const agreed = await call({
        action: 'PICKUP_AGREE',
        orderId: 'em-pickup-route-order0',
        emergencyId,
      });
      expect(agreed.outcome).toBe('APPLIED');
      expect(rows.OrderPickup).toHaveLength(1);
    });

    it('permite RESCHEDULE y PICKUP_AGREE con attemptId sobre parada FAILED en ruta INTERRUPTED y enruta LOSS_CANCEL', async () => {
      failed('INTERRUPTED');
      // Release claim as EMERGENCY_DECLARE does for all route claims.
      rows.OrderClaim = [];
      const contact = await call(agreement({ attemptId: 'failure' }));
      const rescheduled = await call({
        action: 'RESCHEDULE',
        orderId: 'urgent',
        agreementId: contact.id,
      });
      expect(rescheduled.outcome).toBe('APPLIED');
      expect(rows.Order![0]!.requiresAdministrativeReview).toBe(false);

      // Route LOSS_CANCEL through intervene() with idempotent replay.
      rows.OrderItem!.push({
        id: 'loss-item',
        orderId: 'urgent',
        productId: 'prod-loss',
        quantity: 1,
      });
      rows.OrderItemLoss!.push({
        id: 'loss-to-cancel',
        orderId: 'urgent',
        orderItemId: 'loss-item',
        unitNumber: 1,
        productId: 'prod-loss',
        attemptId: null,
        declaredAt: nowInstant(),
        declaredById: 'admin',
        replacementPreparedAt: null,
        replacementPreparedById: null,
        replacementRequestId: null,
        recoveredAt: null,
        recoveredById: null,
        recoveryCondition: null,
        recoveryRequestId: null,
        cancelledAt: null,
        cancelledById: null,
        cancelReason: null,
        cancelRequestId: null,
      });
      const cancelled = await call({
        action: 'LOSS_CANCEL',
        lossId: 'loss-to-cancel',
        requestId: 'loss-cancel-key',
      });
      expect(cancelled).toMatchObject({
        action: 'LOSS_CANCEL',
        outcome: 'APPLIED',
        orderId: 'urgent',
      });
      expect(
        await call({
          action: 'LOSS_CANCEL',
          lossId: 'loss-to-cancel',
          requestId: 'loss-cancel-key',
        }),
      ).toEqual(cancelled);
    });
  });
});
