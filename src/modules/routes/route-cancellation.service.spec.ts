import { ConflictException, NotFoundException } from '@nestjs/common';
import { nowInstant } from '../../common/temporal.util.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { RealtimeChange } from '../realtime/realtime.contract.js';
import type { DispatchInterventionDto } from './dto/dispatch-intervention.dto.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { RouteCancellationService, type CancellationAudit } from './route-cancellation.service.js';

type Row = Record<string, any>;
type Rows = Record<string, Row[]>;

function createHarness() {
  const lockLog: string[] = [];
  const rows: Rows = {
    Driver: [{ id: 'driver-1', userId: 'driver-user-1', isAvailable: false }],
    DriverAbsence: [],
    DriverReservation: [
      {
        id: 'res-1',
        driverId: 'driver-1',
        routeId: 'route-1',
        reservedAt: nowInstant(),
        releasedAt: null,
      },
    ],
    Route: [
      {
        id: 'route-1',
        driverId: 'driver-1',
        zoneId: 'zone-1',
        status: 'ASSIGNED',
        startedAt: null,
        startedById: null,
        completedAt: null,
        completedById: null,
        returnedAt: null,
        returnedById: null,
        cancelledAt: null,
        cancelledById: null,
        cancelReason: null,
      },
    ],
    RouteStop: [
      {
        id: 'stop-2',
        routeId: 'route-1',
        orderId: 'order-b',
        sequence: 1,
        outcome: 'PENDING',
        isLegacy: false,
      },
      {
        id: 'stop-1',
        routeId: 'route-1',
        orderId: 'order-a',
        sequence: 2,
        outcome: 'PENDING',
        isLegacy: false,
      },
    ],
    OrderClaim: [
      {
        id: 'claim-b',
        routeId: 'route-1',
        orderId: 'order-b',
        claimedAt: nowInstant(),
        releasedAt: null,
      },
      {
        id: 'claim-a',
        routeId: 'route-1',
        orderId: 'order-a',
        claimedAt: nowInstant(),
        releasedAt: null,
      },
    ],
    Order: [
      {
        id: 'order-b',
        routeId: 'route-1',
        stopOrder: 1,
        status: 'ASSIGNED',
        requiresAdministrativeReview: false,
      },
      {
        id: 'order-a',
        routeId: 'route-1',
        stopOrder: 2,
        status: 'ASSIGNED',
        requiresAdministrativeReview: false,
      },
    ],
    DeliveryAttempt: [],
    RouteEmergency: [],
    LegacyRouteReconciliation: [],
    DispatchIntervention: [],
    User: [{ id: 'admin-1', role: 'ADMIN' }],
  };

  const models = Object.fromEntries(
    Object.keys(rows).map((name) => [
      name,
      {
        where: (filter: Record<string, unknown> = {}) => {
          const matching = () =>
            rows[name]!.filter((row) =>
              Object.entries(filter).every(([k, v]) => row[k] === v),
            );
          return {
            first: async () => matching()[0] ?? null,
            all: async () => [...matching()],
            update: async (change: Record<string, unknown>) => {
              if (
                (name === 'Driver' || name === 'Route' || name === 'Order') &&
                Object.keys(change).length === 1 &&
                'id' in change
              ) {
                lockLog.push(`${name}:${String(change.id)}`);
              }
              const row = matching()[0];
              if (!row) return null;
              Object.assign(row, change);
              return row;
            },
          };
        },
        create: async (data: Row) => {
          const created = { id: `${name.toLowerCase()}-${rows[name]!.length + 1}`, ...data };
          rows[name]!.push(created);
          return created;
        },
      },
    ]),
  );

  const tx = { orm: { public: models } } as any;
  const availability = new RouteAvailabilityService({
    client: tx,
  } as unknown as PrismaService);
  const service = new RouteCancellationService(availability);
  const changes: RealtimeChange[] = [];
  const dto: DispatchInterventionDto = {
    action: 'CANCEL_ROUTE',
    requestId: '11111111-1111-4111-8111-111111111111',
    routeId: 'route-1',
    reason: '  Vehicle breakdown before departure  ',
  };
  const createAudit: CancellationAudit = async (routeId, result, orderId) => {
    const audits = rows.DispatchIntervention!;
    const audit = {
      id: `dispatchintervention-${audits.length + 1}`,
      requestId: dto.requestId,
      actorId: 'admin-1',
      routeId,
      orderId,
      action: dto.action,
      reason: dto.reason.trim(),
      outcome: 'APPLIED',
      recordedAt: nowInstant(),
      payload: { requestId: dto.requestId, action: dto.action, routeId, reason: dto.reason },
      result: JSON.parse(JSON.stringify(result)) as Awaited<ReturnType<CancellationAudit>>['result'],
    };
    audits.push(audit);
    return audit;
  };

  return { rows, lockLog, tx, availability, service, changes, dto, createAudit };
}

