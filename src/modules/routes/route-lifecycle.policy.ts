import { OrderStatus } from '../orders/dto/update-order-status.dto.js';

export enum RouteStatus {
  DRAFT = 'DRAFT',
  ASSIGNED = 'ASSIGNED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

export enum VisitOutcome {
  PENDING = 'PENDING',
  SUCCESSFUL = 'SUCCESSFUL',
  FAILED = 'FAILED',
}

// Evidence must come from an audited administrative reconciliation, not client input.
export interface LegacyReservationRelease {
  readonly auditRecordId: string;
  readonly administratorId: string;
  readonly reason: string;
}

export interface DriverReservationContext {
  readonly status: RouteStatus | null;
  readonly returnedAt: Date | null;
  readonly legacyRelease?: LegacyReservationRelease | null;
}

export function canTransitionRoute(
  from: RouteStatus | null,
  to: RouteStatus,
): boolean {
  const next: Readonly<Partial<Record<RouteStatus, RouteStatus>>> = {
    [RouteStatus.DRAFT]: RouteStatus.ASSIGNED,
    [RouteStatus.ASSIGNED]: RouteStatus.IN_PROGRESS,
    [RouteStatus.IN_PROGRESS]: RouteStatus.COMPLETED,
  };
  return from !== null && next[from] === to;
}

export function canMutateRouteStructure(status: RouteStatus | null): boolean {
  return status === RouteStatus.DRAFT || status === RouteStatus.ASSIGNED;
}

export function canCompleteRoute(
  status: RouteStatus | null,
  outcomes: readonly (VisitOutcome | null)[],
): boolean {
  return (
    status === RouteStatus.IN_PROGRESS &&
    outcomes.length >= 1 &&
    outcomes.length <= 4 &&
    outcomes.every(
      (outcome) =>
        outcome === VisitOutcome.SUCCESSFUL || outcome === VisitOutcome.FAILED,
    )
  );
}

export function canReturnToDepot(status: RouteStatus | null): boolean {
  return status === RouteStatus.COMPLETED;
}

// Pure policy only: persistence, ownership and evidence validation belong to callers.
export function holdsDriverReservation(
  context: DriverReservationContext,
): boolean {
  if (context.status === RouteStatus.DRAFT) return false;
  if (context.status === null) {
    const evidence = context.legacyRelease;
    return !(
      evidence &&
      [evidence.auditRecordId, evidence.administratorId, evidence.reason].every(
        (value) => typeof value === 'string' && value.trim().length > 0,
      )
    );
  }
  return !(
    context.status === RouteStatus.COMPLETED &&
    context.returnedAt instanceof Date &&
    Number.isFinite(context.returnedAt.getTime())
  );
}

export function isOrderPlanningEligible(
  status: OrderStatus | null,
  hasActiveReservation: boolean,
  requiresAdministrativeReview: boolean,
): boolean {
  return (
    status === OrderStatus.PENDING &&
    hasActiveReservation === false &&
    requiresAdministrativeReview === false
  );
}
