import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  startOwnedContainer,
  createOwnedDatabase,
  runPrismaMigrate,
  execPsqlCommand,
  cleanupOwnedResources,
} from './geolocation-migration.fixtures.js';
import {
  COHERENCE_FIXTURE,
  COHERENCE_LEGACY_ROUTE_FIXTURE,
} from './route-lifecycle-coherence.fixtures.js';
import {
  openOwnedSession,
  waitForBlockedSession,
} from './route-lifecycle-integrity.fixtures.js';

describe('Route lifecycle cross-table coherence: owned PostgreSQL 16', () => {
  let database: string;
  let containerId: string;
  let scratchDir: string;
  const sql = (statement: string) => execPsqlCommand(database, statement);

  beforeAll(() => {
    const receipt = startOwnedContainer();
    expect(receipt.host).toBe('127.0.0.1');
    containerId = receipt.containerId;
    scratchDir = receipt.scratchDir;
  });

  beforeEach(() => {
    database = `coherence_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    runPrismaMigrate(createOwnedDatabase(database));
    sql(COHERENCE_FIXTURE + COHERENCE_LEGACY_ROUTE_FIXTURE);
  });

  afterAll(() => {
    cleanupOwnedResources();
    expect(() =>
      execFileSync('docker', ['inspect', containerId], { stdio: 'pipe' }),
    ).toThrow();
    expect(existsSync(scratchDir)).toBe(false);
  });

  it('rejects an active claim not backed by a stable stop on its route', () => {
    expect(() =>
      sql(
        `INSERT INTO public."orderClaim" (id, "routeId", "orderId", "claimedAt") VALUES ('claim-extra', 'route-a', 'order-extra', NOW());`,
      ),
    ).toThrow(/claim|stop|route|coheren/i);
  });

  it('rejects removing a verified active visit claim before completion', () => {
    expect(() => sql(`DELETE FROM public."orderClaim" WHERE id = 'claim-a';`)).toThrow(
      /claim|stop|route|coheren/i,
    );
  });

  it('rejects a draft order pointer before a verified assignment transaction', () => {
    expect(() =>
      sql(
        `UPDATE public."order" SET "routeId" = 'route-draft', "stopOrder" = 1 WHERE id = 'order-draft';`,
      ),
    ).toThrow(/draft|claim|route|coheren/i);
  });

  it('requires assigned verified stops to retain the current order route pointer', () => {
    expect(() =>
      sql(`UPDATE public."order" SET "routeId" = NULL WHERE id = 'order-a';`),
    ).toThrow(/pointer|route|coheren/i);
  });

  it('rejects a verified route after its matching driver hold is removed', () => {
    expect(() =>
      sql(`DELETE FROM public."driverReservation" WHERE id = 'reservation-a';`),
    ).toThrow(/reservation|hold|driver|route|coheren/i);
  });

  it('rejects a reservation whose driver does not own its verified route', () => {
    expect(() =>
      sql(
        `UPDATE public."driverReservation" SET "driverId" = 'driver-workflow' WHERE id = 'reservation-a';`,
      ),
    ).toThrow(/reservation|hold|driver|route|immutable/i);
  });

  it('rejects duplicate active reservations for a single route', () => {
    expect(() =>
      sql(
        `INSERT INTO public."driverReservation" (id, "routeId", "driverId", "reservedAt") VALUES ('reservation-a-extra', 'route-a', 'driver-workflow', NOW());`,
      ),
    ).toThrow(/unique|reservation|hold|route|coheren/i);
  });

  it('rejects an attempt whose outcome disagrees with its immutable stop', () => {
    expect(() =>
      sql(
        `INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, "failureReason", context, "idempotencyKey", "requestPayload") VALUES ('attempt-mismatch', 'stop-a', 'driver-a', 'FAILED', 'RECIPIENT_ABSENT', '{}', 'mismatch', '{}');`,
      ),
    ).toThrow(/attempt|outcome|stop|visit|review/i);
  });

  it('rejects an attempt authored by a different route driver', () => {
    expect(() =>
      sql(
        `INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, context, "idempotencyKey", "requestPayload") VALUES ('attempt-owner', 'stop-a', 'driver-b', 'SUCCESSFUL', '{}', 'wrong-owner', '{}');`,
      ),
    ).toThrow(/attempt|driver|owner|route|stop|outcome/i);
  });

  it('rejects a failed visit without the current administrative-review flag', () => {
    expect(() =>
      sql(
        `BEGIN; UPDATE public."routeStop" SET outcome = 'FAILED' WHERE id = 'stop-a'; INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, "failureReason", context, "idempotencyKey", "requestPayload") VALUES ('attempt-review', 'stop-a', 'driver-a', 'FAILED', 'RECIPIENT_ABSENT', '{}', 'review', '{}'); COMMIT;`,
      ),
    ).toThrow(/review|failed|attempt|outcome/i);
  });

  it('rejects attempt timestamps before the current route start', () => {
    expect(() =>
      sql(
        `BEGIN; UPDATE public."routeStop" SET outcome = 'SUCCESSFUL' WHERE id = 'stop-a'; INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, "recordedAt", context, "idempotencyKey", "requestPayload") VALUES ('attempt-before-start', 'stop-a', 'driver-a', 'SUCCESSFUL', (SELECT "startedAt" - INTERVAL '1 second' FROM public.route WHERE id = 'route-a'), '{}', 'before-start', '{}'); COMMIT;`,
      ),
    ).toThrow(/attempt|time|start|route|stop/i);
  });

  it('enforces failure-reason pairing on direct attempt inserts', () => {
    expect(() =>
      sql(
        `BEGIN; UPDATE public."routeStop" SET outcome = 'FAILED' WHERE id = 'stop-a'; UPDATE public."order" SET "requiresAdministrativeReview" = true WHERE id = 'order-a'; INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, "failureReason", context, "idempotencyKey", "requestPayload") VALUES ('attempt-pair', 'stop-a', 'driver-a', 'FAILED', NULL, '{}', 'pair', '{}'); COMMIT;`,
      ),
    ).toThrow(/check|failure|reason|attempt|outcome/i);
  });

  it('requires the current administrator role when a reconciliation is inserted', () => {
    expect(() =>
      sql(
        `INSERT INTO public."legacyRouteReconciliation" (id, "routeId", "administratorId", reason, evidence) VALUES ('audit-driver', 'route-legacy', 'owner-a', 'Not an administrator', '{}');`,
      ),
    ).toThrow(/admin|authority|role|reconcil/i);
  });

  it('retains a valid audit after the administrator is later demoted', () => {
    sql(
      `INSERT INTO public."legacyRouteReconciliation" (id, "routeId", "administratorId", reason, evidence) VALUES ('audit-demoted', 'route-legacy', 'admin', 'Verified legacy history', '{}'); UPDATE public."user" SET role = 'DRIVER' WHERE id = 'admin';`,
    );
    expect(
      sql(
        `SELECT COUNT(*) FROM public."legacyRouteReconciliation" WHERE id = 'audit-demoted';`,
      ),
    ).toBe('1');
  });

  it('rejects a second reconciliation audit for the same route', () => {
    expect(() =>
      sql(
        `INSERT INTO public."legacyRouteReconciliation" (id, "routeId", "administratorId", reason, evidence) VALUES ('audit-first', 'route-legacy', 'admin', 'First', '{}'); INSERT INTO public."legacyRouteReconciliation" (id, "routeId", "administratorId", reason, evidence) VALUES ('audit-second', 'route-legacy', 'admin', 'Second', '{}');`,
      ),
    ).toThrow(/unique|reconcil|route/i);
  });

  it('rejects claim release outside its matching completion', () => {
    expect(() =>
      sql(`UPDATE public."orderClaim" SET "releasedAt" = NOW() WHERE id = 'claim-a';`),
    ).toThrow(/immutable|claim|release|completion/i);
  });

  it('rejects direct rewrites of released claim identity and release time', () => {
    expect(() =>
      sql(`UPDATE public."orderClaim" SET "routeId" = 'route-a' WHERE id = 'claim-completed';`),
    ).toThrow(/immutable|claim|release/i);
    expect(() =>
      sql(
        `UPDATE public."orderClaim" SET "releasedAt" = NOW() WHERE id = 'claim-completed';`,
      ),
    ).toThrow(/immutable|claim|release/i);
  });

  it('serializes current administrator authorization against concurrent demotion', async () => {
    const demotion = openOwnedSession(database, 'coherence-admin-demotion');
    const audit = openOwnedSession(database, 'coherence-admin-audit');
    try {
      await demotion.ready();
      await audit.ready();
      await demotion.query(
        `BEGIN; UPDATE public."user" SET role = 'DRIVER' WHERE id = 'admin';`,
      );
      const pending = audit
        .query(
          `BEGIN; INSERT INTO public."legacyRouteReconciliation" (id, "routeId", "administratorId", reason, evidence) VALUES ('audit-concurrent', 'route-legacy', 'admin', 'Concurrent role check', '{}'); COMMIT;`,
        )
        .then(
          () => 'committed',
          (error: Error) => error.message,
        );
      await waitForBlockedSession(database, 'coherence-admin-audit');
      await demotion.query('COMMIT;');
      expect(await pending).toMatch(/admin|role|authority/i);
      expect(
        sql(
          `SELECT COUNT(*) FROM public."legacyRouteReconciliation" WHERE id = 'audit-concurrent';`,
        ),
      ).toBe('0');
    } finally {
      await demotion.close();
      await audit.close();
    }
  });

  it('serializes competing active claims on the same visit order', async () => {
    sql(
      `INSERT INTO public."user" (id, name, email, password, role) VALUES ('claim-owner-a', 'Claim Owner A', 'claim-a@fixture.invalid', 'fixture', 'DRIVER'), ('claim-owner-b', 'Claim Owner B', 'claim-b@fixture.invalid', 'fixture', 'DRIVER'); INSERT INTO public.driver (id, "userId", vehicle) VALUES ('claim-driver-a', 'claim-owner-a', 'Race A'), ('claim-driver-b', 'claim-owner-b', 'Race B'); INSERT INTO public."order" (id, "userId", "zoneId", status, "deliveryAddress") VALUES ('shared-order', 'client', 'zone', 'PENDING', 'Shared'); INSERT INTO public.route (id, "zoneId", status) VALUES ('claim-route-a', 'zone', 'DRAFT'), ('claim-route-b', 'zone', 'DRAFT');`,
    );
    const first = openOwnedSession(database, 'coherence-claim-first');
    const second = openOwnedSession(database, 'coherence-claim-second');
    try {
      await first.ready();
      await second.ready();
      await first.query(
        `BEGIN; INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome) VALUES ('claim-stop-a', 'claim-route-a', 'shared-order', 1, 'PENDING'); INSERT INTO public."orderClaim" (id, "routeId", "orderId", "claimedAt") VALUES ('shared-claim-a', 'claim-route-a', 'shared-order', NOW()); INSERT INTO public."driverReservation" (id, "routeId", "driverId", "reservedAt") VALUES ('shared-reservation-a', 'claim-route-a', 'claim-driver-a', NOW()); UPDATE public.route SET "driverId" = 'claim-driver-a', status = 'ASSIGNED' WHERE id = 'claim-route-a'; UPDATE public."order" SET "routeId" = 'claim-route-a', "stopOrder" = 1, status = 'ASSIGNED' WHERE id = 'shared-order';`,
      );
      const pending = second
        .query(
          `BEGIN; INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome) VALUES ('claim-stop-b', 'claim-route-b', 'shared-order', 1, 'PENDING'); INSERT INTO public."orderClaim" (id, "routeId", "orderId", "claimedAt") VALUES ('shared-claim-b', 'claim-route-b', 'shared-order', NOW()); INSERT INTO public."driverReservation" (id, "routeId", "driverId", "reservedAt") VALUES ('shared-reservation-b', 'claim-route-b', 'claim-driver-b', NOW()); UPDATE public.route SET "driverId" = 'claim-driver-b', status = 'ASSIGNED' WHERE id = 'claim-route-b'; UPDATE public."order" SET "routeId" = 'claim-route-b', "stopOrder" = 1, status = 'ASSIGNED' WHERE id = 'shared-order'; COMMIT;`,
        )
        .then(
          () => 'committed',
          (error: Error) => error.message,
        );
      await waitForBlockedSession(database, 'coherence-claim-second');
      await first.query('COMMIT;');
      expect(await pending).toMatch(/unique|claim/i);
      expect(
        sql(
          `SELECT COUNT(*) FROM public."orderClaim" WHERE "orderId" = 'shared-order' AND "releasedAt" IS NULL;`,
        ),
      ).toBe('1');
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('accepts full deferred assignment, failure, completion, and return in one transaction', () => {
    sql(
      `BEGIN;
       INSERT INTO public."order" (id, "userId", "zoneId", status, "deliveryAddress") VALUES ('workflow-order', 'client', 'zone', 'PENDING', 'Workflow');
       INSERT INTO public.route (id, "zoneId", status) VALUES ('workflow-route', 'zone', 'DRAFT');
       INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome) VALUES ('workflow-stop', 'workflow-route', 'workflow-order', 1, 'PENDING');
       UPDATE public.route SET "driverId" = 'driver-workflow', status = 'ASSIGNED' WHERE id = 'workflow-route';
       UPDATE public."order" SET "routeId" = 'workflow-route', "stopOrder" = 1, status = 'ASSIGNED' WHERE id = 'workflow-order';
       INSERT INTO public."orderClaim" (id, "routeId", "orderId", "claimedAt") VALUES ('workflow-claim', 'workflow-route', 'workflow-order', NOW());
       INSERT INTO public."driverReservation" (id, "routeId", "driverId", "reservedAt") VALUES ('workflow-reservation', 'workflow-route', 'driver-workflow', NOW());
       UPDATE public.route SET status = 'IN_PROGRESS', "startedAt" = NOW() - INTERVAL '2 seconds', "startedById" = 'owner-workflow' WHERE id = 'workflow-route';
       UPDATE public."routeStop" SET outcome = 'FAILED' WHERE id = 'workflow-stop';
       UPDATE public."order" SET "requiresAdministrativeReview" = true WHERE id = 'workflow-order';
       INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, "failureReason", "recordedAt", context, "idempotencyKey", "requestPayload") VALUES ('workflow-attempt', 'workflow-stop', 'driver-workflow', 'FAILED', 'RECIPIENT_ABSENT', NOW() - INTERVAL '1 second', '{}', 'workflow', '{}');
       UPDATE public.route SET status = 'COMPLETED', "completedAt" = NOW() - INTERVAL '1 second', "completedById" = 'owner-workflow' WHERE id = 'workflow-route';
       UPDATE public."orderClaim" SET "releasedAt" = (SELECT "completedAt" FROM public.route WHERE id = 'workflow-route') WHERE id = 'workflow-claim';
       UPDATE public.route SET "returnedAt" = NOW(), "returnedById" = 'owner-workflow' WHERE id = 'workflow-route';
       UPDATE public."driverReservation" SET "releasedAt" = (SELECT "returnedAt" FROM public.route WHERE id = 'workflow-route') WHERE id = 'workflow-reservation';
       COMMIT;`,
    );
    expect(
      sql(
        `SELECT r.status || '|' || (c."releasedAt" = r."completedAt")::text || '|' || (d."releasedAt" = r."returnedAt")::text FROM public.route r JOIN public."orderClaim" c ON c."routeId" = r.id JOIN public."driverReservation" d ON d."routeId" = r.id WHERE r.id = 'workflow-route';`,
      ),
    ).toBe('COMPLETED|true|true');
  });
});
