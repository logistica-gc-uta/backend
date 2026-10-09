import { execFileSync, ExecFileSyncOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface OwnedContainerReceipt {
  readonly containerId: string;
  readonly sessionToken: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly createdAt: number;
  readonly scratchDir: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64_REGEX = /^[a-f0-9]{64}$/i;
const SCRATCH_PREFIX_REGEX = /^[a-zA-Z0-9_-]+$/;

let sessionReceipt: OwnedContainerReceipt | null = null;
const registeredDbs = new Set<string>();
const registeredUrls = new Set<string>();
const registeredScratchPaths = new Set<string>();
let cleanupHandlersRegistered = false;

export function maskDatabaseUrl(url: string): string {
  return url.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');
}

function sanitizeError(error: any): Error {
  const msg = error.stderr ? String(error.stderr) : error.message || String(error);
  return new Error(maskDatabaseUrl(msg.trim()));
}

function runExecFile(file: string, args: string[], options?: ExecFileSyncOptions): string | Buffer {
  const opts: ExecFileSyncOptions = {
    ...options,
    env: { ...process.env, ...options?.env },
  };
  return execFileSync(file, args, opts);
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // fallback spin
    }
  }
}

function registerProcessSignalHandlers(): void {
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;

  const handleSignal = (exitCode: number) => {
    try {
      cleanupOwnedResources();
    } catch {
      // Best-effort cleanup on termination
    }
    process.exit(exitCode);
  };

  process.once('SIGINT', () => handleSignal(130));
  process.once('SIGTERM', () => handleSignal(143));
  process.once('SIGHUP', () => handleSignal(129));
  process.once('exit', () => {
    try {
      cleanupOwnedResources();
    } catch {
      // ignore on clean exit
    }
  });
}

export function resetSessionStateForTesting(): void {
  try {
    cleanupOwnedResources();
  } catch {
    // ignore
  }
  sessionReceipt = null;
  registeredDbs.clear();
  registeredUrls.clear();
  registeredScratchPaths.clear();
}

