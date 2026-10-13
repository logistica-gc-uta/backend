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
});
