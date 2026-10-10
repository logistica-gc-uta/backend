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
} from './route-lifecycle-migration.fixtures.js';
import {
  FOUNDATION_HASH,
  seedVerifiedRoute,
  openOwnedSession,
  waitForBlockedSession,
} from './route-lifecycle-integrity.fixtures.js';

describe('Route lifecycle PostgreSQL integrity', () => {
  const db = `integrity_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  let containerId: string;
  let scratchDir: string;
  const sql = (statement: string) => execPsqlCommand(db, statement);
  beforeAll(() => {
    const receipt = startOwnedContainer();
    expect(receipt.host).toBe('127.0.0.1');
    containerId = receipt.containerId;
    scratchDir = receipt.scratchDir;
    const url = createOwnedDatabase(db);
    runPrismaMigrate(url, ROUTE_BASELINE_HASH);
    sql(LEGACY_ROUTE_FIXTURE);
    runPrismaMigrate(url, FOUNDATION_HASH);
    runPrismaMigrate(url, 'c98b76b8c2f003d377fd1882031490290222be3a85b69a682ff58da04f9c590a');
    sql(
      `INSERT INTO public.zone (id, name, code) VALUES ('other-zone', 'Other', 'OTHER');`,
    );
  });
  afterAll(() => {
    cleanupOwnedResources();
    expect(() =>
      execFileSync('docker', ['inspect', containerId], { stdio: 'pipe' }),
    ).toThrow();
    expect(existsSync(scratchDir)).toBe(false);
  });

  it('preserves ambiguous legacy history and rejects invented lifecycle or structural edits', () => {
    expect(
      sql(
        `SELECT COUNT(*) FROM public."routeStop" WHERE "isLegacy" AND outcome IS NULL;`,
      ),
    ).toBe('4');
    for (const change of [
      "status = 'COMPLETED'",
      '"driverId" = NULL',
      'date = NOW()',
      '"returnedAt" = NOW()',
    ]) {
      expect(() =>
        sql(`UPDATE public.route SET ${change} WHERE id = 'legacy-a';`),
      ).toThrow(/legacy|unverified/i);
    }
    expect(() =>
      sql(`DELETE FROM public."routeStop" WHERE "orderId" = 'order-invalid';`),
    ).toThrow(/legacy|unverified/i);
  });

  it.each(['IN_PROGRESS', 'COMPLETED'])(
    'freezes route and stop structure in %s',
    (status) => {
      const route = `freeze-${status}`;
      seedVerifiedRoute(db, route);
      sql(
        `UPDATE public.route SET status = '${status}' WHERE id = '${route}';`,
      );
      expect(() =>
        sql(
          `UPDATE public.route SET status = 'ASSIGNED' WHERE id = '${route}';`,
        ),
      ).toThrow(/frozen/i);
      expect(() =>
        sql(`DELETE FROM public.route WHERE id = '${route}';`),
      ).toThrow(/frozen/i);
      if (status === 'COMPLETED') {
        expect(() =>
          sql(
            `UPDATE public.route SET status = 'IN_PROGRESS' WHERE id = '${route}';`,
          ),
        ).toThrow(/frozen/i);
      }
      for (const change of [
        '"driverId" = NULL',
        '"zoneId" = \'other-zone\'',
        'date = NOW()',
      ]) {
        expect(() =>
          sql(`UPDATE public.route SET ${change} WHERE id = '${route}';`),
        ).toThrow(/frozen/i);
      }
      for (const change of [
        'sequence = 2',
        '"orderId" = \'order-null\'',
        '"isLegacy" = true',
        '"routeId" = \'legacy-a\'',
      ]) {
        expect(() =>
          sql(
            `UPDATE public."routeStop" SET ${change} WHERE id = '${route}-stop-1';`,
          ),
        ).toThrow(/frozen|legacy/i);
      }
      expect(() =>
        sql(`DELETE FROM public."routeStop" WHERE id = '${route}-stop-1';`),
      ).toThrow(/frozen/i);
      expect(() =>
        sql(
          `INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome) VALUES ('${route}-extra', '${route}', '${route}-order-2', 2, 'PENDING');`,
        ),
      ).toThrow(/frozen/i);
      if (status === 'IN_PROGRESS') {
        expect(() =>
          sql(
            `UPDATE public."routeStop" SET outcome = 'SUCCESSFUL' WHERE id = '${route}-stop-1';`,
          ),
        ).not.toThrow();
      } else {
        expect(() =>
          sql(
            `UPDATE public."routeStop" SET outcome = 'FAILED' WHERE id = '${route}-stop-1';`,
          ),
        ).toThrow(/outcome|frozen/i);
      }
    },
  );

  it('enforces verified stop bounds, zone, legacy bypass defenses and four-stop maximum', () => {
    seedVerifiedRoute(db, 'bounds', 4);
    for (const sequence of ['NULL', '0', '5']) {
      expect(() =>
        sql(
          `UPDATE public."routeStop" SET sequence = ${sequence} WHERE id = 'bounds-stop-1';`,
        ),
      ).toThrow(/sequence|verified/i);
    }
    expect(() =>
      sql(
        `UPDATE public."routeStop" SET "isLegacy" = true WHERE id = 'bounds-stop-1';`,
      ),
    ).toThrow(/legacy|verified/i);
    expect(() =>
      sql(
        `INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, "isLegacy") VALUES ('bypass', 'bounds', 'bounds-order-5', 5, true);`,
      ),
    ).toThrow(/legacy|verified/i);
    expect(() =>
      sql(
        `INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome) VALUES ('fifth', 'bounds', 'bounds-order-5', 1, 'PENDING');`,
      ),
    ).toThrow(/maximum|four|4/i);
    sql(
      `UPDATE public."order" SET "zoneId" = 'other-zone' WHERE id = 'bounds-order-5';`,
    );
    expect(() =>
      sql(
        `UPDATE public."routeStop" SET "orderId" = 'bounds-order-5' WHERE id = 'bounds-stop-1';`,
      ),
    ).toThrow(/zone/i);
    expect(() =>
      sql(
        `UPDATE public.route SET "zoneId" = 'other-zone' WHERE id = 'bounds';`,
      ),
    ).toThrow(/zone/i);
    expect(() =>
      sql(
        `UPDATE public."routeStop" SET outcome = 'FAILED' WHERE id = 'bounds-stop-1';`,
      ),
    ).toThrow(/outcome/i);
  });

  it('prevents retroactive editing of recorded event times and actors', () => {
    seedVerifiedRoute(db, 'events');
    sql(
      `UPDATE public.route SET status = 'IN_PROGRESS', "startedAt" = NOW(), "startedById" = 'events-user' WHERE id = 'events';`,
    );
    for (const change of [
      '"startedAt" = NULL',
      '"startedAt" = NOW() + INTERVAL \'1 hour\'',
      '"startedById" = \'admin\'',
    ]) {
      expect(() =>
        sql(`UPDATE public.route SET ${change} WHERE id = 'events';`),
      ).toThrow(/event|immutable/i);
    }
    sql(
      `UPDATE public.route SET status = 'COMPLETED', "completedAt" = NOW(), "completedById" = 'events-user' WHERE id = 'events'; UPDATE public.route SET "returnedAt" = NOW(), "returnedById" = 'events-user' WHERE id = 'events';`,
    );
    expect(() =>
      sql(
        `UPDATE public.route SET "returnedAt" = NULL, "returnedById" = NULL WHERE id = 'events';`,
      ),
    ).toThrow(/event|immutable/i);
  });

  it('makes attempt and reconciliation evidence append-only', () => {
    seedVerifiedRoute(db, 'audit');
    sql(
      `INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, context, "idempotencyKey", "requestPayload") VALUES ('immutable-attempt', 'audit-stop-1', 'audit-driver', 'SUCCESSFUL', '{}', 'key', '{}'); INSERT INTO public."legacyRouteReconciliation" (id, "routeId", "administratorId", reason, evidence) VALUES ('immutable-reconcile', 'legacy-a', 'admin', 'Verified records', '{}');`,
    );
    for (const table of ['deliveryAttempt', 'legacyRouteReconciliation']) {
      expect(() => sql(`TRUNCATE TABLE public."${table}";`)).toThrow(
        /append.only/i,
      );
      expect(() =>
        sql(`UPDATE public."${table}" SET "recordedAt" = NOW();`),
      ).toThrow(/append.only/i);
      expect(() => sql(`DELETE FROM public."${table}";`)).toThrow(
        /append.only/i,
      );
    }
  });

  it.each(['insert', 'reorder'])(
    'serializes start versus stop %s in both lock orders',
    async (operation) => {
      for (const startFirst of [true, false]) {
        const route = `race-${operation}-${startFirst}`;
        seedVerifiedRoute(db, route);
        const start = `UPDATE public.route SET status = 'IN_PROGRESS' WHERE id = '${route}';`;
        const edit =
          operation === 'insert'
            ? `INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome) VALUES ('${route}-new', '${route}', '${route}-order-2', 2, 'PENDING');`
            : `UPDATE public."routeStop" SET sequence = 2 WHERE id = '${route}-stop-1';`;
        const first = openOwnedSession(db, `${route}-first`);
        const second = openOwnedSession(db, `${route}-second`);
        try {
          await first.ready();
          await second.ready();
          await first.query(`BEGIN; ${startFirst ? start : edit}`);
          const pending = second
            .query(`BEGIN; ${startFirst ? edit : start} COMMIT;`)
            .then(
              () => 'committed',
              (error: Error) => error.message,
            );
          await waitForBlockedSession(db, `${route}-second`);
          await first.query('COMMIT;');
          expect(await pending).toMatch(startFirst ? /frozen/i : /committed/);
          expect(
            sql(`SELECT status FROM public.route WHERE id = '${route}';`),
          ).toBe('IN_PROGRESS');
        } finally {
          await first.close();
          await second.close();
        }
      }
    },
  );

  it('prevents concurrent same-driver IN_PROGRESS routes without reservation records', async () => {
    seedVerifiedRoute(db, 'parallel-a');
    seedVerifiedRoute(db, 'parallel-b');
    sql(
      `UPDATE public.route SET "driverId" = 'parallel-a-driver' WHERE id = 'parallel-b';`,
    );
    const first = openOwnedSession(db, 'parallel-first');
    const second = openOwnedSession(db, 'parallel-second');
    try {
      await first.ready();
      await second.ready();
      await first.query(
        `BEGIN; UPDATE public.route SET status = 'IN_PROGRESS' WHERE id = 'parallel-a';`,
      );
      const pending = second
        .query(
          `BEGIN; UPDATE public.route SET status = 'IN_PROGRESS' WHERE id = 'parallel-b'; COMMIT;`,
        )
        .then(
          () => 'committed',
          (error: Error) => error.message,
        );
      await waitForBlockedSession(db, 'parallel-second');
      await first.query('COMMIT;');
      expect(await pending).toMatch(/unique/i);
      expect(sql(`SELECT COUNT(*) FROM public."driverReservation";`)).toBe('0');
    } finally {
      await first.close();
      await second.close();
    }
  });

  it.each([
    ['orderClaim', 'orderId', 'order-one'],
    ['driverReservation', 'driverId', 'driver'],
  ])(
    'serializes active %s collisions using separate connections',
    async (table, field, resource) => {
      const first = openOwnedSession(db, `${table}-first`);
      const second = openOwnedSession(db, `${table}-second`);
      try {
        await first.ready();
        await second.ready();
        await first.query(
          `BEGIN; INSERT INTO public."${table}" (id, "routeId", "${field}") VALUES ('${table}-a', 'legacy-a', '${resource}');`,
        );
        const pending = second
          .query(
            `BEGIN; INSERT INTO public."${table}" (id, "routeId", "${field}") VALUES ('${table}-b', 'legacy-b', '${resource}'); COMMIT;`,
          )
          .then(
            () => 'committed',
            (error: Error) => error.message,
          );
        await waitForBlockedSession(db, `${table}-second`);
        await first.query('COMMIT;');
        expect(await pending).toMatch(/unique/i);
        expect(
          sql(
            `SELECT COUNT(*) FROM public."${table}" WHERE "${field}" = '${resource}' AND "releasedAt" IS NULL;`,
          ),
        ).toBe('1');
      } finally {
        await first.close();
        await second.close();
      }
    },
  );
});