export function startOwnedContainer(options?: {
  readinessTimeoutMs?: number;
  sessionToken?: string;
}): Readonly<OwnedContainerReceipt> {
  if (sessionReceipt) {
    return Object.freeze({ ...sessionReceipt });
  }

  if (options?.sessionToken !== undefined && !UUID_REGEX.test(options.sessionToken)) {
    throw new Error(`Invalid sessionToken format: must be strict UUID (got '${options.sessionToken}')`);
  }

  registerProcessSignalHandlers();

  const sessionToken = options?.sessionToken ?? randomUUID();
  const containerName = `geo-owned-${sessionToken.replace(/-/g, '').slice(0, 8)}`;
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'geo-scratch-'));
  const user = `geo_owner_${sessionToken.replace(/-/g, '').slice(0, 8)}`;
  const password = `geo_pass_${randomUUID().replace(/-/g, '')}`;

  let createdContainerId = '';
  try {
    const rawId = runExecFile(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        containerName,
        '--label',
        `geo-owner-token=${sessionToken}`,
        '--label',
        'harness=geolocation-migration',
        '-p',
        '127.0.0.1::5432',
        '-e',
        `POSTGRES_USER=${user}`,
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        'postgres:16-alpine',
      ],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as string;
    createdContainerId = rawId.trim();

    if (!HEX_64_REGEX.test(createdContainerId)) {
      throw new Error(`Invalid container ID format from docker run: expected 64 hex characters (got '${createdContainerId}')`);
    }

    const portOutput = (
      runExecFile('docker', ['port', createdContainerId, '5432/tcp'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as string
    ).trim();

    const portLine = portOutput.split('\n')[0];
    const portMatch = portLine.match(/:(\d+)$/);
    if (!portMatch) {
      throw new Error(`Failed to determine published port from docker port output: ${portOutput}`);
    }
    const port = parseInt(portMatch[1], 10);

    const receipt: OwnedContainerReceipt = Object.freeze({
      containerId: createdContainerId,
      sessionToken,
      host: '127.0.0.1',
      port,
      user,
      password,
      createdAt: Date.now(),
      scratchDir,
    });

    sessionReceipt = receipt;

    // Readiness polling for post-initialization final daemon
    const timeoutMs = options?.readinessTimeoutMs ?? 30000;
    const start = Date.now();
    let isReady = false;

    while (Date.now() - start < timeoutMs) {
      try {
        const logs = runExecFile('docker', ['logs', createdContainerId], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as string;

        if (logs.includes('PostgreSQL init process complete; ready for start up.')) {
          const psqlCheck = (
            runExecFile(
              'docker',
              ['exec', createdContainerId, 'psql', '-U', user, '-d', 'postgres', '-t', '-A', '-c', 'SELECT 1;'],
              { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
            ) as string
          ).trim();

          if (psqlCheck === '1') {
            isReady = true;
            break;
          }
        }
      } catch {
        // Still initializing
      }

      sleepSync(100);
    }

    if (!isReady) {
      throw new Error(`Readiness check failed: post-initialization daemon not ready within ${timeoutMs}ms`);
    }

    return Object.freeze({ ...receipt });
  } catch (error) {
    if (sessionReceipt) {
      try {
        cleanupOwnedResources();
      } catch {
        // ignore cascading cleanup error
      }
    } else if (createdContainerId && HEX_64_REGEX.test(createdContainerId)) {
      try {
        const inspectLabel = (
          runExecFile(
            'docker',
            ['inspect', createdContainerId, '--format', '{{ index .Config.Labels "geo-owner-token" }}'],
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ) as string
        ).trim();

        if (inspectLabel === sessionToken) {
          runExecFile('docker', ['rm', '-f', createdContainerId], { stdio: ['pipe', 'pipe', 'pipe'] });
        }
      } catch {
        // ignore
      }
    }
    if (existsSync(scratchDir)) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    throw sanitizeError(error);
  }
}

export function ensureOwnedContainer(): Readonly<OwnedContainerReceipt> {
  return sessionReceipt ? Object.freeze({ ...sessionReceipt }) : startOwnedContainer();
}

export function getOwnedContainerReceipt(): Readonly<OwnedContainerReceipt> | null {
  return sessionReceipt ? Object.freeze({ ...sessionReceipt }) : null;
}

export function createOwnedDatabase(dbName: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`Invalid database name '${dbName}': must match /^[a-zA-Z0-9_]+$/`);
  }

  const receipt = ensureOwnedContainer();

  try {
    // Creation must NEVER predelete anything. Direct CREATE DATABASE only.
    runExecFile(
      'docker',
      [
        'exec',
        receipt.containerId,
        'psql',
        '-U',
        receipt.user,
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `CREATE DATABASE "${dbName}";`,
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    registeredDbs.add(dbName);
    const dbUrl = `postgresql://${receipt.user}:${receipt.password}@${receipt.host}:${receipt.port}/${dbName}`;
    registeredUrls.add(dbUrl);
    return dbUrl;
  } catch (error: any) {
    throw sanitizeError(error);
  }
}

export function getOwnedDatabaseUrl(dbName: string): string {
  const receipt = ensureOwnedContainer();
  return `postgresql://${receipt.user}:${receipt.password}@${receipt.host}:${receipt.port}/${dbName}`;
}

export function validateOwnedDatabaseUrl(urlOrName: string): string {
  if (registeredUrls.has(urlOrName)) {
    return urlOrName;
  }

  if (registeredDbs.has(urlOrName)) {
    const dbUrl = getOwnedDatabaseUrl(urlOrName);
    if (registeredUrls.has(dbUrl)) {
      return dbUrl;
    }
  }

  throw new Error(`Refusing operation on unregistered / external database URL: ${maskDatabaseUrl(urlOrName)}`);
}

export function dropOwnedDatabase(dbName: string): void {
  if (!sessionReceipt || !registeredDbs.has(dbName)) {
    return;
  }

  try {
    runExecFile(
      'docker',
      [
        'exec',
        sessionReceipt.containerId,
        'psql',
        '-U',
        sessionReceipt.user,
        '-d',
        'postgres',
        '-c',
        `DROP DATABASE IF EXISTS "${dbName}";`,
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    registeredDbs.delete(dbName);
    const dbUrl = getOwnedDatabaseUrl(dbName);
    registeredUrls.delete(dbUrl);
  } catch {
    // Teardown of entire container is preferred; ignore per-DB drop failures
  }
}

export function cleanupOwnedResources(): void {
  const receipt = sessionReceipt;
  sessionReceipt = null;

  if (receipt && receipt.containerId) {
    try {
      const inspectLabel = (
        runExecFile(
          'docker',
          ['inspect', receipt.containerId, '--format', '{{ index .Config.Labels "geo-owner-token" }}'],
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ) as string
      ).trim();

      if (inspectLabel !== receipt.sessionToken) {
        throw new Error(
          `Refusing to delete unowned or foreign container ${receipt.containerId}: label '${inspectLabel}' != '${receipt.sessionToken}'`,
        );
      }

      runExecFile('docker', ['rm', '-f', receipt.containerId], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      if (err.message?.includes('Refusing to delete')) {
        throw err;
      }
    } finally {
      if (existsSync(receipt.scratchDir)) {
        try {
          rmSync(receipt.scratchDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  // Clean registered scratch files
  for (const filePath of registeredScratchPaths) {
    try {
      if (existsSync(filePath)) {
        const stat = lstatSync(filePath);
        if (!stat.isSymbolicLink()) {
          unlinkSync(filePath);
        }
      }
    } catch {
      // ignore
    }
  }

  registeredDbs.clear();
  registeredUrls.clear();
  registeredScratchPaths.clear();
}

export function stopOwnedContainer(): void {
  cleanupOwnedResources();
}

export function execPsqlCommand(dbName: string, sql: string): string {
  const receipt = ensureOwnedContainer();

  if (dbName !== 'postgres' && !registeredDbs.has(dbName)) {
    throw new Error(`Database ${dbName} is not registered in this owned session`);
  }

  try {
    const output = runExecFile(
      'docker',
      [
        'exec',
        '-i',
        receipt.containerId,
        'psql',
        '-U',
        receipt.user,
        '-d',
        dbName,
        '-t',
        '-A',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        sql,
      ],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as string;
    return output.trim();
  } catch (error: any) {
    throw sanitizeError(error);
  }
}

export function runPrismaMigrate(target: string, toTarget?: string): string {
  const dbUrl = validateOwnedDatabaseUrl(target);
  const args = ['prisma', 'db', 'migrate', '--db', dbUrl];
  if (toTarget) {
    args.push('--to', toTarget);
  }

  try {
    const output = runExecFile('pnpm', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
    return output.trim();
  } catch (error: any) {
    throw sanitizeError(error);
  }
}

export function runPrismaVerify(target: string): { success: boolean; output: string } {
  const dbUrl = validateOwnedDatabaseUrl(target);

  try {
    const output = runExecFile('pnpm', ['prisma', 'db', 'verify', '--db', dbUrl], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
    return { success: true, output: maskDatabaseUrl(output.trim()) };
  } catch (error: any) {
    const stdout = error.stdout ? String(error.stdout) : '';
    const stderr = error.stderr ? String(error.stderr) : error.message;
    return { success: false, output: maskDatabaseUrl(`${stdout}\n${stderr}`.trim()) };
  }
}

export function createScratchFile(prefix = 'geo-backup'): string {
  if (!SCRATCH_PREFIX_REGEX.test(prefix)) {
    throw new Error(`Invalid scratch prefix '${prefix}': must be alphanumeric, dash, or underscore only`);
  }

  const receipt = ensureOwnedContainer();
  const filename = `${prefix}-${randomUUID().slice(0, 8)}.sql`;
  const filePath = path.resolve(receipt.scratchDir, filename);

  if (!filePath.startsWith(receipt.scratchDir + path.sep)) {
    throw new Error(`Path traversal detected in createScratchFile: ${filePath}`);
  }

  writeFileSync(filePath, '', { mode: 0o600, flag: 'wx' });
  registeredScratchPaths.add(filePath);
  return filePath;
}

function validateScratchPath(filePath: string, operation: string): string {
  const receipt = ensureOwnedContainer();
  const resolved = path.resolve(filePath);

  if (!registeredScratchPaths.has(resolved) || !resolved.startsWith(receipt.scratchDir + path.sep)) {
    throw new Error(`Refusing ${operation} unregistered or uncontained scratch path: ${filePath}`);
  }

  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing ${operation} symlink or foreign path: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Refusing ${operation} non-regular file: ${filePath}`);
    }
  }

  return resolved;
}

export function backupOwnedDatabase(dbName: string, hostBackupPath: string): void {
  const receipt = ensureOwnedContainer();

  if (!registeredDbs.has(dbName)) {
    throw new Error(`Database ${dbName} is not registered in this owned session`);
  }

  const safePath = validateScratchPath(hostBackupPath, 'backup to');

  try {
    const dump = runExecFile(
      'docker',
      ['exec', receipt.containerId, 'pg_dump', '-U', receipt.user, '-d', dbName, '--clean', '--if-exists'],
      {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as string;

    writeFileSync(safePath, dump, { mode: 0o600 });
  } catch (error: any) {
    throw sanitizeError(error);
  }
}

export function restoreOwnedDatabase(dbName: string, hostBackupPath: string): void {
  const receipt = ensureOwnedContainer();

  if (!registeredDbs.has(dbName)) {
    throw new Error(`Database ${dbName} is not registered in this owned session`);
  }

  const safePath = validateScratchPath(hostBackupPath, 'restore from');

  if (!existsSync(safePath)) {
    throw new Error(`Restore source backup file does not exist: ${safePath}`);
  }

  try {
    const dumpData = readFileSync(safePath);

    runExecFile(
      'docker',
      ['exec', '-i', receipt.containerId, 'psql', '-U', receipt.user, '-d', dbName, '-v', 'ON_ERROR_STOP=1'],
      {
        input: dumpData,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error: any) {
    throw sanitizeError(error);
  }
}

export function cleanScratchFile(filePath: string): void {
  if (!sessionReceipt) {
    throw new Error('Refusing cleanup: no active owned session');
  }

  const resolved = path.resolve(filePath);

  if (!registeredScratchPaths.has(resolved) || !resolved.startsWith(sessionReceipt.scratchDir + path.sep)) {
    throw new Error(`Refusing cleanup of unregistered or uncontained path: ${filePath}`);
  }

  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing cleanup of symlink or uncontained path: ${filePath}`);
    }
    try {
      unlinkSync(resolved);
    } catch {
      // ignore
    }
  }

  registeredScratchPaths.delete(resolved);
}
