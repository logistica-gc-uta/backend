import { RouteUrgencyService } from './route-urgency.service.js';
import { RoadMetricsService } from './road/road-metrics.service.js';
import { DEFAULT_ROAD_CONFIG } from './road/road-metrics.types.js';
import { businessDay, nowInstant } from '../../common/temporal.util.js';

const haversineRoads = () => new RoadMetricsService({ ...DEFAULT_ROAD_CONFIG });

const instant = () => nowInstant();
const order = (id: string, extra = {}) => ({
  id,
  zoneId: 'zone',
  status: 'PENDING',
  scheduledDeliveryDate: instant(),
  deliveryLat: -1.25,
  deliveryLng: -78.62,
  requiresAdministrativeReview: false,
  ...extra,
});

describe('Urgency proposals (CP-RUT-003/004/008/009)', () => {
  let rows: Record<string, any[]>;
  let writes: jest.Mock;
  let service: RouteUrgencyService;
  beforeEach(() => {
    rows = {
      Order: [order('urgent')],
      Zone: [{ id: 'zone', depotLat: -1.24, depotLng: -78.61 }],
      Route: [],
      RouteStop: [],
      OrderClaim: [],
      Driver: [{ id: 'driver', userId: 'driver-user' }],
      User: [{ id: 'driver-user', role: 'DRIVER' }],
      DeliveryAttempt: [],
      DispatchIntervention: [],
      OrderPickup: [],
      StoreCoverage: [],
    };
    writes = jest.fn(() => {
      throw new Error('Read-only proposal wrote data');
    });
    const models = Object.fromEntries(
      Object.entries(rows).map(([name]) => {
        const query = (filter: any = {}) => ({
          where: (next: any) => query({ ...filter, ...next }),
          first: async () =>
            rows[name]!.find((r) =>
              Object.entries(filter).every(([k, v]) => r[k] === v),
            ) ?? null,
          all: async () =>
            rows[name]!.filter((r) =>
              Object.entries(filter).every(([k, v]) => r[k] === v),
            ),
          create: writes,
          update: writes,
          delete: writes,
        });
        return [name, { ...query(), where: query }];
      }),
    );
    service = new RouteUrgencyService(
      { client: { orm: { public: models }, transaction: writes } } as any,
      { effective: async () => ({ isAvailable: true }) } as any,
      haversineRoads(),
    );
  });
  const addRoute = (status = 'ASSIGNED', count = 3) => {
    rows.Route!.push({
      id: 'route',
      status,
      zoneId: 'zone',
      date: instant(),
      driverId: 'driver',
    });
    for (let i = 1; i <= count; i++) {
      rows.Order!.push(
        order(`old${i}`, {
          status: status === 'DRAFT' ? 'PENDING' : 'ASSIGNED',
          routeId: 'route',
        }),
      );
      rows.RouteStop!.push({
        id: `stop${i}`,
        routeId: 'route',
        orderId: `old${i}`,
        sequence: i,
        isLegacy: false,
        outcome: 'PENDING',
      });
      rows.OrderClaim!.push({
        id: `claim${i}`,
        orderId: `old${i}`,
        routeId: 'route',
        claimedAt: instant(),
        releasedAt: null,
      });
    }
  };
  it('proposes four sequential stops on ASSIGNED without persistence and stable fingerprints', async () => {
    addRoute();
    const before = JSON.stringify(rows);
    const a = await service.propose('urgent');
    const b = await service.propose('urgent');
    expect(a.kind).toBe('INSERT');
    expect(a.routeId).toBe('route');
    expect(new Set(a.orderIds)).toEqual(
      new Set(['urgent', 'old1', 'old2', 'old3']),
    );
    expect(a.stops.map((s) => s.sequence)).toEqual([1, 2, 3, 4]);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(JSON.stringify(rows)).toBe(before);
    expect(writes).not.toHaveBeenCalled();
  });
  it.each(['DRAFT', 'ASSIGNED'])(
    'only uses compatible %s routes',
    async (status) => {
      addRoute(status);
      expect((await service.propose('urgent')).kind).toBe('INSERT');
    },
  );
  it.each(['IN_PROGRESS', 'COMPLETED', 'ASSIGNED'])(
    'uses a new departure rather than a frozen/full %s route',
    async (status) => {
      addRoute(status, status === 'ASSIGNED' ? 4 : 3);
      const before = JSON.stringify(rows);
      const p = await service.propose('urgent');
      expect(p.kind).toBe('NEW_ROUTE');
      expect(p.availableDriverIds).toEqual(['driver']);
      expect(p.orderIds).toEqual(['urgent']);
      expect(JSON.stringify(rows)).toBe(before);
    },
  );
  it('keeps PENDING and exposes unavailable drivers', async () => {
    rows.Driver = [];
    const p = await service.propose('urgent');
    expect(p.kind).toBe('BLOCKED');
    expect(p.reasons).toContain('NO_AVAILABLE_DRIVER');
    expect(rows.Order![0].status).toBe('PENDING');
    expect(writes).not.toHaveBeenCalled();
  });
  it.each([
    [{ requiresAdministrativeReview: true }, 'ADMINISTRATIVE_REVIEW_REQUIRED'],
    [{ deliveryLat: null, deliveryLng: null }, 'MISSING_DELIVERY_COORDINATES'],
    [{ status: 'DELIVERED' }, 'ORDER_NOT_PENDING'],
    [
      { scheduledDeliveryDate: Temporal.Instant.from('2000-01-01T12:00:00Z') },
      'NOT_TODAY',
    ],
  ])('exposes ineligibility without writes: %s', async (change, reason) => {
    Object.assign(rows.Order![0], change);
    expect((await service.propose('urgent')).reasons).toContain(reason);
    expect(writes).not.toHaveBeenCalled();
  });
  it('rejects an active claim, incompatible zone/day or malformed sequences', async () => {
    addRoute();
    rows.RouteStop![1].sequence = 1;
    expect((await service.propose('urgent')).kind).toBe('NEW_ROUTE');
    rows.OrderClaim!.push({
      orderId: 'urgent',
      routeId: 'elsewhere',
      releasedAt: null,
    });
    expect((await service.propose('urgent')).reasons).toContain(
      'ACTIVE_ROUTE_CLAIM',
    );
  });
  it('prioritizes explicitly audited orders without changing commercial state', async () => {
    rows.Order!.push(order('priority'));
    rows.DispatchIntervention!.push({
      orderId: 'priority',
      action: 'PRIORITIZE',
      outcome: 'APPLIED',
      recordedAt: instant(),
    });
    const result = await service.inbox();
    expect(result.urgencies.map((p) => p.orderId)).toEqual([
      'priority',
      'urgent',
    ]);
    expect(rows.Order!.map((o) => o.status)).toEqual(['PENDING', 'PENDING']);
    expect(writes).not.toHaveBeenCalled();
  });
  it('filters today in Guayaquil and does not expose recipient/attempt context', async () => {
    rows.Order!.push(
      order('review', {
        status: 'IN_TRANSIT',
        requiresAdministrativeReview: true,
        recipientPhone: 'private',
      }),
      order('yesterday', {
        scheduledDeliveryDate: Temporal.Instant.from('2000-01-01T12:00:00Z'),
      }),
    );
    const inbox = await service.inbox();
    expect(inbox.date).toBe(businessDay(nowInstant()).toString());
    expect(inbox.urgencies.map((p) => p.orderId)).toEqual(['urgent']);
    expect(inbox.incidents.map((p) => p.orderId)).toEqual(['review']);
    expect(JSON.stringify(inbox)).not.toContain('private');
    expect(writes).not.toHaveBeenCalled();
  });
  it('shows the agreed store pickup of an incident so the ADMIN knows which orders wait for it (#50)', async () => {
    rows.Order!.push(
      order('failed', { status: 'PENDING', requiresAdministrativeReview: true }),
      order('waiting', { status: 'PENDING', requiresAdministrativeReview: true }),
      order('collected', { status: 'PENDING', requiresAdministrativeReview: true }),
    );
    rows.OrderPickup!.push(
      { orderId: 'waiting', agreedAt: Temporal.Instant.from('2030-02-14T15:00:00Z'), confirmedAt: null },
      {
        orderId: 'collected',
        agreedAt: Temporal.Instant.from('2030-02-14T15:00:00Z'),
        confirmedAt: Temporal.Instant.from('2030-02-15T16:00:00Z'),
      },
    );
    const { incidents } = await service.inbox();
    const byOrder = Object.fromEntries(incidents.map((i) => [i.orderId, i.pickup]));
    expect(byOrder.failed).toBeNull();
    expect(byOrder.waiting).toEqual({ state: 'PENDING_PICKUP', agreedAt: '2030-02-14T15:00:00Z', pickedUpAt: null });
    expect(byOrder.collected).toEqual({
      state: 'PICKED_UP',
      agreedAt: '2030-02-14T15:00:00Z',
      pickedUpAt: '2030-02-15T16:00:00Z',
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('proposes NEW_ROUTE for zoneId null order when StoreCoverage origin is configured', async () => {
    rows.Zone = [];
    rows.Order = [order('urgent-store', { zoneId: null })];
    rows.StoreCoverage = [{ singletonKey: 'GLOBAL', lat: -1.24, lng: -78.61 }];

    const p = await service.propose('urgent-store');
    expect(p.kind).toBe('NEW_ROUTE');
    expect(p.zoneId).toBeNull();
    expect(p.orderIds).toEqual(['urgent-store']);
    expect(p.availableDriverIds).toEqual(['driver']);
  });

  it('proposes BLOCKED NO_AVAILABLE_DRIVER for zoneId null order when StoreCoverage is configured but no driver is free', async () => {
    rows.Zone = [];
    rows.Order = [order('urgent-store', { zoneId: null })];
    rows.StoreCoverage = [{ singletonKey: 'GLOBAL', lat: -1.24, lng: -78.61 }];
    const blockedSvc = new RouteUrgencyService(
      {
        client: {
          orm: {
            public: {
              ...Object.fromEntries(
                Object.entries(rows).map(([name]) => {
                  const query = (filter: any = {}) => ({
                    where: (next: any) => query({ ...filter, ...next }),
                    first: async () =>
                      rows[name]!.find((r) =>
                        Object.entries(filter).every(([k, v]) => r[k] === v),
                      ) ?? null,
                    all: async () =>
                      rows[name]!.filter((r) =>
                        Object.entries(filter).every(([k, v]) => r[k] === v),
                      ),
                    create: writes,
                    update: writes,
                    delete: writes,
                  });
                  return [name, { ...query(), where: query }];
                }),
              ),
            },
          },
          transaction: writes,
        },
      } as any,
      { effective: async () => ({ isAvailable: false }) } as any,
      haversineRoads(),
    );

    const p = await blockedSvc.propose('urgent-store');
    expect(p.kind).toBe('BLOCKED');
    expect(p.reasons).toEqual(['NO_AVAILABLE_DRIVER']);
    expect(p.availableDriverIds).toEqual([]);
  });

  it('proposes BLOCKED MISSING_ZONE for zoneId null order when StoreCoverage is not configured', async () => {
    rows.Zone = [];
    rows.Order = [order('urgent-store', { zoneId: null })];

    const p = await service.propose('urgent-store');
    expect(p.kind).toBe('BLOCKED');
    expect(p.reasons).toContain('MISSING_ZONE');
  });

  it('proposes INSERT for zoneId null urgent order into today non-empty zoneId null DRAFT or ASSIGNED route and ignores 0-stop, expired, IN_PROGRESS, COMPLETED, and full routes', async () => {
    rows.Zone = [];
    rows.Order = [order('urgent-store', { zoneId: null })];
    rows.StoreCoverage = [{ singletonKey: 'GLOBAL', lat: -1.24, lng: -78.61 }];

    // 0-stop released DRAFT
    rows.Route!.push({
      id: 'empty-draft',
      status: 'DRAFT',
      zoneId: null,
      date: instant(),
      driverId: null,
    });
    // Expired yesterday DRAFT with 1 stop
    rows.Route!.push({
      id: 'yesterday-draft',
      status: 'DRAFT',
      zoneId: null,
      date: instant().subtract({ hours: 24 }),
      driverId: null,
    });
    rows.Order!.push(order('y-old', { zoneId: null, status: 'PENDING', routeId: null }));
    rows.RouteStop!.push({
      id: 'y-stop',
      routeId: 'yesterday-draft',
      orderId: 'y-old',
      sequence: 1,
      isLegacy: false,
      outcome: 'PENDING',
    });
    rows.OrderClaim!.push({
      id: 'y-claim',
      orderId: 'y-old',
      routeId: 'yesterday-draft',
      claimedAt: instant(),
      releasedAt: null,
    });
    // IN_PROGRESS today route with 1 stop
    rows.Route!.push({
      id: 'in-progress',
      status: 'IN_PROGRESS',
      zoneId: null,
      date: instant(),
      driverId: 'driver',
    });
    rows.Order!.push(order('ip-old', { zoneId: null, status: 'IN_TRANSIT', routeId: 'in-progress' }));
    rows.RouteStop!.push({
      id: 'ip-stop',
      routeId: 'in-progress',
      orderId: 'ip-old',
      sequence: 1,
      isLegacy: false,
      outcome: 'PENDING',
    });
    rows.OrderClaim!.push({
      id: 'ip-claim',
      orderId: 'ip-old',
      routeId: 'in-progress',
      claimedAt: instant(),
      releasedAt: null,
    });
    // Active today zoneId: null DRAFT route with 1 stop (should be chosen)
    rows.Route!.push({
      id: 'today-draft',
      status: 'DRAFT',
      zoneId: null,
      date: instant(),
      driverId: null,
    });
    rows.Order!.push(order('td-old', { zoneId: null, status: 'PENDING', routeId: null }));
    rows.RouteStop!.push({
      id: 'td-stop',
      routeId: 'today-draft',
      orderId: 'td-old',
      sequence: 1,
      isLegacy: false,
      outcome: 'PENDING',
    });
    rows.OrderClaim!.push({
      id: 'td-claim',
      orderId: 'td-old',
      routeId: 'today-draft',
      claimedAt: instant(),
      releasedAt: null,
    });

    const models = Object.fromEntries(
      Object.entries(rows).map(([name]) => {
        const query = (filter: any = {}) => ({
          where: (next: any) => query({ ...filter, ...next }),
          first: async () =>
            rows[name]!.find((r) =>
              Object.entries(filter).every(([k, v]) => r[k] === v),
            ) ?? null,
          all: async () =>
            rows[name]!.filter((r) =>
              Object.entries(filter).every(([k, v]) => r[k] === v),
            ),
          create: writes,
          update: writes,
          delete: writes,
        });
        return [name, { ...query(), where: query }];
      }),
    );
    const coverageSvc = {
      getCoverage: async () => ({ configured: true, location: { lat: -1.24, lng: -78.61 } }),
    } as any;
    const svc = new RouteUrgencyService(
      { client: { orm: { public: models }, transaction: writes } } as any,
      { effective: async () => ({ isAvailable: true }) } as any,
      haversineRoads(),
      coverageSvc,
    );

    const p = await svc.propose('urgent-store');
    expect(p.kind).toBe('INSERT');
    expect(p.routeId).toBe('today-draft');
    expect(p.zoneId).toBeNull();
    expect(p.orderIds).toEqual(expect.arrayContaining(['td-old', 'urgent-store']));
  });

  it('blocks propose() with RECOVERY_PENDING when unresolved RouteUnitRecovery exists and surfaces interruptedRoutes/pendingRecoveries in inbox() without PII', async () => {
    const declaredAt = instant().subtract({ minutes: 30 });
    rows.Route!.push({
      id: 'int-route',
      status: 'INTERRUPTED',
      zoneId: 'zone',
      date: instant(),
      driverId: 'driver',
      returnedAt: null,
      returnedById: null,
    });
    rows.Order!.push(
      order('detached', {
        status: 'PENDING',
        routeId: null,
        requiresAdministrativeReview: true,
        recipientPhone: 'secret-phone-099',
      }),
    );
    rows.RouteEmergency = [
      {
        id: 'em-1',
        routeId: 'int-route',
        reason: 'Engine failure',
        declaredAt,
        declaredById: 'admin-1',
        closedAt: null,
      },
    ];
    rows.RouteUnitRecovery = [
      {
        id: 'rec-1',
        emergencyId: 'em-1',
        routeId: 'int-route',
        stopId: 'stop-d',
        orderId: 'detached',
        orderItemId: 'item-1',
        unitNumber: 1,
        productId: 'prod-1',
        recoveredAt: null,
      },
      {
        id: 'rec-2',
        emergencyId: 'em-1',
        routeId: 'int-route',
        stopId: 'stop-d',
        orderId: 'detached',
        orderItemId: 'item-1',
        unitNumber: 2,
        productId: 'prod-1',
        recoveredAt: declaredAt.add({ minutes: 5 }),
      },
    ];
    rows.OrderItemLoss = [];

    const models = Object.fromEntries(
      Object.entries(rows).map(([name]) => {
        const query = (filter: any = {}) => ({
          where: (next: any) => query({ ...filter, ...next }),
          first: async () =>
            rows[name]!.find((r) =>
              Object.entries(filter).every(([k, v]) => r[k] === v),
            ) ?? null,
          all: async () =>
            rows[name]!.filter((r) =>
              Object.entries(filter).every(([k, v]) => r[k] === v),
            ),
          create: writes,
          update: writes,
          delete: writes,
        });
        return [name, { ...query(), where: query }];
      }),
    );
    const svc = new RouteUrgencyService(
      { client: { orm: { public: models }, transaction: writes } } as any,
      { effective: async () => ({ isAvailable: true }) } as any,
      haversineRoads(),
    );

    // Even if administrative review were false, unresolved RouteUnitRecovery keeps propose BLOCKED.
    rows.Order![1]!.requiresAdministrativeReview = false;
    const blocked = await svc.propose('detached');
    expect(blocked.kind).toBe('BLOCKED');
    expect(blocked.reasons).toContain('RECOVERY_PENDING');

    rows.Order![1]!.requiresAdministrativeReview = true;
    const inbox: any = await svc.inbox();
    expect(inbox.urgencies.map((u: any) => u.orderId)).toEqual(['urgent']);
    expect(inbox.incidents.some((i: any) => i.orderId === 'detached')).toBe(true);
    expect(inbox.interruptedRoutes).toEqual([
      {
        routeId: 'int-route',
        emergencyId: 'em-1',
        declaredAt: declaredAt.toString(),
        closedAt: null,
        driverId: 'driver',
        returnedAt: null,
        pendingUnitsCount: 1,
        totalUnitsCount: 2,
      },
    ]);
    expect(inbox.pendingRecoveries).toEqual([
      {
        recoveryId: 'rec-1',
        emergencyId: 'em-1',
        routeId: 'int-route',
        orderId: 'detached',
        orderItemId: 'item-1',
        unitNumber: 1,
        productId: 'prod-1',
        lossId: null,
        replacementState: null,
      },
    ]);
    expect(JSON.stringify(inbox)).not.toContain('secret-phone-099');
    expect(writes).not.toHaveBeenCalled();
  });

  describe('Incident inbox readiness & allowedActions projection (T4 / S3)', () => {
    const t0 = instant().subtract({ minutes: 30 });
    const t1 = instant().subtract({ minutes: 20 });
    const t2 = instant().subtract({ minutes: 10 });
    const futureSlot = () => {
      const zone = 'America/Guayaquil';
      const soon = instant().add({ minutes: 30 });
      const start = soon.subtract({ minutes: 5 });
      const end = soon.add({ minutes: 5 });
      if (
        businessDay(start).toString() === businessDay(end).toString() &&
        businessDay(start).toString() === businessDay(soon).toString()
      ) {
        return {
          scheduledDeliveryDate: soon.toString(),
          deliveryWindowStart: start.toString(),
          deliveryWindowEnd: end.toString(),
        };
      }
      const tomorrowNoon = Temporal.Now.zonedDateTimeISO(zone)
        .toPlainDate()
        .add({ days: 1 })
        .toZonedDateTime({ timeZone: zone, plainTime: '12:00' })
        .toInstant();
      return {
        scheduledDeliveryDate: tomorrowNoon.toString(),
        deliveryWindowStart: tomorrowNoon.subtract({ minutes: 10 }).toString(),
        deliveryWindowEnd: tomorrowNoon.add({ minutes: 10 }).toString(),
      };
    };

    const seedFailedOrder = (
      orderId: string,
      opts: {
        routeId?: string;
        routeStatus?: string;
        stopId?: string;
        attemptId?: string;
        recordedAt?: Temporal.Instant;
        claimReleasedAt?: Temporal.Instant | null;
      } = {},
    ) => {
      const routeId = opts.routeId ?? `route-${orderId}`;
      const stopId = opts.stopId ?? `stop-${orderId}`;
      const attemptId = opts.attemptId ?? `att-${orderId}`;
      const recordedAt = opts.recordedAt ?? t1;
      const claimReleasedAt =
        opts.claimReleasedAt === undefined ? recordedAt : opts.claimReleasedAt;

      if (!rows.Route!.some((r) => r.id === routeId)) {
        rows.Route!.push({
          id: routeId,
          status: opts.routeStatus ?? 'IN_PROGRESS',
          zoneId: 'zone',
          date: instant(),
          driverId: 'driver',
          startedAt: t0,
        });
      }
      if (!rows.Order!.some((o) => o.id === orderId)) {
        rows.Order!.push(
          order(orderId, {
            status: 'ASSIGNED',
            routeId,
            requiresAdministrativeReview: true,
            recipientPhone: 'secret-incident-phone',
          }),
        );
      }
      rows.RouteStop!.push({
        id: stopId,
        routeId,
        orderId,
        sequence: 1,
        isLegacy: false,
        outcome: 'FAILED',
      });
      rows.DeliveryAttempt!.push({
        id: attemptId,
        stopId,
        driverId: 'driver',
        outcome: 'FAILED',
        failureReason: 'RECIPIENT_ABSENT',
        recordedAt,
        context: { description: 'private-attempt-notes' },
      });
      rows.OrderClaim!.push({
        id: `claim-${orderId}-${routeId}`,
        routeId,
        orderId,
        claimedAt: t0,
        releasedAt: claimReleasedAt,
      });
      return { routeId, stopId, attemptId };
    };

    it('tracks early-released IN_PROGRESS failure from WAITING_STORE_READINESS -> CONTACTED -> READY_AT_STORE without altering normal urgencies or leaking PII', async () => {
      const { routeId, attemptId } = seedFailedOrder('inc-1');

      // 1. Immediately after failure + early claim release: CONTACT & CONFIRM_INCIDENT_READY allowed; RESCHEDULE & PICKUP_AGREE blocked by readiness.
      const beforeContact: any = await service.inbox();
      expect(beforeContact.urgencies.map((u: any) => u.orderId)).toEqual(['urgent']);
      const inc1 = beforeContact.incidents.find((i: any) => i.orderId === 'inc-1');
      expect(inc1).toMatchObject({
        orderId: 'inc-1',
        routeId,
        status: 'WAITING_STORE_READINESS',
        ownership: 'FAILED_DELIVERY',
        latestFailedAttemptId: attemptId,
        readiness: null,
        emergencyId: null,
        emergency: null,
        activeAgreementId: null,
      });
      expect(inc1.allowedActions.CONTACT).toEqual({
        allowed: true,
        reasonCode: null,
        reason: null,
      });
      expect(inc1.allowedActions.CONFIRM_INCIDENT_READY).toEqual({
        allowed: true,
        reasonCode: null,
        reason: null,
      });
      expect(inc1.allowedActions.RESCHEDULE).toMatchObject({
        allowed: false,
        reasonCode: 'INCIDENT_NOT_READY_AT_STORE',
      });
      expect(inc1.allowedActions.PICKUP_AGREE).toMatchObject({
        allowed: false,
        reasonCode: 'INCIDENT_NOT_READY_AT_STORE',
      });
      expect(inc1.allowedActions.PICKUP_DECLINE.allowed).toBe(true);
      expect(inc1.allowedActions.PICKUP_CONFIRM).toMatchObject({
        allowed: false,
        reasonCode: 'PICKUP_NOT_AGREED',
      });

      // 2. Customer contacted with confirmed future agreement, but readiness still unconfirmed.
      const slot = futureSlot();
      rows.DispatchIntervention!.push({
        id: 'contact-1',
        actorId: 'admin-1',
        orderId: 'inc-1',
        routeId,
        action: 'CONTACT',
        outcome: 'APPLIED',
        reason: 'Customer requested next slot (internal phone note)',
        recordedAt: t1.add({ minutes: 2 }),
        payload: {
          attemptId,
          agreementConfirmed: true,
          ...slot,
        },
        result: { orderId: 'inc-1', attemptId },
      });
      const afterContact: any = await service.inbox();
      const incContacted = afterContact.incidents.find((i: any) => i.orderId === 'inc-1');
      expect(incContacted.status).toBe('CONTACTED');
      expect(incContacted.activeAgreementId).toBe('contact-1');
      expect(incContacted.allowedActions.RESCHEDULE).toMatchObject({
        allowed: false,
        reasonCode: 'INCIDENT_NOT_READY_AT_STORE',
      });

      // 3. Store readiness confirmed for exact latest attempt.
      const readyAt = t1.add({ minutes: 5 });
      rows.DispatchIntervention!.push({
        id: 'ready-1',
        actorId: 'admin-2',
        orderId: 'inc-1',
        routeId,
        action: 'CONFIRM_INCIDENT_READY',
        outcome: 'APPLIED',
        reason: 'Sensitive internal warehouse note',
        recordedAt: readyAt,
        payload: { attemptId, extraInternalField: 'do-not-expose' },
        result: { orderId: 'inc-1', routeId, attemptId },
      });
      const afterReady: any = await service.inbox();
      const incReady = afterReady.incidents.find((i: any) => i.orderId === 'inc-1');
      expect(incReady.status).toBe('READY_AT_STORE');
      expect(incReady.readiness).toEqual({
        auditId: 'ready-1',
        attemptId,
        confirmedAt: readyAt.toString(),
        confirmedById: 'admin-2',
      });
      expect(incReady.allowedActions.CONFIRM_INCIDENT_READY).toMatchObject({
        allowed: false,
        reasonCode: 'INCIDENT_ALREADY_READY',
      });
      expect(incReady.allowedActions.RESCHEDULE).toEqual({
        allowed: true,
        reasonCode: null,
        reason: null,
      });
      expect(incReady.allowedActions.PICKUP_AGREE).toEqual({
        allowed: true,
        reasonCode: null,
        reason: null,
      });
      const serialized = JSON.stringify(afterReady);
      expect(serialized).not.toContain('secret-incident-phone');
      expect(serialized).not.toContain('private-attempt-notes');
      expect(serialized).not.toContain('do-not-expose');
      expect(serialized).not.toContain('Sensitive internal warehouse note');
      expect(writes).not.toHaveBeenCalled();
    });

    it('rejects stale readiness attestation when a newer canonical failed attempt exists', async () => {
      seedFailedOrder('stale-1', {
        routeId: 'r-old',
        routeStatus: 'COMPLETED',
        stopId: 'stop-old',
        attemptId: 'att-old',
        recordedAt: t1,
        claimReleasedAt: t1.add({ minutes: 1 }),
      });
      rows.DispatchIntervention!.push({
        id: 'ready-old',
        actorId: 'admin-1',
        orderId: 'stale-1',
        routeId: 'r-old',
        action: 'CONFIRM_INCIDENT_READY',
        outcome: 'APPLIED',
        recordedAt: t1.add({ minutes: 2 }),
        payload: { attemptId: 'att-old' },
        result: { attemptId: 'att-old' },
      });
      seedFailedOrder('stale-1', {
        routeId: 'r-new',
        routeStatus: 'IN_PROGRESS',
        stopId: 'stop-new',
        attemptId: 'att-new',
        recordedAt: t2,
        claimReleasedAt: t2,
      });

      const inbox: any = await service.inbox();
      const inc = inbox.incidents.find((i: any) => i.orderId === 'stale-1');
      expect(inc.latestFailedAttemptId).toBe('att-new');
      expect(inc.status).toBe('WAITING_STORE_READINESS');
      expect(inc.readiness).toBeNull();
      expect(inc.allowedActions.CONFIRM_INCIDENT_READY.allowed).toBe(true);
      expect(inc.allowedActions.RESCHEDULE).toMatchObject({
        allowed: false,
        reasonCode: 'INCIDENT_NOT_READY_AT_STORE',
      });
      expect(inc.allowedActions.PICKUP_AGREE).toMatchObject({
        allowed: false,
        reasonCode: 'INCIDENT_NOT_READY_AT_STORE',
      });
    });

    it('blocks readiness/resolution for unreleased active claim and active claim on another route while keeping CONTACT allowed', async () => {
      seedFailedOrder('unreleased', { claimReleasedAt: null });
      seedFailedOrder('other-claim', { claimReleasedAt: t1 });
      rows.OrderClaim!.push({
        id: 'claim-other-route',
        routeId: 'route-other',
        orderId: 'other-claim',
        claimedAt: t2,
        releasedAt: null,
      });

      const inbox: any = await service.inbox();
      const incUnreleased = inbox.incidents.find((i: any) => i.orderId === 'unreleased');
      const incOther = inbox.incidents.find((i: any) => i.orderId === 'other-claim');

      expect(incUnreleased.allowedActions.CONTACT.allowed).toBe(true);
      expect(incUnreleased.allowedActions.CONFIRM_INCIDENT_READY).toMatchObject({
        allowed: false,
        reasonCode: 'CLAIM_NOT_RELEASED',
      });
      expect(incUnreleased.allowedActions.PICKUP_AGREE).toMatchObject({
        allowed: false,
        reasonCode: 'CLAIM_NOT_RELEASED',
      });

      expect(incOther.allowedActions.CONTACT.allowed).toBe(true);
      expect(incOther.allowedActions.CONFIRM_INCIDENT_READY).toMatchObject({
        allowed: false,
        reasonCode: 'ORDER_CLAIMED_BY_ANOTHER_ROUTE',
      });
      expect(incOther.allowedActions.RESCHEDULE).toMatchObject({
        allowed: false,
        reasonCode: 'ORDER_CLAIMED_BY_ANOTHER_ROUTE',
      });
    });

    it('distinguishes genuine emergency custody from an ordinary failed stop on an INTERRUPTED route', async () => {
      const declaredAt = t2;
      rows.Route!.push({
        id: 'route-int',
        status: 'INTERRUPTED',
        zoneId: 'zone',
        date: instant(),
        driverId: 'driver',
        startedAt: t0,
        returnedAt: null,
      });
      // Stop 1 failed BEFORE emergency: no RouteUnitRecovery rows -> ordinary FAILED_DELIVERY.
      seedFailedOrder('failed-before-em', {
        routeId: 'route-int',
        routeStatus: 'INTERRUPTED',
        stopId: 'stop-em-1',
        attemptId: 'att-em-1',
        recordedAt: t1,
        claimReleasedAt: declaredAt,
      });
      // Stop 2 detached BY emergency: has RouteUnitRecovery -> EMERGENCY_CUSTODY.
      rows.Order!.push(
        order('detached-em', {
          status: 'PENDING',
          routeId: null,
          requiresAdministrativeReview: true,
        }),
      );
      rows.RouteEmergency = [
        {
          id: 'em-int-1',
          routeId: 'route-int',
          reason: 'Vehicle breakdown',
          declaredAt,
          declaredById: 'admin-1',
          closedAt: null,
        },
      ];
      rows.RouteUnitRecovery = [
        {
          id: 'rec-int-1',
          emergencyId: 'em-int-1',
          routeId: 'route-int',
          stopId: 'stop-em-2',
          orderId: 'detached-em',
          orderItemId: 'item-em-1',
          unitNumber: 1,
          productId: 'prod-1',
          recoveredAt: null,
        },
      ];
      rows.OrderItemLoss = [];

      const emModels = Object.fromEntries(
        Object.entries(rows).map(([name]) => {
          const query = (filter: any = {}) => ({
            where: (next: any) => query({ ...filter, ...next }),
            first: async () =>
              rows[name]!.find((r) =>
                Object.entries(filter).every(([k, v]) => r[k] === v),
              ) ?? null,
            all: async () =>
              rows[name]!.filter((r) =>
                Object.entries(filter).every(([k, v]) => r[k] === v),
              ),
            create: writes,
            update: writes,
            delete: writes,
          });
          return [name, { ...query(), where: query }];
        }),
      );
      const emService = new RouteUrgencyService(
        { client: { orm: { public: emModels }, transaction: writes } } as any,
        { effective: async () => ({ isAvailable: true }) } as any,
        haversineRoads(),
      );

      const inbox: any = await emService.inbox();
      const ordinary = inbox.incidents.find((i: any) => i.orderId === 'failed-before-em');
      const emergency = inbox.incidents.find((i: any) => i.orderId === 'detached-em');

      expect(ordinary).toMatchObject({
        ownership: 'FAILED_DELIVERY',
        status: 'WAITING_STORE_READINESS',
        emergencyId: null,
        emergency: null,
        latestFailedAttemptId: 'att-em-1',
      });
      expect(ordinary.allowedActions.CONTACT.allowed).toBe(true);
      expect(ordinary.allowedActions.CONFIRM_INCIDENT_READY.allowed).toBe(true);

      expect(emergency).toMatchObject({
        ownership: 'EMERGENCY_CUSTODY',
        status: 'EMERGENCY_CUSTODY',
        emergencyId: 'em-int-1',
        latestFailedAttemptId: null,
        readiness: null,
        emergency: {
          emergencyId: 'em-int-1',
          routeId: 'route-int',
          recoveryResolved: false,
          pendingUnitsCount: 1,
          totalUnitsCount: 1,
        },
      });
      expect(emergency.allowedActions.CONTACT).toMatchObject({
        allowed: false,
        reasonCode: 'RECOVERY_PENDING',
      });
      expect(emergency.allowedActions.CONFIRM_INCIDENT_READY).toMatchObject({
        allowed: false,
        reasonCode: 'RECOVERY_PENDING',
      });

      // Once emergency units are recovered, ownership remains EMERGENCY_CUSTODY and actions stay directed to emergency flow.
      rows.RouteUnitRecovery[0]!.recoveredAt = declaredAt.add({ minutes: 5 });
      const inboxResolved: any = await emService.inbox();
      const emergencyResolved = inboxResolved.incidents.find(
        (i: any) => i.orderId === 'detached-em',
      );
      expect(emergencyResolved.emergency.recoveryResolved).toBe(true);
      expect(emergencyResolved.emergency.pendingUnitsCount).toBe(0);
      expect(emergencyResolved.allowedActions.CONFIRM_INCIDENT_READY).toMatchObject({
        allowed: false,
        reasonCode: 'EMERGENCY_CUSTODY_SEPARATE',
      });
      expect(emergencyResolved.allowedActions.RESCHEDULE).toMatchObject({
        allowed: false,
        reasonCode: 'EMERGENCY_CUSTODY_SEPARATE',
      });
    });

    it('batches incident reads across multiple review orders instead of querying per order (no N+1)', async () => {
      const allCalls: Record<string, number> = {};
      const countedModels = Object.fromEntries(
        Object.entries(rows).map(([name]) => {
          allCalls[name] = 0;
          const query = (filter: any = {}) => ({
            where: (next: any) => query({ ...filter, ...next }),
            first: async () =>
              rows[name]!.find((r) =>
                Object.entries(filter).every(([k, v]) => r[k] === v),
              ) ?? null,
            all: async () => {
              allCalls[name] = (allCalls[name] ?? 0) + 1;
              return rows[name]!.filter((r) =>
                Object.entries(filter).every(([k, v]) => r[k] === v),
              );
            },
            create: writes,
            update: writes,
            delete: writes,
          });
          return [name, { ...query(), where: query }];
        }),
      );
      const countedSvc = new RouteUrgencyService(
        { client: { orm: { public: countedModels }, transaction: writes } } as any,
        { effective: async () => ({ isAvailable: true }) } as any,
        haversineRoads(),
      );

      for (let i = 1; i <= 5; i++) {
        seedFailedOrder(`batch-${i}`);
      }

      const inbox: any = await countedSvc.inbox();
      expect(inbox.incidents).toHaveLength(5);
      // Bounded constant queries for incidents regardless of having 5 review orders.
      expect(allCalls.RouteStop).toBeLessThanOrEqual(2);
      expect(allCalls.DeliveryAttempt).toBe(1);
      expect(allCalls.OrderPickup).toBe(1);
      expect(allCalls.OrderClaim).toBeLessThanOrEqual(2);
    });

    it('reads incident evidence in a REPEATABLE READ, READ ONLY snapshot and evaluates agreement expiry against DB clock_timestamp()', async () => {
      const { routeId, attemptId } = seedFailedOrder('snap-1');
      const slot = futureSlot();
      const dbClockPastExpiry = Temporal.Instant.from(slot.deliveryWindowStart).add({
        minutes: 1,
      });
      rows.DispatchIntervention!.push({
        id: 'contact-expiring',
        actorId: 'admin-1',
        orderId: 'snap-1',
        routeId,
        action: 'CONTACT',
        outcome: 'APPLIED',
        reason: 'Customer agreed window',
        recordedAt: t1.add({ minutes: 2 }),
        payload: {
          attemptId,
          agreementConfirmed: true,
          ...slot,
        },
        result: { orderId: 'snap-1', attemptId },
      });
      rows.DispatchIntervention!.push({
        id: 'ready-snap',
        actorId: 'admin-1',
        orderId: 'snap-1',
        routeId,
        action: 'CONFIRM_INCIDENT_READY',
        outcome: 'APPLIED',
        reason: 'At store',
        recordedAt: t1.add({ minutes: 3 }),
        payload: { attemptId },
        result: { orderId: 'snap-1', routeId, attemptId },
      });

      const executedSql: string[] = [];
      const queriedSql: string[] = [];
      const makeModels = (source: Record<string, any[]>) =>
        Object.fromEntries(
          Object.entries(source).map(([name]) => {
            const query = (filter: any = {}) => ({
              where: (next: any) =>
                query(typeof next === 'function' ? filter : { ...filter, ...next }),
              first: async () =>
                source[name]!.find((r) =>
                  Object.entries(filter).every(([k, v]) => r[k] === v),
                ) ?? null,
              all: async () =>
                source[name]!.filter((r) =>
                  Object.entries(filter).every(([k, v]) => r[k] === v),
                ),
              create: writes,
              update: writes,
              delete: writes,
            });
            return [name, { ...query(), where: query }];
          }),
        );

      const snapshotClient: any = {
        orm: { public: makeModels(rows) },
        raw: {
          sql: (strings: TemplateStringsArray) => {
            const text = strings.join('');
            return {
              affectedCount: () => ({ build: () => ({ text }) }),
              returnsRow: () => ({ build: () => ({ text }) }),
            };
          },
        },
        transaction: async (fn: (tx: any) => Promise<unknown>) => {
          // Freeze snapshot at transaction start; concurrent writes to live `rows` must not leak into `tx`.
          const frozen = Object.fromEntries(
            Object.entries(rows).map(([k, list]) => [
              k,
              list.map((row) => ({ ...row })),
            ]),
          );
          const tx = {
            orm: { public: makeModels(frozen) },
            execute: async (plan: { text: string }) => {
              executedSql.push(plan.text);
              // Simulate a concurrent write landing on live tables immediately after snapshot begins.
              rows.OrderPickup!.push({
                id: 'concurrent-pickup',
                orderId: 'snap-1',
                agreedAt: dbClockPastExpiry,
                confirmedAt: null,
              });
              return { affectedRows: 0 };
            },
            query: async (plan: { text: string }) => {
              queriedSql.push(plan.text);
              return [{ instant: dbClockPastExpiry }];
            },
          };
          return fn(tx);
        },
      };

      const snapshotSvc = new RouteUrgencyService(
        { client: snapshotClient } as any,
        { effective: async () => ({ isAvailable: true }) } as any,
        haversineRoads(),
      );

      const inbox: any = await snapshotSvc.inbox();
      expect(executedSql).toContain(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      expect(queriedSql.some((sql) => sql.includes('clock_timestamp()'))).toBe(
        true,
      );

      const inc = inbox.incidents.find((i: any) => i.orderId === 'snap-1');
      // Concurrent OrderPickup written outside snapshot did not tear the incident view.
      expect(inc.pickup).toBeNull();
      expect(inc.status).toBe('READY_AT_STORE');
      // DB clock is past deliveryWindowStart even though Node wall clock is before it:
      // agreement must be treated as expired.
      expect(inc.activeAgreementId).toBeNull();
      expect(inc.allowedActions.RESCHEDULE).toMatchObject({
        allowed: false,
        reasonCode: 'RESCHEDULE_AGREEMENT_REQUIRED',
      });
      expect(writes).not.toHaveBeenCalled();
    });
  });
});
