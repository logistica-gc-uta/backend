import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const historicalTarget = 'eb8ebd14b89f17eea5458cd12220be7bd572fa8f0e3771b68d2089c880e18f83';
const target = 'b263aff9f248d0da2ead5a0700a5b035ab3653ec79e1f8c651ab5f936e21e1ea';
const legacyNames = ['app.e2e-spec.ts', 'orders-security.e2e-spec.ts', 'drivers-routes-security.e2e-spec.ts'];
let activeChild;
let interrupted = false;
let cleaning = false;

async function execute(cmd, args, { env, capture = false, interruptible = false }) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { env, detached: interruptible, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    activeChild = interruptible ? child : undefined;
    let output = '';
    // Never print captured CLI errors: they may contain connection credentials.
    if (capture) { child.stdout.on('data', data => { output += data; }); child.stderr.resume(); }
    child.on('error', rej);
    child.on('close', code => {
      activeChild = undefined;
      if (code !== 0) rej(new Error(`${cmd} failed (exit ${code})`));
      else res(output.trim());
    });
  });
}

export async function runIsolated({ env = process.env, command = execute, log = console.log, isInterrupted = () => interrupted } = {}) {
  const guard = () => { if (isInterrupted()) throw new Error('Interrupted'); };
  guard();
  if (Object.hasOwn(env, 'DATABASE_URL')) throw new Error('Refusing ambient DATABASE_URL');
  const clean = { ...env, DOTENV_CONFIG_PATH: '/dev/null' };
  delete clean.DATABASE_URL;
  delete clean.JWT_SECRET;
  const jest = ['run', 'test:e2e', '--runInBand'];
  const manifest = JSON.parse(await command('pnpm', [...jest, '--listTests', '--json'], { env: clean, capture: true }));
  if (!Array.isArray(manifest) || new Set(manifest).size !== manifest.length || manifest.length < 3) throw new Error('Invalid or duplicate Jest manifest');
  const legacy = legacyNames.map(name => {
    const matches = manifest.filter(file => basename(file) === name);
    if (matches.length !== 1) throw new Error(`Missing or duplicate legacy suite: ${name}`);
    return matches[0];
  });
  const managed = manifest.filter(file => !legacy.includes(file));
  log(`E2E manifest: ${manifest.length} suites (${managed.length} self-managed, ${legacy.length} legacy)`);
  for (const file of manifest) log(`  ${basename(file)}`);
  await command('pnpm', [...jest, '--runTestsByPath', ...managed], { env: clean });
  // Self-managed suites finish their own finally hooks before honoring cancellation.
  guard();
  const nonce = randomUUID();
  let container;
  const owned = new Map();
  let failure;
  try {
    container = await command('docker', ['run', '-d', '--rm', '--pull=never', '--name', `issue11-e2e-${nonce}`, '--label', `delivery.issue11.owner=${nonce}`, '--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=isolated_test', '-e', 'POSTGRES_PASSWORD=ephemeral_only', '-e', 'POSTGRES_DB=postgres', 'postgres:16-alpine'], { env: clean, capture: true });
    const mapping = await command('docker', ['port', container, '5432/tcp'], { env: clean, capture: true });
    const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
    if (!port) throw new Error('Invalid loopback PostgreSQL port');
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      guard();
      try { await command('docker', ['exec', container, 'pg_isready', '-U', 'isolated_test'], { env: clean, capture: true }); ready = true; break; }
      catch { guard(); await new Promise(res => setTimeout(res, 500)); }
    }
    if (!ready) throw new Error('PostgreSQL readiness timeout');
    for (const [index, file] of legacy.entries()) {
      guard();
      const db = `issue6_${nonce.replaceAll('-', '')}_${index}`;
      await command('docker', ['exec', container, 'createdb', '-U', 'isolated_test', db], { env: clean, capture: true });
      const url = `postgresql://isolated_test:ephemeral_only@127.0.0.1:${port}/${db}?sslmode=disable`;
      owned.set(db, url); // Register only databases created in this owned container, before CLI use.
      const childEnv = { ...clean, DATABASE_URL: owned.get(db), JWT_SECRET: randomUUID() };
      await command('pnpm', ['prisma', 'db', 'migrate', '--db', owned.get(db), '--to', historicalTarget], { env: childEnv, capture: true });
      await command('pnpm', ['prisma', 'db', 'migrate', '--db', owned.get(db), '--to', target], { env: childEnv, capture: true });
      await command('pnpm', ['prisma', 'db', 'verify', '--db', owned.get(db)], { env: childEnv, capture: true });
      log(`Verified owned ${db} at ${target}`);
      guard();
      await command('pnpm', [...jest, '--runTestsByPath', file], { env: childEnv, interruptible: true });
    }
  } catch (error) {
    failure = error;
  }
  cleaning = true;
  try {
    if (container) {
      const label = await command('docker', ['inspect', '-f', '{{ index .Config.Labels "delivery.issue11.owner" }}', container], { env: clean, capture: true });
      if (label !== nonce) throw new Error('Refusing cleanup without exact container ownership');
      await command('docker', ['stop', container], { env: clean, capture: true });
      let remaining;
      for (let attempt = 0; attempt < 20; attempt++) {
        remaining = await command('docker', ['ps', '-aq', '--filter', `label=delivery.issue11.owner=${nonce}`], { env: clean, capture: true });
        if (!remaining) break;
        await new Promise(res => setTimeout(res, 250));
      }
      if (remaining) throw new Error('Owned container cleanup not confirmed');
      log('Owned PostgreSQL cleanup confirmed');
    }
  } catch (cleanupError) {
    if (failure) failure = new Error(`${failure.message}; cleanup failed: ${cleanupError.message}`, { cause: failure });
    else failure = cleanupError;
  } finally {
    cleaning = false;
  }
  if (failure) throw failure;
  guard();
  log(`Complete E2E manifest executed: ${manifest.length} suites`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  if (process.argv.length > 2) throw new Error('The isolated runner accepts no arguments');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    interrupted = true;
    if (activeChild && !cleaning) {
      try { process.kill(-activeChild.pid, signal); } catch { /* already exited */ }
    }
  });
  try { await runIsolated(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
