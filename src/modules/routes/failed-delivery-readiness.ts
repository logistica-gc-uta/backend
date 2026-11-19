export const FAILED_DELIVERY_READINESS_CODES = {
  ORDER_COMMERCIALLY_RESOLVED: 'ORDER_COMMERCIALLY_RESOLVED',
  INCIDENT_NOT_IN_REVIEW: 'INCIDENT_NOT_IN_REVIEW',
  FAILED_ATTEMPT_NOT_FOUND: 'FAILED_ATTEMPT_NOT_FOUND',
  STALE_FAILED_ATTEMPT: 'STALE_FAILED_ATTEMPT',
  INVALID_FAILED_ATTEMPT: 'INVALID_FAILED_ATTEMPT',
  CLAIM_NOT_RELEASED: 'CLAIM_NOT_RELEASED',
  ORDER_CLAIMED_BY_ANOTHER_ROUTE: 'ORDER_CLAIMED_BY_ANOTHER_ROUTE',
  EMERGENCY_CUSTODY_SEPARATE: 'EMERGENCY_CUSTODY_SEPARATE',
  INCIDENT_ALREADY_READY: 'INCIDENT_ALREADY_READY',
  INCIDENT_NOT_READY_AT_STORE: 'INCIDENT_NOT_READY_AT_STORE',
} as const;

export type FailedDeliveryReadinessCode =
  (typeof FAILED_DELIVERY_READINESS_CODES)[keyof typeof FAILED_DELIVERY_READINESS_CODES];

export interface CanonicalFailedStopLike {
  id: string;
  routeId: string;
  orderId: string;
  sequence: number | null;
  isLegacy?: boolean | null;
  outcome: string | null;
}

export interface CanonicalFailedAttemptLike {
  id: string;
  stopId: string;
  driverId?: string | null;
  outcome: string;
  failureReason: string | null;
  recordedAt: Temporal.Instant;
}

export interface OrderClaimLike {
  id: string;
  routeId: string;
  orderId: string;
  claimedAt: Temporal.Instant | null;
  releasedAt: Temporal.Instant | null;
}

export interface RouteEvidenceLike {
  id: string;
  status: string | null;
  driverId: string | null;
  startedAt?: Temporal.Instant | null;
}

export interface EmergencyRecoveryUnitLike {
  emergencyId: string;
  orderId: string;
}

export interface RouteEmergencyLike {
  id: string;
  declaredAt: Temporal.Instant;
}

export interface ReadinessAuditLike {
  id: string;
  action: string;
  outcome: string;
  orderId: string | null;
  payload: unknown;
  result: unknown;
}

export interface LatestCanonicalFailedAttempt<
  TStop extends CanonicalFailedStopLike = CanonicalFailedStopLike,
  TAttempt extends CanonicalFailedAttemptLike = CanonicalFailedAttemptLike,
> {
  stop: TStop;
  attempt: TAttempt;
}

const VALID_FAILED_ROUTE_STATUSES = new Set([
  'IN_PROGRESS',
  'COMPLETED',
  'INTERRUPTED',
]);

function readAttemptId(container: unknown): string | null {
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return null;
  }
  const value = (container as { attemptId?: unknown }).attemptId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function isCanonicalFailedStop(stop: CanonicalFailedStopLike): boolean {
  return !stop.isLegacy && stop.sequence !== null && stop.outcome === 'FAILED';
}

export function selectLatestCanonicalFailedAttempt<
  TStop extends CanonicalFailedStopLike,
  TAttempt extends CanonicalFailedAttemptLike,
>(
  stops: readonly TStop[],
  attempts: readonly TAttempt[],
): LatestCanonicalFailedAttempt<TStop, TAttempt> | null {
  const stopById = new Map<string, TStop>();
  for (const stop of stops) {
    if (isCanonicalFailedStop(stop)) {
      stopById.set(stop.id, stop);
    }
  }

  const candidates: LatestCanonicalFailedAttempt<TStop, TAttempt>[] = [];
  for (const attempt of attempts) {
    if (
      attempt.outcome !== 'FAILED' ||
      !attempt.failureReason ||
      !attempt.recordedAt
    ) {
      continue;
    }
    const stop = stopById.get(attempt.stopId);
    if (!stop) continue;
    candidates.push({ stop, attempt });
  }

  candidates.sort(
    (a, b) =>
      Temporal.Instant.compare(b.attempt.recordedAt, a.attempt.recordedAt) ||
      b.attempt.id.localeCompare(a.attempt.id),
  );
  return candidates[0] ?? null;
}

