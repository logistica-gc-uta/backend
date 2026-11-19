import {
  evaluatePlanningEligibility,
  type GeoPoint,
} from '../orders/order-geography.util.js';
import {
  assertDeliveryFuture,
  parseDeliveryTiming,
} from '../orders/order-delivery.util.js';
import {
  FAILED_DELIVERY_READINESS_CODES,
  findAppliedReadinessAudit,
  hasReleasedFailedClaim,
  isEmergencyCustodyActiveForOrder,
  isValidFailedAttemptRoute,
  selectLatestCanonicalFailedAttempt,
  type CanonicalFailedAttemptLike,
  type CanonicalFailedStopLike,
  type EmergencyRecoveryUnitLike,
  type OrderClaimLike,
  type ReadinessAuditLike,
  type RouteEmergencyLike,
  type RouteEvidenceLike,
} from './failed-delivery-readiness.js';

export const INCIDENT_STATUSES = [
  'WAITING_STORE_READINESS',
  'CONTACTED',
  'READY_AT_STORE',
  'PENDING_PICKUP',
  'PICKED_UP',
  'EMERGENCY_CUSTODY',
  'REVIEW_WITHOUT_FAILED_ATTEMPT',
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_OWNERSHIPS = [
  'FAILED_DELIVERY',
  'EMERGENCY_CUSTODY',
  'ADMINISTRATIVE_REVIEW',
] as const;

export type IncidentOwnership = (typeof INCIDENT_OWNERSHIPS)[number];

export const INCIDENT_ALLOWED_ACTIONS = [
  'CONTACT',
  'CONFIRM_INCIDENT_READY',
  'RESCHEDULE',
  'PICKUP_AGREE',
  'PICKUP_DECLINE',
  'PICKUP_CONFIRM',
] as const;

export type IncidentAllowedAction = (typeof INCIDENT_ALLOWED_ACTIONS)[number];

export const INCIDENT_ACTION_REASON_CODES = {
  ...FAILED_DELIVERY_READINESS_CODES,
  RECOVERY_PENDING: 'RECOVERY_PENDING',
  PICKUP_ALREADY_AGREED: 'PICKUP_ALREADY_AGREED',
  PICKUP_NOT_AGREED: 'PICKUP_NOT_AGREED',
  PICKUP_ALREADY_CONFIRMED: 'PICKUP_ALREADY_CONFIRMED',
  RESCHEDULE_AGREEMENT_REQUIRED: 'RESCHEDULE_AGREEMENT_REQUIRED',
  DELIVERY_COORDINATES_REQUIRED: 'DELIVERY_COORDINATES_REQUIRED',
} as const;

export type IncidentActionReasonCode =
  (typeof INCIDENT_ACTION_REASON_CODES)[keyof typeof INCIDENT_ACTION_REASON_CODES];

export interface IncidentActionEligibility {
  allowed: boolean;
  reasonCode: IncidentActionReasonCode | null;
  reason: string | null;
}

export type IncidentAllowedActions = Record<
  IncidentAllowedAction,
  IncidentActionEligibility
>;

export interface IncidentReadinessSnapshot {
  auditId: string;
  attemptId: string;
  confirmedAt: string;
  confirmedById: string;
}

export interface IncidentEmergencyContext {
  emergencyId: string;
  routeId: string | null;
  recoveryResolved: boolean;
  pendingUnitsCount: number;
  totalUnitsCount: number;
}

export interface IncidentOrderLike {
  id: string;
  status: string;
  routeId?: string | null;
  zoneId?: string | null;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  requiresAdministrativeReview: boolean;
}

export interface IncidentPickupLike {
  agreedAt: Temporal.Instant;
  confirmedAt: Temporal.Instant | null;
}

export interface IncidentAuditLike extends ReadinessAuditLike {
  actorId: string;
  recordedAt: Temporal.Instant;
}

export interface IncidentEmergencyUnitLike extends EmergencyRecoveryUnitLike {
  routeId: string;
  orderItemId: string;
  unitNumber: number;
  recoveredAt: Temporal.Instant | null;
}

export interface IncidentRouteEmergencyLike extends RouteEmergencyLike {
  routeId: string;
}

export interface IncidentActiveLossLike {
  orderItemId: string;
  unitNumber: number;
  replacementPreparedAt: Temporal.Instant | null;
}

export interface IncidentZoneLike {
  depotLat?: number | null;
  depotLng?: number | null;
}

export interface IncidentProjectionInput {
  order: IncidentOrderLike;
  stops: readonly CanonicalFailedStopLike[];
  failedAttempts: readonly CanonicalFailedAttemptLike[];
  routesById: ReadonlyMap<string, RouteEvidenceLike>;
  orderClaims: readonly OrderClaimLike[];
  pickup: IncidentPickupLike | null;
  audits: readonly IncidentAuditLike[];
  unitRecoveries: readonly IncidentEmergencyUnitLike[];
  emergenciesById: ReadonlyMap<string, IncidentRouteEmergencyLike>;
  activeLosses: readonly IncidentActiveLossLike[];
  zone: IncidentZoneLike | null;
  storeOrigin: GeoPoint | null;
  now: Temporal.Instant;
}

export interface IncidentProjectionResult {
  status: IncidentStatus;
  ownership: IncidentOwnership;
  latestFailedAttemptId: string | null;
  readiness: IncidentReadinessSnapshot | null;
  emergencyId: string | null;
  emergency: IncidentEmergencyContext | null;
  activeAgreementId: string | null;
  allowedActions: IncidentAllowedActions;
}

const ALLOWED: IncidentActionEligibility = {
  allowed: true,
  reasonCode: null,
  reason: null,
};

function allow(): IncidentActionEligibility {
  return { ...ALLOWED };
}

function deny(
  reasonCode: IncidentActionReasonCode,
  reason: string,
): IncidentActionEligibility {
  return { allowed: false, reasonCode, reason };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readStringField(container: unknown, key: string): string | null {
  const record = asRecord(container);
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function evaluateOrderRecoveryUnits(
  unitRecoveries: readonly IncidentEmergencyUnitLike[],
  activeLosses: readonly IncidentActiveLossLike[],
): {
  totalUnitsCount: number;
  pendingUnitsCount: number;
  recoveryResolved: boolean;
} {
  let pendingUnitsCount = 0;
  for (const unit of unitRecoveries) {
    if (unit.recoveredAt != null) continue;
    const preparedLoss = activeLosses.some(
      (loss) =>
        loss.orderItemId === unit.orderItemId &&
        loss.unitNumber === unit.unitNumber &&
        loss.replacementPreparedAt != null,
    );
    if (!preparedLoss) {
      pendingUnitsCount += 1;
    }
  }
  return {
    totalUnitsCount: unitRecoveries.length,
    pendingUnitsCount,
    recoveryResolved: pendingUnitsCount === 0,
  };
}

export function selectActiveEmergencyForOrder(
  unitRecoveries: readonly IncidentEmergencyUnitLike[],
  emergenciesById: ReadonlyMap<string, IncidentRouteEmergencyLike>,
  latestAttempt: CanonicalFailedAttemptLike | null,
): { emergencyId: string; routeId: string | null } | null {
  if (unitRecoveries.length === 0) return null;

  const matchingEmergencies: IncidentRouteEmergencyLike[] = [];
  const seen = new Set<string>();
  for (const unit of unitRecoveries) {
    if (seen.has(unit.emergencyId)) continue;
    seen.add(unit.emergencyId);
    const emergency = emergenciesById.get(unit.emergencyId);
    if (!emergency) continue;
    if (
      !latestAttempt ||
      Temporal.Instant.compare(
        emergency.declaredAt,
        latestAttempt.recordedAt,
      ) >= 0
    ) {
      matchingEmergencies.push(emergency);
    }
  }

  if (matchingEmergencies.length > 0) {
    matchingEmergencies.sort(
      (a, b) =>
        Temporal.Instant.compare(b.declaredAt, a.declaredAt) ||
        b.id.localeCompare(a.id),
    );
    const selected = matchingEmergencies[0]!;
    return { emergencyId: selected.id, routeId: selected.routeId };
  }

  if (!latestAttempt) {
    const fallback = [...unitRecoveries].sort(
      (a, b) =>
        a.emergencyId.localeCompare(b.emergencyId) ||
        a.routeId.localeCompare(b.routeId),
    )[0]!;
    return { emergencyId: fallback.emergencyId, routeId: fallback.routeId };
  }

  return null;
}

export function findContactEvidenceForAttempt(
  audits: readonly IncidentAuditLike[],
  orderId: string,
  attemptId: string,
  now: Temporal.Instant,
): { hasContact: boolean; activeAgreementId: string | null } {
  const consumedAgreementIds = new Set<string>();
  for (const audit of audits) {
    if (
      audit.action === 'RESCHEDULE' &&
      audit.outcome === 'APPLIED' &&
      audit.orderId === orderId
    ) {
      const agreementId = readStringField(audit.payload, 'agreementId');
      if (agreementId) consumedAgreementIds.add(agreementId);
    }
  }

  let hasContact = false;
  const usableAgreements: IncidentAuditLike[] = [];

  for (const audit of audits) {
    if (
      audit.action !== 'CONTACT' ||
      audit.outcome !== 'APPLIED' ||
      audit.orderId !== orderId
    ) {
      continue;
    }
    const payload = asRecord(audit.payload);
    if (!payload) continue;
    if (readStringField(payload, 'emergencyId')) continue;
    if (readStringField(payload, 'attemptId') !== attemptId) continue;

    hasContact = true;

    if (payload.agreementConfirmed !== true) continue;
    if (consumedAgreementIds.has(audit.id)) continue;

    try {
      const timing = parseDeliveryTiming(
        {
          scheduledDeliveryDate:
            readStringField(payload, 'scheduledDeliveryDate') ?? undefined,
          deliveryWindowStart:
            readStringField(payload, 'deliveryWindowStart') ?? undefined,
          deliveryWindowEnd:
            readStringField(payload, 'deliveryWindowEnd') ?? undefined,
        },
        true,
      );
      if (!timing.deliveryWindowStart || !timing.deliveryWindowEnd) continue;
      assertDeliveryFuture(timing, now);
      usableAgreements.push(audit);
    } catch {
      // Expired or malformed timing cannot satisfy the atomic RESCHEDULE write gate.
    }
  }

  usableAgreements.sort(
    (a, b) =>
      Temporal.Instant.compare(b.recordedAt, a.recordedAt) ||
      b.id.localeCompare(a.id),
  );

  return {
    hasContact,
    activeAgreementId: usableAgreements[0]?.id ?? null,
  };
}

export function projectIncidentInboxItem(
  input: IncidentProjectionInput,
): IncidentProjectionResult {
  const {
    order,
    stops,
    failedAttempts,
    routesById,
    orderClaims,
    pickup,
    audits,
    unitRecoveries,
    emergenciesById,
    activeLosses,
    zone,
    storeOrigin,
    now,
  } = input;

  const latest = selectLatestCanonicalFailedAttempt(stops, failedAttempts);
  const emergencyCustodyActive = isEmergencyCustodyActiveForOrder(
    unitRecoveries,
    emergenciesById,
    latest?.attempt ?? null,
  );
  const recoveryUnits = evaluateOrderRecoveryUnits(
    unitRecoveries,
    activeLosses,
  );
  const activeEmergencyRef = emergencyCustodyActive
    ? selectActiveEmergencyForOrder(
        unitRecoveries,
        emergenciesById,
        latest?.attempt ?? null,
      )
    : null;

  const selectedEmergencyUnits = activeEmergencyRef
    ? unitRecoveries.filter(
        (unit) => unit.emergencyId === activeEmergencyRef.emergencyId,
      )
    : [];
  const selectedEmergencyRecovery = evaluateOrderRecoveryUnits(
    selectedEmergencyUnits,
    activeLosses,
  );

  const emergency: IncidentEmergencyContext | null = activeEmergencyRef
    ? {
        emergencyId: activeEmergencyRef.emergencyId,
        routeId: activeEmergencyRef.routeId,
        recoveryResolved: selectedEmergencyRecovery.recoveryResolved,
        pendingUnitsCount: selectedEmergencyRecovery.pendingUnitsCount,
        totalUnitsCount: selectedEmergencyRecovery.totalUnitsCount,
      }
    : null;

  const ownership: IncidentOwnership = emergencyCustodyActive
    ? 'EMERGENCY_CUSTODY'
    : latest
      ? 'FAILED_DELIVERY'
      : 'ADMINISTRATIVE_REVIEW';

  const readinessAudit =
    !emergencyCustodyActive && latest
      ? findAppliedReadinessAudit(audits, order.id, latest.attempt.id)
      : null;

  const readiness: IncidentReadinessSnapshot | null =
    readinessAudit && latest
      ? {
          auditId: readinessAudit.id,
          attemptId: latest.attempt.id,
          confirmedAt: readinessAudit.recordedAt.toString(),
          confirmedById: readinessAudit.actorId,
        }
      : null;

  const contactEvidence =
    !emergencyCustodyActive && latest
      ? findContactEvidenceForAttempt(audits, order.id, latest.attempt.id, now)
      : { hasContact: false, activeAgreementId: null };

  const status: IncidentStatus =
    pickup?.confirmedAt != null
      ? 'PICKED_UP'
      : pickup != null
        ? 'PENDING_PICKUP'
        : emergencyCustodyActive
          ? 'EMERGENCY_CUSTODY'
          : !latest
            ? 'REVIEW_WITHOUT_FAILED_ATTEMPT'
            : readiness != null
              ? 'READY_AT_STORE'
              : contactEvidence.hasContact
                ? 'CONTACTED'
                : 'WAITING_STORE_READINESS';

  const activeOrderClaims = orderClaims.filter((c) => c.releasedAt === null);
  const commerciallyResolved =
    order.status === 'DELIVERED' || order.status === 'CANCELLED';

  const allowedActions = evaluateAllowedActions({
    order,
    commerciallyResolved,
    pickup,
    emergencyCustodyActive,
    recoveryResolved: recoveryUnits.recoveryResolved,
    latest,
    routesById,
    orderClaims,
    activeOrderClaims,
    readiness,
    activeAgreementId: contactEvidence.activeAgreementId,
    zone,
    storeOrigin,
  });

  return {
    status,
    ownership,
    latestFailedAttemptId: latest?.attempt.id ?? null,
    readiness,
    emergencyId: activeEmergencyRef?.emergencyId ?? null,
    emergency,
    activeAgreementId:
      pickup == null && !emergencyCustodyActive
        ? contactEvidence.activeAgreementId
        : null,
    allowedActions,
  };
}

function evaluateAllowedActions(ctx: {
  order: IncidentOrderLike;
  commerciallyResolved: boolean;
  pickup: IncidentPickupLike | null;
  emergencyCustodyActive: boolean;
  recoveryResolved: boolean;
  latest: ReturnType<typeof selectLatestCanonicalFailedAttempt>;
  routesById: ReadonlyMap<string, RouteEvidenceLike>;
  orderClaims: readonly OrderClaimLike[];
  activeOrderClaims: readonly OrderClaimLike[];
  readiness: IncidentReadinessSnapshot | null;
  activeAgreementId: string | null;
  zone: IncidentZoneLike | null;
  storeOrigin: GeoPoint | null;
}): IncidentAllowedActions {
  const {
    order,
    commerciallyResolved,
    pickup,
    emergencyCustodyActive,
    recoveryResolved,
    latest,
    routesById,
    orderClaims,
    activeOrderClaims,
    readiness,
    activeAgreementId,
    zone,
    storeOrigin,
  } = ctx;

  if (pickup?.confirmedAt != null) {
    const confirmed = deny(
      INCIDENT_ACTION_REASON_CODES.PICKUP_ALREADY_CONFIRMED,
      'Store pickup has already been confirmed',
    );
    return {
      CONTACT: confirmed,
      CONFIRM_INCIDENT_READY: confirmed,
      RESCHEDULE: confirmed,
      PICKUP_AGREE: confirmed,
      PICKUP_DECLINE: confirmed,
      PICKUP_CONFIRM: confirmed,
    };
  }

  if (commerciallyResolved) {
    const resolved = deny(
      INCIDENT_ACTION_REASON_CODES.ORDER_COMMERCIALLY_RESOLVED,
      'Order is already commercially resolved',
    );
    return {
      CONTACT: resolved,
      CONFIRM_INCIDENT_READY: resolved,
      RESCHEDULE: resolved,
      PICKUP_AGREE: resolved,
      PICKUP_DECLINE: resolved,
      PICKUP_CONFIRM: resolved,
    };
  }

  if (pickup != null) {
    const alreadyAgreed = deny(
      INCIDENT_ACTION_REASON_CODES.PICKUP_ALREADY_AGREED,
      'Order already has an agreed store pickup',
    );
    return {
      CONTACT: alreadyAgreed,
      CONFIRM_INCIDENT_READY: alreadyAgreed,
      RESCHEDULE: alreadyAgreed,
      PICKUP_AGREE: alreadyAgreed,
      PICKUP_DECLINE: alreadyAgreed,
      PICKUP_CONFIRM:
        activeOrderClaims.length > 0
          ? deny(
              INCIDENT_ACTION_REASON_CODES.CLAIM_NOT_RELEASED,
              'Active route claim must be released before confirming store pickup',
            )
          : allow(),
    };
  }

  const pickupConfirm = deny(
    INCIDENT_ACTION_REASON_CODES.PICKUP_NOT_AGREED,
    'No agreed store pickup to confirm',
  );

  if (emergencyCustodyActive) {
    const emergencyBlocker = !recoveryResolved
      ? deny(
          INCIDENT_ACTION_REASON_CODES.RECOVERY_PENDING,
          'Order has unrecovered units from a route emergency; resolve in the emergency flow',
        )
      : deny(
          INCIDENT_ACTION_REASON_CODES.EMERGENCY_CUSTODY_SEPARATE,
          'Order belongs to emergency custody; resolve in the emergency flow',
        );
    return {
      CONTACT: emergencyBlocker,
      CONFIRM_INCIDENT_READY: emergencyBlocker,
      RESCHEDULE: emergencyBlocker,
      PICKUP_AGREE: emergencyBlocker,
      PICKUP_DECLINE: emergencyBlocker,
      PICKUP_CONFIRM: pickupConfirm,
    };
  }

  if (!latest) {
    const noAttempt = deny(
      INCIDENT_ACTION_REASON_CODES.FAILED_ATTEMPT_NOT_FOUND,
      'No canonical failed delivery attempt found for order',
    );
    return {
      CONTACT: noAttempt,
      CONFIRM_INCIDENT_READY: noAttempt,
      RESCHEDULE: noAttempt,
      PICKUP_AGREE: noAttempt,
      PICKUP_DECLINE: noAttempt,
      PICKUP_CONFIRM: pickupConfirm,
    };
  }

  const recoveryBlocked = !recoveryResolved
    ? deny(
        INCIDENT_ACTION_REASON_CODES.RECOVERY_PENDING,
        'Order has unrecovered units from a route emergency',
      )
    : null;

  const attemptRoute = routesById.get(latest.stop.routeId) ?? null;
  const routeValid = isValidFailedAttemptRoute(attemptRoute, latest.attempt);
  const claimedByAnotherRoute = activeOrderClaims.some(
    (claim) => claim.routeId !== latest.stop.routeId,
  );
  const routeClaims = orderClaims.filter(
    (claim) => claim.routeId === latest.stop.routeId,
  );
  const claimReleased = hasReleasedFailedClaim(
    latest.stop.routeId,
    order.id,
    attemptRoute?.status ?? null,
    latest.attempt,
    routeClaims,
    activeOrderClaims,
  );

  const contact = recoveryBlocked ?? allow();

  let confirmIncidentReady: IncidentActionEligibility;
  if (recoveryBlocked) {
    confirmIncidentReady = recoveryBlocked;
  } else if (!routeValid) {
    confirmIncidentReady = deny(
      INCIDENT_ACTION_REASON_CODES.INVALID_FAILED_ATTEMPT,
      'Failed attempt lacks verified route evidence',
    );
  } else if (claimedByAnotherRoute) {
    confirmIncidentReady = deny(
      INCIDENT_ACTION_REASON_CODES.ORDER_CLAIMED_BY_ANOTHER_ROUTE,
      'Order already has an active claim on another route',
    );
  } else if (!claimReleased) {
    confirmIncidentReady = deny(
      INCIDENT_ACTION_REASON_CODES.CLAIM_NOT_RELEASED,
      'Failed order claim must be released before confirming store readiness',
    );
  } else if (readiness != null) {
    confirmIncidentReady = deny(
      INCIDENT_ACTION_REASON_CODES.INCIDENT_ALREADY_READY,
      'Store readiness has already been confirmed for the latest failed attempt',
    );
  } else {
    confirmIncidentReady = allow();
  }

  let pickupAgree: IncidentActionEligibility;
  if (recoveryBlocked) {
    pickupAgree = recoveryBlocked;
  } else if (!routeValid) {
    pickupAgree = deny(
      INCIDENT_ACTION_REASON_CODES.INVALID_FAILED_ATTEMPT,
      'Failed attempt lacks verified route evidence',
    );
  } else if (claimedByAnotherRoute) {
    pickupAgree = deny(
      INCIDENT_ACTION_REASON_CODES.ORDER_CLAIMED_BY_ANOTHER_ROUTE,
      'Order already has an active claim on another route',
    );
  } else if (!claimReleased) {
    pickupAgree = deny(
      INCIDENT_ACTION_REASON_CODES.CLAIM_NOT_RELEASED,
      'Failed order claim must be released before agreeing store pickup',
    );
  } else if (readiness == null) {
    pickupAgree = deny(
      INCIDENT_ACTION_REASON_CODES.INCIDENT_NOT_READY_AT_STORE,
      'Store readiness must be confirmed for the latest failed attempt before agreeing store pickup',
    );
  } else {
    pickupAgree = allow();
  }

  let reschedule: IncidentActionEligibility;
  if (recoveryBlocked) {
    reschedule = recoveryBlocked;
  } else if (!routeValid) {
    reschedule = deny(
      INCIDENT_ACTION_REASON_CODES.INVALID_FAILED_ATTEMPT,
      'Failed attempt lacks verified route evidence',
    );
  } else if (claimedByAnotherRoute) {
    reschedule = deny(
      INCIDENT_ACTION_REASON_CODES.ORDER_CLAIMED_BY_ANOTHER_ROUTE,
      'Order already has an active claim on another route',
    );
  } else if (!claimReleased) {
    reschedule = deny(
      INCIDENT_ACTION_REASON_CODES.CLAIM_NOT_RELEASED,
      'Failed order claim must be released before rescheduling',
    );
  } else if (readiness == null) {
    reschedule = deny(
      INCIDENT_ACTION_REASON_CODES.INCIDENT_NOT_READY_AT_STORE,
      'Store readiness must be confirmed for the latest failed attempt before rescheduling',
    );
  } else if (!activeAgreementId) {
    reschedule = deny(
      INCIDENT_ACTION_REASON_CODES.RESCHEDULE_AGREEMENT_REQUIRED,
      'An unconsumed future delivery agreement from customer contact is required before rescheduling',
    );
  } else if (
    !evaluatePlanningEligibility(order, zone, storeOrigin).planningEligibility
      .eligible
  ) {
    reschedule = deny(
      INCIDENT_ACTION_REASON_CODES.DELIVERY_COORDINATES_REQUIRED,
      'Confirmed delivery and depot coordinates are required before rescheduling',
    );
  } else {
    reschedule = allow();
  }

  return {
    CONTACT: contact,
    CONFIRM_INCIDENT_READY: confirmIncidentReady,
    RESCHEDULE: reschedule,
    PICKUP_AGREE: pickupAgree,
    PICKUP_DECLINE: recoveryBlocked ?? allow(),
    PICKUP_CONFIRM: pickupConfirm,
  };
}
