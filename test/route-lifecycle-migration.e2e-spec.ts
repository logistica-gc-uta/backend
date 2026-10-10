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
  LEGACY_ROUTE_FIXTURE,
  ROUTE_BASELINE_HASH,
  ROUTE_FOUNDATION_HASH,
} from './route-lifecycle-migration.fixtures.js';

describe('Route lifecycle foundation migration', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const legacyName = `route_legacy_${suffix}`;
  const freshName = `route_fresh_${suffix}`;
  let legacyUrl: string;
  let containerId: string;
  let scratchDir: string;

  beforeAll(() => {
    const receipt = startOwnedContainer();
    expect(receipt.host).toBe('127.0.0.1');
    containerId = receipt.containerId;
    scratchDir = receipt.scratchDir;
    legacyUrl = createOwnedDatabase(legacyName);
    runPrismaMigrate(legacyUrl, ROUTE_BASELINE_HASH);
    execPsqlCommand(legacyName, LEGACY_ROUTE_FIXTURE);
  });

  afterAll(() => {
    cleanupOwnedResources();
    if (containerId) {
      expect(() =>
        execFileSync('docker', ['inspect', containerId], { stdio: 'pipe' }),
      ).toThrow();
      expect(existsSync(scratchDir)).toBe(false);
    }
  });

  it('adds nullable lifecycle without inventing legacy events', () => {
    runPrismaMigrate(legacyUrl, ROUTE_FOUNDATION_HASH);
    const columns = execPsqlCommand(
      legacyName,
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'route' ORDER BY column_name;`,
    );
    expect(columns.split('\n')).toEqual(
      expect.arrayContaining([
        'status',
        'startedAt',
        'completedAt',
        'returnedAt',
      ]),
    );
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT COUNT(*) FROM public.route WHERE status IS NULL AND "startedAt" IS NULL AND "completedAt" IS NULL AND "returnedAt" IS NULL;`,
      ),
    ).toBe('2');
  });

  it('backfills exact associations and ambiguous positions without commercial status changes', () => {
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT COUNT(*) FROM public."routeStop" s JOIN public."order" o ON s."orderId" = o.id AND s."routeId" = o."routeId" WHERE s.sequence IS NOT DISTINCT FROM o."stopOrder" AND s.outcome IS NULL AND s."isLegacy" = true;`,
      ),
    ).toBe('4');
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT string_agg(status, ',' ORDER BY id) FROM public."order";`,
      ),
    ).toBe('DELIVERED,CANCELLED,PENDING,ASSIGNED');
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT COUNT(*) FROM public."order" WHERE "requiresAdministrativeReview";`,
      ),
    ).toBe('0');
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT COUNT(*) FROM public.route WHERE "driverId" = 'driver' AND status IS NULL;`,
      ),
    ).toBe('2');
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT COUNT(*) FROM public."driverReservation";`,
      ),
    ).toBe('0');
  });

  it('migrates fresh databases and allows an explicit driverless draft', () => {
    runPrismaMigrate(createOwnedDatabase(freshName), ROUTE_FOUNDATION_HASH);
    execPsqlCommand(
      freshName,
      `INSERT INTO public.zone (id, name, code) VALUES ('zone', 'Fresh', 'FRESH'); INSERT INTO public.route (id, "zoneId", status) VALUES ('draft', 'zone', 'DRAFT');`,
    );
    expect(
      execPsqlCommand(
        freshName,
        `SELECT ("driverId" IS NULL)::text FROM public.route WHERE id = 'draft';`,
      ),
    ).toBe('true');
  });

  it('keeps legacy uncertainty outside the four verified business states', () => {
    expect(() =>
      execPsqlCommand(
        freshName,
        `UPDATE public.route SET status = 'UNVERIFIED' WHERE id = 'draft';`,
      ),
    ).toThrow(/check/i);
    expect(
      execPsqlCommand(
        freshName,
        `SELECT column_default IS NULL FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'route' AND column_name = 'status';`,
      ),
    ).toBe('t');
  });

  it('retains legacy history and two future stops for one order across routes', () => {
    execPsqlCommand(
      legacyName,
      `INSERT INTO public.route (id, "zoneId", status) VALUES ('future-a', 'zone', 'DRAFT'), ('future-b', 'zone', 'DRAFT');
       INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome) VALUES ('future-stop', 'future-a', 'order-one', 1, 'PENDING'), ('future-stop-two', 'future-b', 'order-one', 1, 'PENDING');`,
    );
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT COUNT(*) FROM public."routeStop" WHERE "orderId" = 'order-one';`,
      ),
    ).toBe('3');
  });

  it.each([
    ['orderClaim', 'orderId', 'order-one'],
    ['driverReservation', 'driverId', 'driver'],
  ])(
    'enforces one active %s and retains released claim history',
    (table, resource, id) => {
      execPsqlCommand(
        legacyName,
        `INSERT INTO public."${table}" (id, "routeId", "${resource}") VALUES ('${table}-first', 'legacy-a', '${id}');`,
      );
      expect(() =>
        execPsqlCommand(
          legacyName,
          `INSERT INTO public."${table}" (id, "routeId", "${resource}") VALUES ('${table}-collision', 'legacy-b', '${id}');`,
        ),
      ).toThrow(/unique/i);
      execPsqlCommand(
        legacyName,
        `UPDATE public."${table}" SET "releasedAt" = NOW() WHERE id = '${table}-first'; INSERT INTO public."${table}" (id, "routeId", "${resource}") VALUES ('${table}-next', 'legacy-b', '${id}');`,
      );
      expect(
        execPsqlCommand(
          legacyName,
          `SELECT COUNT(*) FROM public."${table}" WHERE "${resource}" = '${id}';`,
        ),
      ).toBe('2');
    },
  );

  it('stores replay evidence and reconciliation without pretending business events occurred', () => {
    execPsqlCommand(
      legacyName,
      `INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, "failureReason", context, "idempotencyKey", "requestPayload") VALUES ('attempt', 'future-stop', 'driver', 'FAILED', 'RECIPIENT_ABSENT', '{"note":"No answer"}', 'retry-1', '{"outcome":"FAILED"}'); INSERT INTO public."legacyRouteReconciliation" (id, "routeId", "administratorId", reason, evidence, "releaseDriverHold") VALUES ('audit', 'legacy-a', 'admin', 'Verified previous return', '{"source":"administrative investigation"}', true);`,
    );
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT outcome || '|' || "failureReason" || '|' || ("recordedAt" IS NOT NULL)::text FROM public."deliveryAttempt" WHERE id = 'attempt';`,
      ),
    ).toBe('FAILED|RECIPIENT_ABSENT|true');
    for (const failureReason of ['ABSENCE', 'REFUSAL', 'OTHER']) {
      expect(() =>
        execPsqlCommand(
          legacyName,
          `INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, "failureReason", context, "idempotencyKey", "requestPayload") VALUES ('invalid-${failureReason}', 'future-stop', 'driver', 'FAILED', '${failureReason}', '{}', 'invalid-${failureReason}', '{}');`,
        ),
      ).toThrow(/check/i);
    }
    expect(() =>
      execPsqlCommand(
        legacyName,
        `INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, "failureReason", context, "idempotencyKey", "requestPayload") VALUES ('refusal-attempt', 'future-stop', 'driver', 'FAILED', 'RECIPIENT_REFUSED', '{}', 'retry-refusal', '{}');`,
      ),
    ).not.toThrow();
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT "requestPayload"->>'outcome' FROM public."deliveryAttempt" WHERE id = 'attempt';`,
      ),
    ).toBe('FAILED');
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT COUNT(*) FROM public.route WHERE status IS NULL AND "returnedAt" IS NULL;`,
      ),
    ).toBe('2');
    expect(() =>
      execPsqlCommand(
        legacyName,
        `INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, context, "idempotencyKey", "requestPayload") VALUES ('duplicate-attempt', 'future-stop', 'driver', 'SUCCESSFUL', '{}', 'retry-1', '{}');`,
      ),
    ).toThrow(/unique/i);
  });

  it('rejects duplicate verified positions while retaining ambiguous legacy positions', () => {
    expect(() =>
      execPsqlCommand(
        legacyName,
        `INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome) VALUES ('duplicate-position', 'future-a', 'order-null', 1, 'PENDING');`,
      ),
    ).toThrow(/unique/i);
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT COUNT(*) FROM public."routeStop" WHERE "routeId" = 'legacy-a' AND sequence = 1;`,
      ),
    ).toBe('2');
  });

  it('rolls back migration DDL and retains baseline marker after a conflicting legacy table', () => {
    const name = `route_rollback_${suffix}`;
    const url = createOwnedDatabase(name);
    runPrismaMigrate(url, ROUTE_BASELINE_HASH);
    execPsqlCommand(name, `CREATE TABLE public."routeStop" (sentinel text);`);
    expect(() => runPrismaMigrate(url, ROUTE_FOUNDATION_HASH)).toThrow();
    expect(
      execPsqlCommand(
        name,
        `SELECT core_hash FROM prisma_contract.marker WHERE space = 'app';`,
      ),
    ).toBe(ROUTE_BASELINE_HASH);
    expect(
      execPsqlCommand(
        name,
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('deliveryAttempt', 'driverReservation', 'orderClaim', 'legacyRouteReconciliation');`,
      ),
    ).toBe('0');
    expect(
      execPsqlCommand(
        name,
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'routeStop';`,
      ),
    ).toBe('sentinel');
  });

  it('rolls back an entire failed claim transaction', () => {
    expect(() =>
      execPsqlCommand(
        legacyName,
        `BEGIN; INSERT INTO public."orderClaim" (id, "routeId", "orderId") VALUES ('rollback-first', 'legacy-a', 'order-null'); INSERT INTO public."orderClaim" (id, "routeId", "orderId") VALUES ('rollback-collision', 'legacy-b', 'order-one'); COMMIT;`,
      ),
    ).toThrow(/unique/i);
    expect(
      execPsqlCommand(
        legacyName,
        `SELECT COUNT(*) FROM public."orderClaim" WHERE id = 'rollback-first';`,
      ),
    ).toBe('0');
  });
});
