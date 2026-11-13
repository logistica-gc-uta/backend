import { RouteUrgencyService } from './route-urgency.service.js';
import { businessDay, nowInstant } from '../../common/temporal.util.js';

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
      undefined,
      coverageSvc,
    );

    const p = await svc.propose('urgent-store');
    expect(p.kind).toBe('INSERT');
    expect(p.routeId).toBe('today-draft');
    expect(p.zoneId).toBeNull();
    expect(p.orderIds).toEqual(expect.arrayContaining(['td-old', 'urgent-store']));
  });
});
