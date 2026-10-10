import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  execPsqlCommand,
  getOwnedContainerReceipt,
  validateOwnedDatabaseUrl,
} from './geolocation-migration.fixtures.js';

export const FOUNDATION_HASH =
  '46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452';

export function seedVerifiedRoute(db: string, prefix: string, stops = 1): void {
  execPsqlCommand(
    db,
    `
    INSERT INTO public."user" (id, name, email, password, role)
      VALUES ('${prefix}-user', 'Driver', '${prefix}@fixture.invalid', 'fixture', 'DRIVER');
    INSERT INTO public.driver (id, "userId", vehicle)
      VALUES ('${prefix}-driver', '${prefix}-user', 'Fixture');
    INSERT INTO public.route (id, "driverId", "zoneId", status)
      VALUES ('${prefix}', '${prefix}-driver', 'zone', 'DRAFT');
    INSERT INTO public."order" (id, "userId", "zoneId", "deliveryAddress")
      SELECT '${prefix}-order-' || n, 'client', 'zone', 'Fixture' FROM generate_series(1, 5) n;
    INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome)
      SELECT '${prefix}-stop-' || n, '${prefix}', '${prefix}-order-' || n, n, 'PENDING'
      FROM generate_series(1, ${stops}) n;
    INSERT INTO public."orderClaim" (id, "routeId", "orderId", "claimedAt")
      SELECT '${prefix}-claim-' || n, '${prefix}', '${prefix}-order-' || n, now()
      FROM generate_series(1, ${stops}) n;
  `,
  );
}

// Persistent psql processes provide two real connections without another dependency.
export function openOwnedSession(db: string, applicationName: string) {
  validateOwnedDatabaseUrl(db);
  const receipt = getOwnedContainerReceipt();
  if (!receipt) throw new Error('No owned PostgreSQL session');
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      receipt.containerId,
      'psql',
      '-U',
      receipt.user,
      '-d',
      db,
      '-X',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  let errors = '';
  let pending: {
    marker: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  } | null = null;
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (pending && output.includes(pending.marker)) {
      const current = pending;
      pending = null;
      current.resolve(output.slice(0, output.indexOf(current.marker)).trim());
      output = '';
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      pending?.reject(new Error(errors || 'PostgreSQL session closed'));
      pending = null;
      resolve();
    }),
  );
  child.on('error', (error) => pending?.reject(error));
  function query(sql: string): Promise<string> {
    if (pending) throw new Error('A query is already running in this session');
    if (child.exitCode !== null)
      return Promise.reject(new Error(errors || 'Session already closed'));
    return new Promise((resolve, reject) => {
      const marker = `barrier_${randomUUID().replace(/-/g, '')}`;
      pending = { marker, resolve, reject };
      child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }
  return {
    query,
    ready: () =>
      query(
        `SET application_name = '${applicationName}'; SET statement_timeout = '8s'; SET lock_timeout = '6s';`,
      ),
    close: async () => {
      child.stdin.end('\\q\n');
      await closed;
    },
  };
}

export async function waitForBlockedSession(
  db: string,
  applicationName: string,
): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (
      execPsqlCommand(
        db,
        `SELECT COUNT(*) FROM pg_stat_activity WHERE application_name = '${applicationName}' AND cardinality(pg_blocking_pids(pid)) > 0;`,
      ) === '1'
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Session ${applicationName} did not reach the real PostgreSQL lock barrier`,
  );
}
