import { OrderStatus } from '../orders/dto/update-order-status.dto.js';
import {
  RouteStatus,
  VisitOutcome,
  canTransitionRoute,
  canMutateRouteStructure,
  canCompleteRoute,
  canReturnToDepot,
  holdsDriverReservation,
  isOrderPlanningEligible,
} from './route-lifecycle.policy.js';

const states = Object.values(RouteStatus);
const release = {
  auditRecordId: 'audit-1',
  administratorId: 'admin-1',
  reason: 'Verified historical release',
};
const returnedAt = new Date('2026-10-09T12:00:00Z');

describe('Route lifecycle policy', () => {
  it('defines exactly five verified states', () => {
    expect(states).toEqual([
      'DRAFT',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'INTERRUPTED',
    ]);
  });

  it.each(states)('allows only valid forward transitions from %s', (from) => {
    const allowed: Partial<Record<RouteStatus, readonly RouteStatus[]>> = {
      [RouteStatus.DRAFT]: [RouteStatus.ASSIGNED],
      [RouteStatus.ASSIGNED]: [RouteStatus.IN_PROGRESS],
      [RouteStatus.IN_PROGRESS]: [
        RouteStatus.COMPLETED,
        RouteStatus.INTERRUPTED,
      ],
    };
    for (const to of states) {
      expect(canTransitionRoute(from, to)).toBe(
        Boolean(allowed[from]?.includes(to)),
      );
    }
  });

  it('does not infer transitions from unverified legacy state', () => {
    for (const to of states) expect(canTransitionRoute(null, to)).toBe(false);
  });

  it.each([null, ...states])(
    'freezes structure and gates return for %s',
    (status) => {
      expect(canMutateRouteStructure(status)).toBe(
        status === RouteStatus.DRAFT || status === RouteStatus.ASSIGNED,
      );
      expect(canReturnToDepot(status)).toBe(
        status === RouteStatus.COMPLETED || status === RouteStatus.INTERRUPTED,
      );
    },
  );

  it('requires paired start/completion evidence for COMPLETED return and only start evidence for INTERRUPTED return', () => {
    const started = { startedAt: returnedAt, startedById: 'driver-1' };
    const completed = {
      ...started,
      completedAt: returnedAt,
      completedById: 'driver-1',
    };
    expect(canReturnToDepot(RouteStatus.COMPLETED, completed)).toBe(true);
    expect(canReturnToDepot(RouteStatus.COMPLETED, started)).toBe(false);
    expect(canReturnToDepot(RouteStatus.INTERRUPTED, started)).toBe(true);
    expect(
      canReturnToDepot(RouteStatus.INTERRUPTED, {
        startedAt: returnedAt,
        startedById: null,
      }),
    ).toBe(false);
    expect(
      canReturnToDepot(RouteStatus.IN_PROGRESS, completed),
    ).toBe(false);
  });

  it.each([null, ...states])(
    'requires IN_PROGRESS and one to four resolved visits for %s',
    (status) => {
      for (const length of [0, 1, 2, 3, 4, 5]) {
        const outcomes = Array.from({ length }, (_, index) =>
          index % 2 ? VisitOutcome.FAILED : VisitOutcome.SUCCESSFUL,
        );
        expect(canCompleteRoute(status, outcomes)).toBe(
          status === RouteStatus.IN_PROGRESS && length >= 1 && length <= 4,
        );
      }
      for (const unresolved of [null, VisitOutcome.PENDING]) {
        expect(
          canCompleteRoute(status, [VisitOutcome.SUCCESSFUL, unresolved]),
        ).toBe(false);
      }
    },
  );

  it.each([null, ...states])(
    'holds the driver until valid completion or interruption and return for %s',
    (status) => {
      expect(holdsDriverReservation({ status, returnedAt: null })).toBe(
        status !== RouteStatus.DRAFT,
      );
      expect(
        holdsDriverReservation({
          status,
          returnedAt,
          returnedById: 'actor-1',
        }),
      ).toBe(
        status !== RouteStatus.DRAFT &&
          status !== RouteStatus.COMPLETED &&
          status !== RouteStatus.INTERRUPTED,
      );
      expect(holdsDriverReservation({ status, returnedAt })).toBe(
        status !== RouteStatus.DRAFT,
      );
      expect(
        holdsDriverReservation({
          status,
          returnedAt: new Date('invalid'),
          returnedById: 'actor-1',
        }),
      ).toBe(status !== RouteStatus.DRAFT);
    },
  );

  it('releases a legacy hold only with explicit administrative evidence, not return time', () => {
    const context = { status: null, returnedAt: null, legacyRelease: release };
    expect(holdsDriverReservation(context)).toBe(false);
    expect(context).toEqual({
      status: null,
      returnedAt: null,
      legacyRelease: release,
    });
    for (const field of ['auditRecordId', 'administratorId', 'reason']) {
      expect(
        holdsDriverReservation({
          ...context,
          legacyRelease: { ...release, [field]: ' ' },
        }),
      ).toBe(true);
    }
    expect(
      holdsDriverReservation({ status: null, returnedAt, legacyRelease: null }),
    ).toBe(true);
    for (const status of [
      RouteStatus.ASSIGNED,
      RouteStatus.IN_PROGRESS,
      RouteStatus.COMPLETED,
    ]) {
      expect(
        holdsDriverReservation({
          status,
          returnedAt: null,
          legacyRelease: release,
        }),
      ).toBe(true);
    }
  });

  it.each([null, ...Object.values(OrderStatus)])(
    'requires commercial PENDING and both eligibility gates for %s',
    (status) => {
      for (const reserved of [false, true]) {
        for (const blocked of [false, true]) {
          expect(isOrderPlanningEligible(status, reserved, blocked)).toBe(
            status === OrderStatus.PENDING && !reserved && !blocked,
          );
        }
      }
    },
  );
});
