import { ConflictException, NotFoundException } from '@nestjs/common';
import { DispatchEmergencyService } from './dispatch-emergency.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import type { DispatchInterventionDto } from './dto/dispatch-intervention.dto.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { RealtimeChange } from '../realtime/realtime.contract.js';

type Row = Record<string, any>;
type Rows = Record<string, Row[]>;

const baseInstant = Temporal.Instant.from('2026-11-13T15:00:00Z');

function createHarness(seed: Partial<Rows> = {}) {
  const rows: Rows = {
    User: [{ id: 'admin-1', role: 'ADMIN' }],
    Driver: [{ id: 'driver-1', userId: 'driver-user-1', isAvailable: false }],
    DriverAbsence: [],
    DriverReservation: [],
    Route: [],
    RouteStop: [],
    Order: [],
    OrderItem: [],
    OrderClaim: [],
    OrderPickup: [],
    DeliveryAttempt: [],
    RouteEmergency: [],
    RouteUnitRecovery: [],
    OrderItemLoss: [],
    Product: [{ id: 'product-1', stock: 5 }],
    DispatchIntervention: [],
    LegacyRouteReconciliation: [],
    ...seed,
  };
  let seq = 0;
  const events: string[] = [];

  const models = Object.fromEntries(
    Object.keys(rows).map((name) => {
      const query = (filter: Row = {}) => {
        const matching = () =>
          rows[name]!.filter((r) =>
            Object.entries(filter).every(([k, v]) => r[k] === v),
          );
        const chain: any = {
          where: (next: Row) => query({ ...filter, ...next }),
          orderBy: () => chain,
          first: async () => (matching()[0] ? { ...matching()[0] } : null),
          all: async () => matching().map((r) => ({ ...r })),
          update: async (change: Row) => {
            const row = matching()[0];
            if (!row) return null;
            events.push(`update:${name}`);
            Object.assign(row, change);
            return { ...row };
          },
        };
        return chain;
      };
      return [
        name,
        {
          ...query(),
          where: query,
          create: async (value: Row) => {
            events.push(`create:${name}`);
            const row = { id: `${name}-${++seq}`, createdAt: baseInstant, ...value };
            rows[name]!.push(row);
            return { ...row };
          },
        },
      ];
    }),
  );

  const tx: any = { orm: { public: models } };
  const prisma = { client: tx } as unknown as PrismaService;
  const availability = new RouteAvailabilityService(prisma);
  const service = new DispatchEmergencyService(prisma, availability);
  const audits: Row[] = [];

  const createAudit = async (
    routeId: string | null,
    result: Record<string, unknown>,
    orderId: string | null = null,
  ) => {
    events.push('create:DispatchIntervention');
    const row = {
      id: `audit-${audits.length + 1}`,
      requestId: `req-${audits.length + 1}`,
      actorId: 'admin-1',
      orderId,
      routeId,
      action: 'TEST',
      reason: 'Operational emergency',
      outcome: 'APPLIED',
      recordedAt: baseInstant,
      payload: {},
      result,
    };
    audits.push(row);
    return row as never;
  };

  const dto = (body: Partial<DispatchInterventionDto>): DispatchInterventionDto =>
    ({
      requestId: `req-${++seq}`,
      reason: 'Vehicle breakdown on avenue',
      ...body,
    }) as DispatchInterventionDto;

  const run = async (
    body: Partial<DispatchInterventionDto>,
    actorId = 'admin-1',
  ) => {
    const changes: RealtimeChange[] = [];
    const audit = await service.handle(
      tx,
      dto(body),
      actorId,
      changes,
      createAudit,
    );
    return { audit, changes };
  };

  return { rows, events, service, availability, audits, run, tx };
}

