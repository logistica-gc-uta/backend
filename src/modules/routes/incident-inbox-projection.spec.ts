import {
  INCIDENT_ACTION_REASON_CODES,
  projectIncidentInboxItem,
  type IncidentProjectionInput,
} from './incident-inbox-projection.js';

describe('Incident inbox pure projection (T4 / S3)', () => {
  const t0 = Temporal.Instant.from('2026-11-19T12:00:00Z');
  const t1 = t0.add({ minutes: 10 });
  const t2 = t0.add({ minutes: 20 });
  const now = t0.add({ minutes: 25 });
  const futureDate = t0.add({ hours: 2 });
  const futureStart = futureDate.subtract({ minutes: 15 });
  const futureEnd = futureDate.add({ minutes: 15 });

  const baseInput = (
    overrides: Partial<IncidentProjectionInput> = {},
  ): IncidentProjectionInput => ({
    order: {
      id: 'order-1',
      status: 'ASSIGNED',
      routeId: 'route-1',
      zoneId: 'zone-1',
      deliveryLat: -1.25,
      deliveryLng: -78.62,
      requiresAdministrativeReview: true,
    },
    stops: [
      {
        id: 'stop-1',
        routeId: 'route-1',
        orderId: 'order-1',
        sequence: 1,
        isLegacy: false,
        outcome: 'FAILED',
      },
    ],
    failedAttempts: [
      {
        id: 'att-1',
        stopId: 'stop-1',
        driverId: 'driver-1',
        outcome: 'FAILED',
        failureReason: 'RECIPIENT_ABSENT',
        recordedAt: t1,
      },
    ],
    routesById: new Map([
      [
        'route-1',
        {
          id: 'route-1',
          status: 'IN_PROGRESS',
          driverId: 'driver-1',
          startedAt: t0,
        },
      ],
    ]),
    orderClaims: [
      {
        id: 'claim-1',
        routeId: 'route-1',
        orderId: 'order-1',
        claimedAt: t0,
        releasedAt: t1,
      },
    ],
    pickup: null,
    audits: [],
    unitRecoveries: [],
    emergenciesById: new Map(),
    activeLosses: [],
    zone: { depotLat: -1.24, depotLng: -78.61 },
    storeOrigin: null,
    now,
    ...overrides,
  });

  const readyAudit = (attemptId = 'att-1', id = 'ready-1') => ({
    id,
    actorId: 'admin-ready',
    action: 'CONFIRM_INCIDENT_READY',
    outcome: 'APPLIED',
    orderId: 'order-1',
    recordedAt: t1.add({ minutes: 3 }),
    payload: { attemptId, secretNote: 'never-expose' },
    result: { orderId: 'order-1', routeId: 'route-1', attemptId },
  });

  const contactAudit = (
    opts: {
      id?: string;
      attemptId?: string;
      agreementConfirmed?: boolean;
      scheduledDeliveryDate?: string;
      deliveryWindowStart?: string;
      deliveryWindowEnd?: string;
      recordedAt?: Temporal.Instant;
    } = {},
  ) => ({
    id: opts.id ?? 'contact-1',
    actorId: 'admin-contact',
    action: 'CONTACT',
    outcome: 'APPLIED',
    orderId: 'order-1',
    recordedAt: opts.recordedAt ?? t1.add({ minutes: 2 }),
    payload: {
      attemptId: opts.attemptId ?? 'att-1',
      agreementConfirmed: opts.agreementConfirmed ?? true,
      ...(opts.agreementConfirmed === false
        ? {}
        : {
            scheduledDeliveryDate:
              opts.scheduledDeliveryDate ?? futureDate.toString(),
            deliveryWindowStart:
              opts.deliveryWindowStart ?? futureStart.toString(),
            deliveryWindowEnd: opts.deliveryWindowEnd ?? futureEnd.toString(),
          }),
    },
    result: { orderId: 'order-1', attemptId: opts.attemptId ?? 'att-1' },
  });

  it('requires unconsumed future confirmed CONTACT agreement and geography eligibility after readiness for RESCHEDULE', () => {
    // 1. Unconfirmed contact moves waiting -> CONTACTED without satisfying reschedule agreement.
    const unconfirmed = projectIncidentInboxItem(
      baseInput({
        audits: [contactAudit({ agreementConfirmed: false })],
      }),
    );
    expect(unconfirmed.status).toBe('CONTACTED');
    expect(unconfirmed.activeAgreementId).toBeNull();
    expect(unconfirmed.allowedActions.RESCHEDULE.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.INCIDENT_NOT_READY_AT_STORE,
    );

    // 2. Ready without a confirmed contact agreement allows PICKUP_AGREE but blocks RESCHEDULE with RESCHEDULE_AGREEMENT_REQUIRED.
    const readyNoAgreement = projectIncidentInboxItem(
      baseInput({
        audits: [readyAudit(), contactAudit({ agreementConfirmed: false })],
      }),
    );
    expect(readyNoAgreement.status).toBe('READY_AT_STORE');
    expect(readyNoAgreement.allowedActions.PICKUP_AGREE.allowed).toBe(true);
    expect(readyNoAgreement.allowedActions.RESCHEDULE).toMatchObject({
      allowed: false,
      reasonCode: INCIDENT_ACTION_REASON_CODES.RESCHEDULE_AGREEMENT_REQUIRED,
    });

    // 3. Expired confirmed contact agreement does not unlock RESCHEDULE.
    const expired = projectIncidentInboxItem(
      baseInput({
        audits: [
          readyAudit(),
          contactAudit({
            id: 'contact-expired',
            scheduledDeliveryDate: t1.add({ minutes: 1 }).toString(),
            deliveryWindowStart: t1.toString(),
            deliveryWindowEnd: t1.add({ minutes: 2 }).toString(),
          }),
        ],
      }),
    );
    expect(expired.activeAgreementId).toBeNull();
    expect(expired.allowedActions.RESCHEDULE.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.RESCHEDULE_AGREEMENT_REQUIRED,
    );

    // 4. Consumed confirmed agreement does not unlock RESCHEDULE.
    const consumed = projectIncidentInboxItem(
      baseInput({
        audits: [
          readyAudit(),
          contactAudit({ id: 'contact-used' }),
          {
            id: 'reschedule-old',
            actorId: 'admin-1',
            action: 'RESCHEDULE',
            outcome: 'APPLIED',
            orderId: 'order-1',
            recordedAt: t1.add({ minutes: 4 }),
            payload: { agreementId: 'contact-used' },
            result: {},
          },
        ],
      }),
    );
    expect(consumed.activeAgreementId).toBeNull();
    expect(consumed.allowedActions.RESCHEDULE.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.RESCHEDULE_AGREEMENT_REQUIRED,
    );

    // 5. Missing delivery coordinates blocks RESCHEDULE with DELIVERY_COORDINATES_REQUIRED even with readiness + agreement.
    const noCoords = projectIncidentInboxItem(
      baseInput({
        order: {
          id: 'order-1',
          status: 'ASSIGNED',
          routeId: 'route-1',
          zoneId: 'zone-1',
          deliveryLat: null,
          deliveryLng: null,
          requiresAdministrativeReview: true,
        },
        audits: [readyAudit(), contactAudit()],
      }),
    );
    expect(noCoords.activeAgreementId).toBe('contact-1');
    expect(noCoords.allowedActions.PICKUP_AGREE.allowed).toBe(true);
    expect(noCoords.allowedActions.RESCHEDULE).toMatchObject({
      allowed: false,
      reasonCode: INCIDENT_ACTION_REASON_CODES.DELIVERY_COORDINATES_REQUIRED,
    });

    // 6. StoreCoverage origin unlocks RESCHEDULE for zoneId=null orders.
    const storeOriginOk = projectIncidentInboxItem(
      baseInput({
        order: {
          id: 'order-1',
          status: 'ASSIGNED',
          routeId: 'route-1',
          zoneId: null,
          deliveryLat: -1.25,
          deliveryLng: -78.62,
          requiresAdministrativeReview: true,
        },
        zone: null,
        storeOrigin: { lat: -1.24, lng: -78.61 },
        audits: [readyAudit(), contactAudit()],
      }),
    );
    expect(storeOriginOk.allowedActions.RESCHEDULE.allowed).toBe(true);
  });

  it('ignores rejected readiness audits and validates route/claim evidence strictly', () => {
    const rejectedReady = projectIncidentInboxItem(
      baseInput({
        audits: [{ ...readyAudit(), outcome: 'REJECTED' }],
      }),
    );
    expect(rejectedReady.readiness).toBeNull();
    expect(rejectedReady.allowedActions.CONFIRM_INCIDENT_READY.allowed).toBe(
      true,
    );

    // IN_PROGRESS claim released at wrong timestamp fails CLAIM_NOT_RELEASED.
    const badReleaseTs = projectIncidentInboxItem(
      baseInput({
        orderClaims: [
          {
            id: 'claim-1',
            routeId: 'route-1',
            orderId: 'order-1',
            claimedAt: t0,
            releasedAt: t2,
          },
        ],
      }),
    );
    expect(badReleaseTs.allowedActions.CONFIRM_INCIDENT_READY.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.CLAIM_NOT_RELEASED,
    );

    // COMPLETED route allows claim released at route completion.
    const completedRoute = projectIncidentInboxItem(
      baseInput({
        routesById: new Map([
          [
            'route-1',
            {
              id: 'route-1',
              status: 'COMPLETED',
              driverId: 'driver-1',
              startedAt: t0,
            },
          ],
        ]),
        orderClaims: [
          {
            id: 'claim-1',
            routeId: 'route-1',
            orderId: 'order-1',
            claimedAt: t0,
            releasedAt: t2,
          },
        ],
      }),
    );
    expect(completedRoute.allowedActions.CONFIRM_INCIDENT_READY.allowed).toBe(
      true,
    );

    // DRAFT / unverified route evidence fails INVALID_FAILED_ATTEMPT.
    const invalidRoute = projectIncidentInboxItem(
      baseInput({
        routesById: new Map([
          [
            'route-1',
            {
              id: 'route-1',
              status: 'DRAFT',
              driverId: 'driver-1',
              startedAt: t0,
            },
          ],
        ]),
      }),
    );
    expect(invalidRoute.allowedActions.CONFIRM_INCIDENT_READY.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.INVALID_FAILED_ATTEMPT,
    );
  });

  it('keeps post-failure emergency custody in emergency flow and returns post-emergency failures to failed-delivery flow', () => {
    // Post-failure emergency (declaredAt t2 >= attempt t1) supersedes old attempt readiness.
    const postFailureEmergency = projectIncidentInboxItem(
      baseInput({
        audits: [readyAudit('att-1')],
        emergenciesById: new Map([
          ['em-2', { id: 'em-2', routeId: 'route-2', declaredAt: t2 }],
        ]),
        unitRecoveries: [
          {
            emergencyId: 'em-2',
            routeId: 'route-2',
            orderId: 'order-1',
            orderItemId: 'item-1',
            unitNumber: 1,
            recoveredAt: null,
          },
        ],
        activeLosses: [
          {
            orderItemId: 'item-1',
            unitNumber: 1,
            replacementPreparedAt: t2.add({ minutes: 1 }),
          },
        ],
      }),
    );
    expect(postFailureEmergency.ownership).toBe('EMERGENCY_CUSTODY');
    expect(postFailureEmergency.status).toBe('EMERGENCY_CUSTODY');
    expect(postFailureEmergency.emergencyId).toBe('em-2');
    expect(postFailureEmergency.readiness).toBeNull();
    expect(postFailureEmergency.emergency).toEqual({
      emergencyId: 'em-2',
      routeId: 'route-2',
      recoveryResolved: true,
      pendingUnitsCount: 0,
      totalUnitsCount: 1,
    });
    expect(
      postFailureEmergency.allowedActions.CONFIRM_INCIDENT_READY.reasonCode,
    ).toBe(INCIDENT_ACTION_REASON_CODES.EMERGENCY_CUSTODY_SEPARATE);

    // Post-emergency new failure (attempt t2 > old emergency t0, old unit recovered): ordinary FAILED_DELIVERY.
    const postEmergencyFailure = projectIncidentInboxItem(
      baseInput({
        failedAttempts: [
          {
            id: 'att-after-em',
            stopId: 'stop-1',
            driverId: 'driver-1',
            outcome: 'FAILED',
            failureReason: 'RECIPIENT_REFUSED',
            recordedAt: t2,
          },
        ],
        orderClaims: [
          {
            id: 'claim-1',
            routeId: 'route-1',
            orderId: 'order-1',
            claimedAt: t0,
            releasedAt: t2,
          },
        ],
        emergenciesById: new Map([
          ['em-old', { id: 'em-old', routeId: 'route-old', declaredAt: t0 }],
        ]),
        unitRecoveries: [
          {
            emergencyId: 'em-old',
            routeId: 'route-old',
            orderId: 'order-1',
            orderItemId: 'item-1',
            unitNumber: 1,
            recoveredAt: t1,
          },
        ],
      }),
    );
    expect(postEmergencyFailure.ownership).toBe('FAILED_DELIVERY');
    expect(postEmergencyFailure.status).toBe('WAITING_STORE_READINESS');
    expect(postEmergencyFailure.emergencyId).toBeNull();
    expect(postEmergencyFailure.emergency).toBeNull();
    expect(postEmergencyFailure.latestFailedAttemptId).toBe('att-after-em');
    expect(postEmergencyFailure.allowedActions.CONTACT.allowed).toBe(true);
    expect(
      postEmergencyFailure.allowedActions.CONFIRM_INCIDENT_READY.allowed,
    ).toBe(true);
  });

  it('handles PENDING_PICKUP, PICKED_UP, REVIEW_WITHOUT_FAILED_ATTEMPT, and commercially resolved states', () => {
    const pendingPickup = projectIncidentInboxItem(
      baseInput({
        pickup: { agreedAt: t2, confirmedAt: null },
        audits: [readyAudit()],
      }),
    );
    expect(pendingPickup.status).toBe('PENDING_PICKUP');
    expect(pendingPickup.allowedActions.PICKUP_CONFIRM.allowed).toBe(true);
    expect(pendingPickup.allowedActions.PICKUP_AGREE.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.PICKUP_ALREADY_AGREED,
    );
    expect(pendingPickup.allowedActions.CONFIRM_INCIDENT_READY.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.PICKUP_ALREADY_AGREED,
    );

    const pickedUp = projectIncidentInboxItem(
      baseInput({
        pickup: { agreedAt: t1, confirmedAt: t2 },
      }),
    );
    expect(pickedUp.status).toBe('PICKED_UP');
    expect(pickedUp.allowedActions.PICKUP_CONFIRM.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.PICKUP_ALREADY_CONFIRMED,
    );

    const legacyOnly = projectIncidentInboxItem(
      baseInput({
        stops: [
          {
            id: 'stop-legacy',
            routeId: 'route-1',
            orderId: 'order-1',
            sequence: null,
            isLegacy: true,
            outcome: 'FAILED',
          },
        ],
        failedAttempts: [
          {
            id: 'att-legacy',
            stopId: 'stop-legacy',
            driverId: 'driver-1',
            outcome: 'FAILED',
            failureReason: 'RECIPIENT_ABSENT',
            recordedAt: t1,
          },
        ],
      }),
    );
    expect(legacyOnly.ownership).toBe('ADMINISTRATIVE_REVIEW');
    expect(legacyOnly.status).toBe('REVIEW_WITHOUT_FAILED_ATTEMPT');
    expect(legacyOnly.latestFailedAttemptId).toBeNull();
    expect(legacyOnly.allowedActions.CONTACT.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.FAILED_ATTEMPT_NOT_FOUND,
    );
    expect(legacyOnly.allowedActions.PICKUP_CONFIRM.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.PICKUP_NOT_AGREED,
    );

    const delivered = projectIncidentInboxItem(
      baseInput({
        order: {
          id: 'order-1',
          status: 'DELIVERED',
          routeId: null,
          zoneId: 'zone-1',
          deliveryLat: -1.25,
          deliveryLng: -78.62,
          requiresAdministrativeReview: true,
        },
      }),
    );
    expect(delivered.allowedActions.CONTACT.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.ORDER_COMMERCIALLY_RESOLVED,
    );
    expect(delivered.allowedActions.CONFIRM_INCIDENT_READY.reasonCode).toBe(
      INCIDENT_ACTION_REASON_CODES.ORDER_COMMERCIALLY_RESOLVED,
    );
  });

  it('scopes emergency unit counts and recoveryResolved strictly to the selected emergency ID', () => {
    const projected = projectIncidentInboxItem(
      baseInput({
        emergenciesById: new Map([
          ['em-1', { id: 'em-1', routeId: 'route-em-1', declaredAt: t1.add({ minutes: 1 }) }],
          ['em-2', { id: 'em-2', routeId: 'route-em-2', declaredAt: t2 }],
        ]),
        unitRecoveries: [
          {
            emergencyId: 'em-1',
            routeId: 'route-em-1',
            orderId: 'order-1',
            orderItemId: 'item-1',
            unitNumber: 1,
            recoveredAt: t1.add({ minutes: 2 }),
          },
          {
            emergencyId: 'em-1',
            routeId: 'route-em-1',
            orderId: 'order-1',
            orderItemId: 'item-1',
            unitNumber: 2,
            recoveredAt: t1.add({ minutes: 2 }),
          },
          {
            emergencyId: 'em-2',
            routeId: 'route-em-2',
            orderId: 'order-1',
            orderItemId: 'item-1',
            unitNumber: 1,
            recoveredAt: t2.add({ minutes: 1 }),
          },
          {
            emergencyId: 'em-2',
            routeId: 'route-em-2',
            orderId: 'order-1',
            orderItemId: 'item-1',
            unitNumber: 2,
            recoveredAt: null,
          },
        ],
      }),
    );

    expect(projected.ownership).toBe('EMERGENCY_CUSTODY');
    expect(projected.emergencyId).toBe('em-2');
    expect(projected.emergency).toEqual({
      emergencyId: 'em-2',
      routeId: 'route-em-2',
      recoveryResolved: false,
      pendingUnitsCount: 1,
      totalUnitsCount: 2,
    });
  });
});
