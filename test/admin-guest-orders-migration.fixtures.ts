import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const ADMIN_ORDERS_ORIGIN =
  '15ef5b17c1444e1f37222de1c696766119c6c4494633f6c5fcb256dee13cba83';

// No ambient connection, dotenv file, host scratch files, or persistent volume.
export class AdminOrdersDatabase {
  private readonly token = randomUUID();
  private readonly user = 'unit_a_owner';
  private readonly password = randomUUID();
  private containerId = '';
  private port = '';
  private readonly databases = new Set<string>();

  private exec(file: string, args: string[]): string {
    try {
      return execFileSync(file, args, {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          DATABASE_URL: '',
          DOTENV_CONFIG_PATH: '/dev/null',
          PRISMA_DISABLE_TELEMETRY: '1',
        },
      }).trim();
    } catch (error) {
      const failure = error as { stderr?: Buffer; message?: string };
      throw new Error(String(failure.stderr ?? failure.message)
        .replaceAll(this.password, '[owned-password]'));
    }
  }

  start(): void {
    if (process.env.DATABASE_URL) {
      throw new Error('Refusing inherited DATABASE_URL; unset it before running');
    }
    this.containerId = this.exec('docker', [
      'run', '-d', '--rm', '--pull=never',
      '--label', `admin-orders-owner=${this.token}`,
      '-p', '127.0.0.1::5432',
      '--tmpfs', '/var/lib/postgresql/data',
      '-e', `POSTGRES_USER=${this.user}`,
      '-e', `POSTGRES_PASSWORD=${this.password}`,
      'postgres:16-alpine',
    ]);
    if (!/^[a-f0-9]{64}$/.test(this.containerId)) {
      throw new Error('Invalid owned container ID');
    }
    const mounts = JSON.parse(this.exec('docker', [
      'inspect', this.containerId, '--format', '{{json .Mounts}}',
    ])) as Array<{ Type: string }>;
    const tmpfs = JSON.parse(this.exec('docker', [
      'inspect', this.containerId, '--format', '{{json .HostConfig.Tmpfs}}',
    ])) as Record<string, string>;
    if (mounts.some((mount) => mount.Type === 'volume') ||
        !Object.hasOwn(tmpfs, '/var/lib/postgresql/data')) {
      throw new Error('Owned PostgreSQL must use tmpfs without persistent volumes');
    }
    this.port = this.exec('docker', ['port', this.containerId, '5432/tcp'])
      .match(/^127\.0\.0\.1:(\d+)$/)?.[1] ?? '';
    if (!this.port) throw new Error('Container must publish only on loopback');
    for (let attempt = 0; attempt < 300; attempt++) {
      const logs = this.exec('docker', ['logs', this.containerId]);
      if (logs.includes('PostgreSQL init process complete; ready for start up.')) {
        try {
          if (this.sql('postgres', 'SELECT 1') === '1') return;
        } catch { /* Final daemon may still be starting. */ }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    throw new Error('Owned PostgreSQL readiness timed out');
  }

  create(name: string): void {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Invalid database name');
    this.sql('postgres', `CREATE DATABASE "${name}"`);
    this.databases.add(name);
  }

  sql(name: string, sql: string): string {
    if (name !== 'postgres' && !this.databases.has(name)) {
      throw new Error('Refusing unregistered database');
    }
    return this.exec('docker', [
      'exec', this.containerId, 'psql', '-U', this.user, '-d', name,
      '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql,
    ]);
  }

  ownedUrl(name: string): string {
    if (!this.containerId || !this.port || !this.databases.has(name)) {
      throw new Error('Refusing external or inactive database');
    }
    return `postgresql://${this.user}:${this.password}@127.0.0.1:${this.port}/${name}`;
  }

  prisma(name: string, command: 'migrate' | 'verify', to?: string): string {
    const url = this.ownedUrl(name);
    return this.exec('pnpm', [
      'prisma', 'db', command, '--db', url, ...(to ? ['--to', to] : []),
    ]);
  }

  stop(): void {
    if (!this.containerId) return;
    const owner = this.exec('docker', [
      'inspect', this.containerId, '--format',
      '{{ index .Config.Labels "admin-orders-owner" }}',
    ]);
    if (owner !== this.token) throw new Error('Refusing foreign container teardown');
    this.exec('docker', ['stop', this.containerId]);
    // Docker --rm removal may finish shortly after stop returns.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        this.exec('docker', ['inspect', this.containerId]);
      } catch (error) {
        if (/No such (object|container)/i.test(String(error))) {
          this.containerId = '';
          return;
        }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    throw new Error('Owned container survived teardown');
  }
}