function seedInProgressRoute(h: ReturnType<typeof createHarness>) {
  h.rows.Route!.push({
    id: 'route-1',
    status: 'IN_PROGRESS',
    driverId: 'driver-1',
    zoneId: 'zone-1',
    date: baseInstant,
    startedAt: baseInstant.subtract({ hours: 1 }),
    startedById: 'driver-user-1',
    completedAt: null,
    completedById: null,
    returnedAt: null,
    returnedById: null,
  });
  h.rows.DriverReservation!.push({
    id: 'res-1',
    routeId: 'route-1',
    driverId: 'driver-1',
    reservedAt: baseInstant.subtract({ hours: 2 }),
    releasedAt: null,
  });
  h.rows.Order!.push(
    {
      id: 'order-done',
      status: 'DELIVERED',
      routeId: 'route-1',
      stopOrder: 1,
      requiresAdministrativeReview: false,
    },
    {
      id: 'order-failed',
      status: 'ASSIGNED',
      routeId: 'route-1',
      stopOrder: 2,
      requiresAdministrativeReview: true,
    },
    {
      id: 'order-pending-1',
      status: 'IN_TRANSIT',
      routeId: 'route-1',
      stopOrder: 3,
      requiresAdministrativeReview: false,
    },
    {
      id: 'order-pending-2',
      status: 'IN_TRANSIT',
      routeId: 'route-1',
      stopOrder: 4,
      requiresAdministrativeReview: false,
    },
  );
  h.rows.RouteStop!.push(
    { id: 'stop-1', routeId: 'route-1', orderId: 'order-done', sequence: 1, outcome: 'SUCCESSFUL' },
    { id: 'stop-2', routeId: 'route-1', orderId: 'order-failed', sequence: 2, outcome: 'FAILED' },
    { id: 'stop-3', routeId: 'route-1', orderId: 'order-pending-1', sequence: 3, outcome: 'PENDING' },
    { id: 'stop-4', routeId: 'route-1', orderId: 'order-pending-2', sequence: 4, outcome: null },
  );
  h.rows.DeliveryAttempt!.push({
    id: 'attempt-2',
    stopId: 'stop-2',
    driverId: 'driver-1',
    outcome: 'FAILED',
    recordedAt: baseInstant.subtract({ minutes: 20 }),
  });
  h.rows.OrderClaim!.push(
    { id: 'claim-1', routeId: 'route-1', orderId: 'order-done', claimedAt: baseInstant, releasedAt: null },
    { id: 'claim-2', routeId: 'route-1', orderId: 'order-failed', claimedAt: baseInstant, releasedAt: null },
    { id: 'claim-3', routeId: 'route-1', orderId: 'order-pending-1', claimedAt: baseInstant, releasedAt: null },
    { id: 'claim-4', routeId: 'route-1', orderId: 'order-pending-2', claimedAt: baseInstant, releasedAt: null },
  );
  h.rows.OrderItem!.push(
    { id: 'item-b', orderId: 'order-pending-1', productId: 'product-1', quantity: 2 },
    { id: 'item-a', orderId: 'order-pending-1', productId: 'product-2', quantity: 1 },
    { id: 'item-c', orderId: 'order-pending-2', productId: 'product-1', quantity: 1 },
    { id: 'item-done', orderId: 'order-done', productId: 'product-1', quantity: 1 },
  );
}