export function isEmergencyCustodyActiveForOrder(
  unitRecoveries: readonly EmergencyRecoveryUnitLike[],
  emergenciesById: ReadonlyMap<string, RouteEmergencyLike>,
  latestAttempt: CanonicalFailedAttemptLike | null,
): boolean {
  if (unitRecoveries.length === 0) return false;
  if (!latestAttempt) return true;
  for (const unit of unitRecoveries) {
    const emergency = emergenciesById.get(unit.emergencyId);
    if (
      emergency &&
      Temporal.Instant.compare(emergency.declaredAt, latestAttempt.recordedAt) >=
        0
    ) {
      return true;
    }
  }
  return false;
}

export function isValidFailedAttemptRoute(
  route: RouteEvidenceLike | null,
  attempt: CanonicalFailedAttemptLike,
): boolean {
  if (!route || !route.status || !VALID_FAILED_ROUTE_STATUSES.has(route.status)) {
    return false;
  }
  if (!route.driverId) return false;
  if (attempt.driverId && attempt.driverId !== route.driverId) return false;
  if (
    route.startedAt &&
    Temporal.Instant.compare(attempt.recordedAt, route.startedAt) < 0
  ) {
    return false;
  }
  return true;
}

export function hasReleasedFailedClaim(
  routeId: string,
  orderId: string,
  routeStatus: string | null,
  attempt: CanonicalFailedAttemptLike,
  routeClaims: readonly OrderClaimLike[],
  activeOrderClaims: readonly OrderClaimLike[],
): boolean {
  if (activeOrderClaims.length > 0) return false;
  if (!routeStatus || !VALID_FAILED_ROUTE_STATUSES.has(routeStatus)) {
    return false;
  }
  return routeClaims.some((claim) => {
    if (
      claim.routeId !== routeId ||
      claim.orderId !== orderId ||
      !claim.claimedAt ||
      !claim.releasedAt
    ) {
      return false;
    }
    if (routeStatus === 'IN_PROGRESS') {
      return (
        Temporal.Instant.compare(claim.releasedAt, attempt.recordedAt) === 0
      );
    }
    return Temporal.Instant.compare(claim.releasedAt, attempt.recordedAt) >= 0;
  });
}

export function findAppliedReadinessAudit<TAudit extends ReadinessAuditLike>(
  audits: readonly TAudit[],
  orderId: string,
  attemptId: string,
): TAudit | null {
  for (const audit of audits) {
    if (
      audit.action !== 'CONFIRM_INCIDENT_READY' ||
      audit.outcome !== 'APPLIED' ||
      audit.orderId !== orderId
    ) {
      continue;
    }
    const payloadAttemptId = readAttemptId(audit.payload);
    const resultAttemptId = readAttemptId(audit.result);
    if (payloadAttemptId === attemptId && resultAttemptId === attemptId) {
      return audit;
    }
  }
  return null;
}

export type FailedStopClaimCompletionState =
  | 'EARLY_RELEASED'
  | 'ACTIVE_LEGACY'
  | 'INVALID';

export function classifyFailedStopClaimForCompletion(
  routeId: string,
  orderId: string,
  attemptRecordedAt: Temporal.Instant,
  routeClaims: readonly OrderClaimLike[],
): FailedStopClaimCompletionState {
  const stopClaims = routeClaims.filter(
    (claim) => claim.routeId === routeId && claim.orderId === orderId,
  );
  const active = stopClaims.filter((claim) => claim.releasedAt === null);
  const released = stopClaims.filter((claim) => claim.releasedAt !== null);

  if (active.length > 1) return 'INVALID';
  if (active.length === 1) {
    if (!active[0]!.claimedAt) return 'INVALID';
    const hasFailureOrLaterRelease = released.some(
      (claim) =>
        claim.releasedAt !== null &&
        Temporal.Instant.compare(claim.releasedAt, attemptRecordedAt) >= 0,
    );
    return hasFailureOrLaterRelease ? 'INVALID' : 'ACTIVE_LEGACY';
  }

  const matchedEarlyRelease = released.some(
    (claim) =>
      claim.claimedAt !== null &&
      claim.releasedAt !== null &&
      Temporal.Instant.compare(claim.releasedAt, attemptRecordedAt) === 0,
  );
  return matchedEarlyRelease ? 'EARLY_RELEASED' : 'INVALID';
}