describe('RouteCancellationService', () => {
  it('acquires locks in Driver -> Route -> sorted Orders order, preserves stops, releases claims/reservation, restores PENDING orders, and queues route/order/driver hints only', async () => {
    const h = createHarness();
    const audit = await h.service.cancel(h.tx, h.dto, 'admin-1', h.changes, h.createAudit);

    expect(h.lockLog).toEqual([
      'Driver:driver-1',
      'Route:route-1',
      'Order:order-a',
      'Order:order-b',
    ]);
    expect(audit).toMatchObject({
      action: 'CANCEL_ROUTE',
      outcome: 'APPLIED',
      routeId: 'route-1',
      orderId: null,
      reason: 'Vehicle breakdown before departure',
    });

    const route = h.rows.Route![0]!;
    expect(route).toMatchObject({
      status: 'CANCELLED',
      driverId: 'driver-1',
      cancelledById: 'admin-1',
      cancelReason: 'Vehicle breakdown before departure',
      startedAt: null,
      completedAt: null,
      returnedAt: null,
    });
    expect(route.cancelledAt).not.toBeNull();
    expect(h.rows.RouteStop).toHaveLength(2);
    expect(h.rows.OrderClaim!.every((c) => c.releasedAt === route.cancelledAt)).toBe(true);
    expect(h.rows.DriverReservation![0]!.releasedAt).toBe(route.cancelledAt);
    expect(h.rows.Order!.every((o) => o.status === 'PENDING' && o.routeId === null && o.stopOrder === null)).toBe(true);
    expect(h.rows.Driver![0]!.isAvailable).toBe(true);

    expect(h.changes).toEqual([
      { type: 'route.updated', routeId: 'route-1', status: 'CANCELLED' },
      {
        type: 'order.status.updated',
        orderId: 'order-a',
        status: 'PENDING',
        requiresAdministrativeReview: false,
      },
      {
        type: 'order.status.updated',
        orderId: 'order-b',
        status: 'PENDING',
        requiresAdministrativeReview: false,
      },
      { type: 'driver.availability.updated', driverId: 'driver-1', available: true },
    ]);
    expect(h.changes.some((c) => c.type === 'dispatch.incident.updated')).toBe(false);
  });

  it('publishes driver availability as false when driver has an active DriverAbsence covering today', async () => {
    const h = createHarness();
    const today = Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate().toString();
    h.rows.DriverAbsence!.push({
      id: 'abs-1',
      driverId: 'driver-1',
      startDate: today,
      endDate: today,
      cancelledAt: null,
      reason: 'Medical leave',
    });

    await h.service.cancel(h.tx, h.dto, 'admin-1', h.changes, h.createAudit);
    expect(h.changes).toContainEqual({
      type: 'driver.availability.updated',
      driverId: 'driver-1',
      available: false,
    });
  });

  it('throws 404 when route does not exist with zero writes', async () => {
    const h = createHarness();
    h.rows.Route = [];
    await expect(
      h.service.cancel(h.tx, h.dto, 'admin-1', h.changes, h.createAudit),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.rows.DispatchIntervention).toHaveLength(0);
    expect(h.changes).toHaveLength(0);
  });

  it.each([null, 'DRAFT', 'IN_PROGRESS', 'COMPLETED', 'INTERRUPTED', 'CANCELLED'])(
    'rejects non-eligible route status %s with zero business writes',
    async (status) => {
      const h = createHarness();
      h.rows.Route![0]!.status = status;
      await expect(
        h.service.cancel(h.tx, h.dto, 'admin-1', h.changes, h.createAudit),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(h.rows.DispatchIntervention).toHaveLength(0);
      expect(h.rows.Route![0]!.cancelledAt).toBeNull();
      expect(h.rows.OrderClaim!.every((c) => c.releasedAt === null)).toBe(true);
      expect(h.rows.DriverReservation![0]!.releasedAt).toBeNull();
      expect(h.changes).toHaveLength(0);
    },
  );

  it.each([
    'missing-reservation',
    'missing-claim',
    'non-pending-stop',
    'existing-attempt',
    'order-under-review',
    'order-wrong-status',
    'stray-order-pointer',
    'started-timestamp-present',
  ])('rejects incoherent assigned route (%s) with zero writes', async (kind) => {
    const h = createHarness();
    if (kind === 'missing-reservation') h.rows.DriverReservation = [];
    if (kind === 'missing-claim') h.rows.OrderClaim = [h.rows.OrderClaim![0]!];
    if (kind === 'non-pending-stop') h.rows.RouteStop![0]!.outcome = 'FAILED';
    if (kind === 'existing-attempt')
      h.rows.DeliveryAttempt!.push({ id: 'att-1', stopId: 'stop-1', outcome: 'FAILED' });
    if (kind === 'order-under-review')
      h.rows.Order![0]!.requiresAdministrativeReview = true;
    if (kind === 'order-wrong-status') h.rows.Order![0]!.status = 'CANCELLED';
    if (kind === 'stray-order-pointer')
      h.rows.Order!.push({
        id: 'order-stray',
        routeId: 'route-1',
        status: 'ASSIGNED',
        requiresAdministrativeReview: false,
      });
    if (kind === 'started-timestamp-present')
      h.rows.Route![0]!.startedAt = nowInstant();

    await expect(
      h.service.cancel(h.tx, h.dto, 'admin-1', h.changes, h.createAudit),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.rows.DispatchIntervention).toHaveLength(0);
    expect(h.rows.Route![0]!.status).toBe('ASSIGNED');
    expect(h.changes).toHaveLength(0);
  });
});