describe('DispatchEmergencyService (#51)', () => {
  describe('EMERGENCY_DECLARE (S1)', () => {
    it('transitions IN_PROGRESS route to INTERRUPTED, preserves completed stops, releases claims, detaches pending orders, and creates unit recovery rows', async () => {
      const h = createHarness();
      seedInProgressRoute(h);

      const { audit, changes } = await h.run({
        action: 'EMERGENCY_DECLARE',
        routeId: 'route-1',
      });

      expect(h.rows.Route![0]!.status).toBe('INTERRUPTED');
      expect(h.rows.RouteEmergency).toHaveLength(1);
      const emergency = h.rows.RouteEmergency![0]!;
      expect(emergency).toMatchObject({
        routeId: 'route-1',
        declaredById: 'admin-1',
        reason: 'Vehicle breakdown on avenue',
      });

      // PG t1e_claim_history_guard requires DispatchIntervention audit before releasing claims.
      const auditIdx = h.events.indexOf('create:DispatchIntervention');
      const claimReleaseIdx = h.events.indexOf('update:OrderClaim');
      expect(auditIdx).toBeGreaterThan(-1);
      expect(claimReleaseIdx).toBeGreaterThan(auditIdx);

      // All active claims released at declaredAt.
      expect(
        h.rows.OrderClaim!.every(
          (c) => c.releasedAt?.toString() === emergency.declaredAt.toString(),
        ),
      ).toBe(true);

      // Completed stops & orders remain untouched; pending stops detached with administrative review.
      expect(h.rows.Order!.find((o) => o.id === 'order-done')).toMatchObject({
        status: 'DELIVERED',
        routeId: 'route-1',
        requiresAdministrativeReview: false,
      });
      expect(h.rows.Order!.find((o) => o.id === 'order-failed')).toMatchObject({
        status: 'ASSIGNED',
        routeId: 'route-1',
        requiresAdministrativeReview: true,
      });
      for (const orderId of ['order-pending-1', 'order-pending-2']) {
        expect(h.rows.Order!.find((o) => o.id === orderId)).toMatchObject({
          status: 'PENDING',
          routeId: null,
          stopOrder: null,
          requiresAdministrativeReview: true,
        });
      }

      // 3 units for order-pending-1 (item-a:1, item-b:2) + 1 unit for order-pending-2 (item-c:1).
      expect(h.rows.RouteUnitRecovery).toHaveLength(4);
      expect(
        h.rows.RouteUnitRecovery!.map((u) => [u.orderId, u.orderItemId, u.unitNumber]),
      ).toEqual([
        ['order-pending-1', 'item-a', 1],
        ['order-pending-1', 'item-b', 1],
        ['order-pending-1', 'item-b', 2],
        ['order-pending-2', 'item-c', 1],
      ]);

      expect(audit.result).toEqual({
        emergencyId: emergency.id,
        routeId: 'route-1',
        detachedOrderIds: ['order-pending-1', 'order-pending-2'],
        unitRecoveryCount: 4,
        preservedCompletedStopIds: ['stop-1', 'stop-2'],
      });

      expect(changes).toEqual([
        { type: 'route.updated', routeId: 'route-1', status: 'INTERRUPTED' },
        {
          type: 'order.status.updated',
          orderId: 'order-pending-1',
          status: 'PENDING',
          requiresAdministrativeReview: true,
        },
        {
          type: 'order.status.updated',
          orderId: 'order-pending-2',
          status: 'PENDING',
          requiresAdministrativeReview: true,
        },
        {
          type: 'dispatch.incident.updated',
          routeId: 'route-1',
          action: 'EMERGENCY_DECLARE',
        },
      ]);
    });

    it('rejects 404 when route is missing and 409 when route is not IN_PROGRESS or already has an emergency', async () => {
      const h = createHarness();
      await expect(
        h.run({ action: 'EMERGENCY_DECLARE', routeId: 'missing' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      seedInProgressRoute(h);
      h.rows.Route![0]!.status = 'ASSIGNED';
      await expect(
        h.run({ action: 'EMERGENCY_DECLARE', routeId: 'route-1' }),
      ).rejects.toBeInstanceOf(ConflictException);

      h.rows.Route![0]!.status = 'IN_PROGRESS';
      h.rows.RouteEmergency!.push({ id: 'em-existing', routeId: 'route-1' });
      await expect(
        h.run({ action: 'EMERGENCY_DECLARE', routeId: 'route-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('UNIT_RECOVERY_CONFIRM (S2)', () => {
    it('confirms individual recovery without touching stock and keeps multi-unit order blocked until all units resolve', async () => {
      const h = createHarness();
      seedInProgressRoute(h);
      await h.run({ action: 'EMERGENCY_DECLARE', routeId: 'route-1' });

      const unitsForOrder1 = h.rows.RouteUnitRecovery!.filter(
        (u) => u.orderId === 'order-pending-1',
      );
      const first = await h.run({
        action: 'UNIT_RECOVERY_CONFIRM',
        recoveryId: unitsForOrder1[0]!.id,
      });

      expect(first.audit.result).toMatchObject({
        recoveryId: unitsForOrder1[0]!.id,
        orderId: 'order-pending-1',
        orderAllUnitsResolved: false,
      });
      expect(h.rows.Product![0]!.stock).toBe(5);
      expect(
        h.rows.Order!.find((o) => o.id === 'order-pending-1')!
          .requiresAdministrativeReview,
      ).toBe(true);

      // Confirm remaining two units (or 1 confirmed + 1 PREPARED loss).
      await h.run({
        action: 'UNIT_RECOVERY_CONFIRM',
        recoveryId: unitsForOrder1[1]!.id,
      });
      const last = await h.run({
        action: 'UNIT_RECOVERY_CONFIRM',
        recoveryId: unitsForOrder1[2]!.id,
      });
      expect(last.audit.result).toMatchObject({
        orderId: 'order-pending-1',
        orderAllUnitsResolved: true,
      });
      expect(last.changes).toEqual([
        {
          type: 'dispatch.incident.updated',
          orderId: 'order-pending-1',
          action: 'UNIT_RECOVERY_CONFIRM',
          requiresAdministrativeReview: true,
        },
      ]);
    });

    it('rejects duplicate confirmation, missing recovery, and units with an active OrderItemLoss (while allowing cancelled losses)', async () => {
      const h = createHarness();
      seedInProgressRoute(h);
      await h.run({ action: 'EMERGENCY_DECLARE', routeId: 'route-1' });
      const unit = h.rows.RouteUnitRecovery![0]!;

      await expect(
        h.run({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: 'missing' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Active non-cancelled loss blocks unit recovery.
      h.rows.OrderItemLoss!.push({
        id: 'loss-1',
        orderId: unit.orderId,
        orderItemId: unit.orderItemId,
        unitNumber: unit.unitNumber,
        replacementPreparedAt: null,
        recoveredAt: null,
        cancelledAt: null,
      });
      await expect(
        h.run({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unit.id }),
      ).rejects.toBeInstanceOf(ConflictException);

      // Once cancelled, recovery succeeds.
      h.rows.OrderItemLoss![0]!.cancelledAt = baseInstant;
      await h.run({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unit.id });
      expect(unit.recoveredAt).toBeTruthy();

      // Re-confirming already recovered unit throws 409.
      await expect(
        h.run({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unit.id }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('EMERGENCY_CLOSE (S3)', () => {
    it('closes emergency even with pending unit recoveries and rejects closing twice or missing', async () => {
      const h = createHarness();
      await expect(
        h.run({ action: 'EMERGENCY_CLOSE', routeId: 'missing' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      seedInProgressRoute(h);
      await expect(
        h.run({ action: 'EMERGENCY_CLOSE', routeId: 'route-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      await h.run({ action: 'EMERGENCY_DECLARE', routeId: 'route-1' });
      const { audit, changes } = await h.run({
        action: 'EMERGENCY_CLOSE',
        routeId: 'route-1',
      });
      expect(h.rows.RouteEmergency![0]!.closedAt).toBeTruthy();
      expect(h.rows.RouteEmergency![0]!.closedById).toBe('admin-1');
      expect(audit.result).toMatchObject({ routeId: 'route-1' });
      expect(changes).toEqual([
        {
          type: 'dispatch.incident.updated',
          routeId: 'route-1',
          action: 'EMERGENCY_CLOSE',
        },
      ]);

      await expect(
        h.run({ action: 'EMERGENCY_CLOSE', routeId: 'route-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('EMERGENCY_DRIVER_RELEASE (S4)', () => {
    it('releases driver reservation on INTERRUPTED route via driver.userId, respecting #44 DriverAbsence', async () => {
      const h = createHarness();
      seedInProgressRoute(h);
      await h.run({ action: 'EMERGENCY_DECLARE', routeId: 'route-1' });

      // Active absence today keeps realtime availability false even though route hold clears.
      const today = Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate().toString();
      h.rows.DriverAbsence!.push({
        id: 'abs-1',
        driverId: 'driver-1',
        startDate: today,
        endDate: today,
        reason: 'Medical',
        cancelledAt: null,
      });

      const { audit, changes } = await h.run({
        action: 'EMERGENCY_DRIVER_RELEASE',
        routeId: 'route-1',
      });

      expect(h.rows.Route![0]!.returnedAt).toBeTruthy();
      expect(h.rows.Route![0]!.returnedById).toBe('admin-1');
      expect(h.rows.DriverReservation![0]!.releasedAt.toString()).toBe(
        h.rows.Route![0]!.returnedAt.toString(),
      );
      expect(h.rows.Driver![0]!.isAvailable).toBe(true);
      expect(audit.result).toMatchObject({
        routeId: 'route-1',
        driverId: 'driver-1',
        driverAvailable: true,
      });
      expect(changes).toEqual([
        { type: 'route.updated', routeId: 'route-1', status: 'INTERRUPTED' },
        {
          type: 'driver.availability.updated',
          driverId: 'driver-1',
          available: false,
        },
        {
          type: 'dispatch.incident.updated',
          routeId: 'route-1',
          action: 'EMERGENCY_DRIVER_RELEASE',
        },
      ]);

      // Cannot release twice.
      await expect(
        h.run({ action: 'EMERGENCY_DRIVER_RELEASE', routeId: 'route-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('EMERGENCY_REQUEUE (S5)', () => {
    it('blocks requeue with RECOVERY_PENDING while any unit is unrecovered or has only a PENDING loss replacement, and allows once all resolve', async () => {
      const h = createHarness();
      seedInProgressRoute(h);
      await h.run({ action: 'EMERGENCY_DECLARE', routeId: 'route-1' });
      const emergencyId = h.rows.RouteEmergency![0]!.id;
      const units = h.rows.RouteUnitRecovery!.filter(
        (u) => u.orderId === 'order-pending-1',
      );

      // 2 units recovered, 1 unit has a PENDING loss (replacementPreparedAt: null).
      await h.run({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: units[0]!.id });
      await h.run({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: units[1]!.id });
      h.rows.OrderItemLoss!.push({
        id: 'loss-pending',
        orderId: 'order-pending-1',
        orderItemId: units[2]!.orderItemId,
        unitNumber: units[2]!.unitNumber,
        replacementPreparedAt: null,
        recoveredAt: null,
        cancelledAt: null,
      });

      await expect(
        h.run({
          action: 'EMERGENCY_REQUEUE',
          orderId: 'order-pending-1',
          emergencyId,
        }),
      ).rejects.toMatchObject({
        response: { code: 'RECOVERY_PENDING' },
      });

      // Once replacement is PREPARED, requeue succeeds.
      h.rows.OrderItemLoss![0]!.replacementPreparedAt = baseInstant;
      const { audit, changes } = await h.run({
        action: 'EMERGENCY_REQUEUE',
        orderId: 'order-pending-1',
        emergencyId,
      });

      expect(h.rows.Order!.find((o) => o.id === 'order-pending-1')).toMatchObject({
        status: 'PENDING',
        requiresAdministrativeReview: false,
        routeId: null,
        stopOrder: null,
      });
      expect(audit.orderId).toBe('order-pending-1');
      expect(changes).toEqual([
        {
          type: 'order.status.updated',
          orderId: 'order-pending-1',
          status: 'PENDING',
          requiresAdministrativeReview: false,
        },
        {
          type: 'dispatch.incident.updated',
          orderId: 'order-pending-1',
          action: 'EMERGENCY_REQUEUE',
          requiresAdministrativeReview: false,
        },
      ]);
    });

    it('rejects requeue when order has an OrderPickup, active claim, or post-emergency FAILED attempt', async () => {
      const h = createHarness();
      seedInProgressRoute(h);
      await h.run({ action: 'EMERGENCY_DECLARE', routeId: 'route-1' });
      const emergencyId = h.rows.RouteEmergency![0]!.id;
      const unitOrder2 = h.rows.RouteUnitRecovery!.find(
        (u) => u.orderId === 'order-pending-2',
      )!;
      await h.run({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: unitOrder2.id });

      h.rows.OrderPickup!.push({
        id: 'pickup-1',
        orderId: 'order-pending-2',
        confirmedAt: null,
      });
      await expect(
        h.run({
          action: 'EMERGENCY_REQUEUE',
          orderId: 'order-pending-2',
          emergencyId,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      h.rows.OrderPickup = [];
      h.rows.DeliveryAttempt!.push({
        id: 'attempt-after',
        stopId: 'stop-4',
        outcome: 'FAILED',
        recordedAt: h.rows.RouteEmergency![0]!.declaredAt,
      });
      await expect(
        h.run({
          action: 'EMERGENCY_REQUEUE',
          orderId: 'order-pending-2',
          emergencyId,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('Queries: listEmergencies & emergencyDetail (S7)', () => {
    it('lists emergencies ordered by declaredAt desc with counts/pendingUnits and returns detail paired with active OrderItemLoss', async () => {
      const h = createHarness();
      seedInProgressRoute(h);
      await h.run({ action: 'EMERGENCY_DECLARE', routeId: 'route-1' });
      const units = h.rows.RouteUnitRecovery!;

      // 1 recovered, 1 lost prepared, 1 lost pending, 1 pending
      await h.run({ action: 'UNIT_RECOVERY_CONFIRM', recoveryId: units[0]!.id });
      h.rows.OrderItemLoss!.push(
        {
          id: 'loss-prep',
          orderId: units[1]!.orderId,
          orderItemId: units[1]!.orderItemId,
          unitNumber: units[1]!.unitNumber,
          replacementPreparedAt: baseInstant,
          recoveredAt: null,
          cancelledAt: null,
        },
        {
          id: 'loss-pend',
          orderId: units[2]!.orderId,
          orderItemId: units[2]!.orderItemId,
          unitNumber: units[2]!.unitNumber,
          replacementPreparedAt: null,
          recoveredAt: null,
          cancelledAt: null,
        },
        // Cancelled loss on units[3] must be ignored.
        {
          id: 'loss-cancelled',
          orderId: units[3]!.orderId,
          orderItemId: units[3]!.orderItemId,
          unitNumber: units[3]!.unitNumber,
          replacementPreparedAt: baseInstant,
          recoveredAt: null,
          cancelledAt: baseInstant,
        },
      );

      // Add an older emergency to verify desc ordering.
      h.rows.Route!.push({
        id: 'route-old',
        status: 'INTERRUPTED',
        driverId: 'driver-1',
        returnedAt: baseInstant,
        returnedById: 'admin-1',
      });
      h.rows.RouteEmergency!.push({
        id: 'em-old',
        routeId: 'route-old',
        reason: 'Earlier incident',
        declaredAt: baseInstant.subtract({ hours: 24 }),
        declaredById: 'admin-1',
        closedAt: null,
        closedById: null,
        closeReason: null,
      });

      const list = await h.service.listEmergencies();
      expect(list.map((e) => e.routeId)).toEqual(['route-1', 'route-old']);
      expect(list[0]!.counts).toEqual({
        totalUnits: 4,
        recoveredUnits: 1,
        lostPreparedUnits: 1,
        lostPendingUnits: 1,
        pendingUnits: 1,
      });
      expect(list[0]!.pendingUnits.map((u) => u.id)).toEqual([
        units[2]!.id,
        units[3]!.id,
      ]);

      const detail = await h.service.emergencyDetail('route-1');
      expect(detail.units).toHaveLength(4);
      expect(detail.units.find((u) => u.id === units[1]!.id)).toMatchObject({
        lossId: 'loss-prep',
        replacementPreparedAt: baseInstant.toString(),
        lossRecoveredAt: null,
      });
      expect(detail.units.find((u) => u.id === units[3]!.id)).toMatchObject({
        lossId: null,
        replacementPreparedAt: null,
      });

      await expect(h.service.emergencyDetail('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
