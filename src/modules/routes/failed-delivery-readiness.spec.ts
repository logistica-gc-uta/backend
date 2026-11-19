import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DispatchInterventionDto } from './dto/dispatch-intervention.dto.js';
import {
  classifyFailedStopClaimForCompletion,
  findAppliedReadinessAudit,
  hasReleasedFailedClaim,
  isEmergencyCustodyActiveForOrder,
  isValidFailedAttemptRoute,
  selectLatestCanonicalFailedAttempt,
} from './failed-delivery-readiness.js';

const request = {
  action: 'CONFIRM_INCIDENT_READY',
  requestId: '11111111-1111-4111-8111-111111111111',
  orderId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  reason: 'The returned order is available for pickup at the store',
};

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: DispatchInterventionDto });

describe('Failed-delivery readiness intervention contract', () => {
  it('accepts a readiness confirmation tied to a specific order and attempt', async () => {
    await expect(validate(request)).resolves.toMatchObject(request);
  });

  it('rejects a readiness confirmation with a blank reason', async () => {
    await expect(validate({ ...request, reason: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects extra actor impersonation fields on readiness confirmation', async () => {
    await expect(
      validate({ ...request, actorId: '44444444-4444-4444-8444-444444444444' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Failed-delivery readiness pure policy helpers', () => {
  const t0 = Temporal.Instant.from('2026-11-19T12:00:00Z');
  const t1 = t0.add({ minutes: 10 });
  const t2 = t0.add({ minutes: 20 });

  it('selects the latest canonical failed attempt across non-legacy stops', () => {
    const selected = selectLatestCanonicalFailedAttempt(
      [
        { id: 'stop-legacy', routeId: 'r0', orderId: 'o1', sequence: 1, isLegacy: true, outcome: 'FAILED' },
        { id: 'stop-1', routeId: 'r1', orderId: 'o1', sequence: 1, isLegacy: false, outcome: 'FAILED' },
        { id: 'stop-2', routeId: 'r2', orderId: 'o1', sequence: 1, isLegacy: false, outcome: 'FAILED' },
      ],
      [
        { id: 'att-legacy', stopId: 'stop-legacy', outcome: 'FAILED', failureReason: 'RECIPIENT_ABSENT', recordedAt: t2.add({ minutes: 5 }) },
        { id: 'att-1', stopId: 'stop-1', outcome: 'FAILED', failureReason: 'RECIPIENT_ABSENT', recordedAt: t1 },
        { id: 'att-2', stopId: 'stop-2', outcome: 'FAILED', failureReason: 'RECIPIENT_REFUSED', recordedAt: t2 },
      ],
    );
    expect(selected?.attempt.id).toBe('att-2');
    expect(selected?.stop.routeId).toBe('r2');
  });

  it('requires exact attempt timestamp release on IN_PROGRESS routes and allows historical release on COMPLETED/INTERRUPTED', () => {
    const attempt = {
      id: 'att-1',
      stopId: 'stop-1',
      driverId: 'driver-1',
      outcome: 'FAILED',
      failureReason: 'RECIPIENT_ABSENT',
      recordedAt: t1,
    };
    expect(
      hasReleasedFailedClaim(
        'r1',
        'o1',
        'IN_PROGRESS',
        attempt,
        [{ id: 'c1', routeId: 'r1', orderId: 'o1', claimedAt: t0, releasedAt: t1 }],
        [],
      ),
    ).toBe(true);
    expect(
      hasReleasedFailedClaim(
        'r1',
        'o1',
        'IN_PROGRESS',
        attempt,
        [{ id: 'c1', routeId: 'r1', orderId: 'o1', claimedAt: t0, releasedAt: t2 }],
        [],
      ),
    ).toBe(false);
    expect(
      hasReleasedFailedClaim(
        'r1',
        'o1',
        'COMPLETED',
        attempt,
        [{ id: 'c1', routeId: 'r1', orderId: 'o1', claimedAt: t0, releasedAt: t2 }],
        [],
      ),
    ).toBe(true);
    expect(
      hasReleasedFailedClaim(
        'r1',
        'o1',
        'IN_PROGRESS',
        attempt,
        [{ id: 'c1', routeId: 'r1', orderId: 'o1', claimedAt: t0, releasedAt: t1 }],
        [{ id: 'c2', routeId: 'r2', orderId: 'o1', claimedAt: t2, releasedAt: null }],
      ),
    ).toBe(false);
  });

  it('distinguishes emergency-only and post-failure emergency custody from ordinary failed attempts', () => {
    const attempt = {
      id: 'att-1',
      stopId: 'stop-1',
      outcome: 'FAILED',
      failureReason: 'RECIPIENT_ABSENT',
      recordedAt: t1,
    };
    const emBefore = new Map([['em-before', { id: 'em-before', declaredAt: t0 }]]);
    const emAfter = new Map([['em-after', { id: 'em-after', declaredAt: t2 }]]);
    expect(isEmergencyCustodyActiveForOrder([], emAfter, attempt)).toBe(false);
    expect(isEmergencyCustodyActiveForOrder([{ emergencyId: 'em-after', orderId: 'o1' }], emAfter, null)).toBe(true);
    expect(isEmergencyCustodyActiveForOrder([{ emergencyId: 'em-after', orderId: 'o1' }], emAfter, attempt)).toBe(true);
    expect(isEmergencyCustodyActiveForOrder([{ emergencyId: 'em-before', orderId: 'o1' }], emBefore, attempt)).toBe(false);
  });

  it('matches applied readiness audits strictly by orderId and exact attemptId', () => {
    const audits = [
      {
        id: 'audit-old',
        action: 'CONFIRM_INCIDENT_READY',
        outcome: 'APPLIED',
        orderId: 'o1',
        payload: { attemptId: 'att-1' },
        result: { attemptId: 'att-1' },
      },
      {
        id: 'audit-rejected',
        action: 'CONFIRM_INCIDENT_READY',
        outcome: 'REJECTED',
        orderId: 'o1',
        payload: { attemptId: 'att-2' },
        result: { attemptId: 'att-2' },
      },
    ];
    expect(findAppliedReadinessAudit(audits, 'o1', 'att-1')?.id).toBe('audit-old');
    expect(findAppliedReadinessAudit(audits, 'o1', 'att-2')).toBeNull();
  });

  it('validates route lifecycle evidence and classifies completion claims accurately', () => {
    const attempt = {
      id: 'att-1',
      stopId: 'stop-1',
      driverId: 'driver-1',
      outcome: 'FAILED',
      failureReason: 'RECIPIENT_ABSENT',
      recordedAt: t1,
    };
    expect(
      isValidFailedAttemptRoute(
        { id: 'r1', status: 'IN_PROGRESS', driverId: 'driver-1', startedAt: t0 },
        attempt,
      ),
    ).toBe(true);
    expect(
      isValidFailedAttemptRoute(
        { id: 'r1', status: 'DRAFT', driverId: 'driver-1', startedAt: t0 },
        attempt,
      ),
    ).toBe(false);
    expect(
      classifyFailedStopClaimForCompletion('r1', 'o1', t1, [
        { id: 'c1', routeId: 'r1', orderId: 'o1', claimedAt: t0, releasedAt: t1 },
      ]),
    ).toBe('EARLY_RELEASED');
    expect(
      classifyFailedStopClaimForCompletion('r1', 'o1', t1, [
        { id: 'c1', routeId: 'r1', orderId: 'o1', claimedAt: t0, releasedAt: null },
      ]),
    ).toBe('ACTIVE_LEGACY');
    expect(
      classifyFailedStopClaimForCompletion('r1', 'o1', t1, [
        { id: 'c1', routeId: 'r1', orderId: 'o1', claimedAt: t0, releasedAt: t2 },
      ]),
    ).toBe('INVALID');
  });

  it('distinguishes current failure-timestamp release from unrelated earlier pre-start MOVE-out claims', () => {
    const tMoveOut = t0.subtract({ minutes: 5 });
    const tMoveBack = t0.subtract({ minutes: 2 });
    const attempt = {
      id: 'att-1',
      stopId: 'stop-1',
      driverId: 'driver-1',
      outcome: 'FAILED',
      failureReason: 'RECIPIENT_ABSENT',
      recordedAt: t1,
    };

    // Legacy active claim with an earlier pre-start MOVE-out released claim on the same route is ACTIVE_LEGACY.
    expect(
      classifyFailedStopClaimForCompletion('r1', 'o1', t1, [
        { id: 'c-move-out', routeId: 'r1', orderId: 'o1', claimedAt: tMoveOut.subtract({ minutes: 2 }), releasedAt: tMoveOut },
        { id: 'c-active', routeId: 'r1', orderId: 'o1', claimedAt: tMoveBack, releasedAt: null },
      ]),
    ).toBe('ACTIVE_LEGACY');

    // Active claim alongside a release at or after the failure timestamp is still INVALID.
    expect(
      classifyFailedStopClaimForCompletion('r1', 'o1', t1, [
        { id: 'c-same-ts', routeId: 'r1', orderId: 'o1', claimedAt: tMoveOut, releasedAt: t1 },
        { id: 'c-active', routeId: 'r1', orderId: 'o1', claimedAt: tMoveBack, releasedAt: null },
      ]),
    ).toBe('INVALID');

    // Early release at failure timestamp alongside an earlier MOVE-out claim is EARLY_RELEASED.
    expect(
      classifyFailedStopClaimForCompletion('r1', 'o1', t1, [
        { id: 'c-move-out', routeId: 'r1', orderId: 'o1', claimedAt: tMoveOut.subtract({ minutes: 2 }), releasedAt: tMoveOut },
        { id: 'c-early', routeId: 'r1', orderId: 'o1', claimedAt: tMoveBack, releasedAt: t1 },
      ]),
    ).toBe('EARLY_RELEASED');

    // On COMPLETED/INTERRUPTED routes, an earlier pre-start MOVE-out claim alone does not satisfy failed-claim release.
    expect(
      hasReleasedFailedClaim(
        'r1',
        'o1',
        'COMPLETED',
        attempt,
        [{ id: 'c-move-out', routeId: 'r1', orderId: 'o1', claimedAt: tMoveOut.subtract({ minutes: 2 }), releasedAt: tMoveOut }],
        [],
      ),
    ).toBe(false);
    expect(
      hasReleasedFailedClaim(
        'r1',
        'o1',
        'COMPLETED',
        attempt,
        [
          { id: 'c-move-out', routeId: 'r1', orderId: 'o1', claimedAt: tMoveOut.subtract({ minutes: 2 }), releasedAt: tMoveOut },
          { id: 'c-completed', routeId: 'r1', orderId: 'o1', claimedAt: tMoveBack, releasedAt: t2 },
        ],
        [],
      ),
    ).toBe(true);
  });
});
