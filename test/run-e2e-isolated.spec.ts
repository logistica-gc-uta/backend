import { spawnSync } from 'node:child_process';

// Exercise the real orchestration with an in-memory command adapter, never Docker.
function scenario(mode: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runIsolated } from './test/run-e2e-isolated.mjs';
    const calls = [];
    let owner;
    const env = ${JSON.stringify(mode === 'ambient' ? { DATABASE_URL: 'forbidden' } : { JWT_SECRET: 'inherited' })};
    const legacy = ['app', 'orders-security', 'drivers-routes-security'].map(n => process.cwd()+'/test/'+n+'.e2e-spec.ts');
    const tests = [...legacy, process.cwd()+'/test/admin-guest-orders-api.e2e-spec.ts'];
    if (${JSON.stringify(mode)} === 'duplicate') tests.push(tests[0]);
    let cancelled = false;
    let cleanupPolls = 0;
    const command = async (cmd, args, options) => {
      calls.push({cmd, args, env: options.env});
      if (args.includes('--listTests')) return JSON.stringify(tests);
      if (cmd === 'docker' && args[0] === 'run') { owner = args[args.indexOf('--label')+1].split('=')[1]; return 'owned-id'; }
      if (cmd === 'docker' && args[0] === 'port') return '127.0.0.1:54999';
      if (cmd === 'docker' && args[0] === 'inspect') return ['foreign', 'double-failure'].includes(${JSON.stringify(mode)}) ? 'foreign' : owner;
      if (cmd === 'docker' && args.includes('pg_isready') && ${JSON.stringify(mode)} === 'interrupt') { cancelled = true; throw new Error('not ready'); }
      if (args.includes('--runTestsByPath') && options.env.DATABASE_URL && ['legacy-fail', 'double-failure'].includes(${JSON.stringify(mode)})) throw new Error('legacy child failed');
      if (cmd === 'docker' && args[0] === 'ps' && ${JSON.stringify(mode)} === 'delayed-cleanup') return cleanupPolls++ === 0 ? 'owned-id' : '';
      if (${JSON.stringify(mode)} === 'fail' && args.includes('--runTestsByPath')) throw new Error('child failed');
      return '';
    };
    let error;
    try { await runIsolated({env, command, log: () => {}, isInterrupted: () => cancelled}); } catch (e) { error = e.message; }
    console.log(JSON.stringify({calls, error}));
  `], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { calls: {cmd: string; args: string[]; env: Record<string,string>}[]; error?: string };
}

describe('complete isolated E2E routing and ownership', () => {
  it('rejects ambient URL before any command', () => {
    const result = scenario('ambient');
    expect(result.error).toMatch(/DATABASE_URL/);
    expect(result.calls).toHaveLength(0);
  });
  it('routes every manifest entry once in separate managed and legacy children', () => {
    const result = scenario('ok');
    expect(result.error).toBeUndefined();
    const children = result.calls.filter(c => c.args.includes('--runTestsByPath'));
    expect(children).toHaveLength(4);
    expect(children[0].env.DATABASE_URL).toBeUndefined();
    expect(children[0].env.JWT_SECRET).toBeUndefined();
    const urls = children.slice(1).map(c => c.env.DATABASE_URL);
    expect(new Set(urls).size).toBe(3);
    for (const child of children.slice(1)) {
      expect(child.env.DATABASE_URL).toMatch(/127\.0\.0\.1:54999\/issue6_/);
      expect(child.env.JWT_SECRET).not.toBe('inherited');
      expect(child.env.DOTENV_CONFIG_PATH).toBe('/dev/null');
    }
    const run = result.calls.find(c => c.cmd === 'docker' && c.args[0] === 'run')!;
    expect(run.args).toContain('--tmpfs');
    expect(run.args).toContain('127.0.0.1::5432');
    expect(run.args).toContain('postgres:16-alpine');
    const migrations = result.calls.filter(c => c.args.includes('migrate'));
    expect(migrations).toHaveLength(3);
    for (const migration of migrations) expect(migration.args[migration.args.indexOf('--to') + 1]).toBe('eb8ebd14b89f17eea5458cd12220be7bd572fa8f0e3771b68d2089c880e18f83');
    expect(result.calls.filter(c => c.args.includes('verify'))).toHaveLength(3);
    expect(result.calls.some(c => c.cmd === 'docker' && c.args[0] === 'stop')).toBe(true);
  });
  it('preserves child failure and still cleans owned resources', () => {
    const result = scenario('fail');
    expect(result.error).toMatch(/child failed/);
    // The managed child fails before any legacy container is created.
    expect(result.calls.some(c => c.cmd === 'docker')).toBe(false);
  });
  it('waits for Docker auto-removal after stop before confirming cleanup', () => {
    const result = scenario('delayed-cleanup');
    expect(result.error).toBeUndefined();
    expect(result.calls.filter(c => c.cmd === 'docker' && c.args[0] === 'ps')).toHaveLength(2);
  });
  it('does not overwrite the primary test failure with cleanup failure', () => {
    const result = scenario('double-failure');
    expect(result.error).toMatch(/^legacy child failed/);
    expect(result.error).toMatch(/ownership/);
  });
  it('cleans owned container after a legacy child fails', () => {
    const result = scenario('legacy-fail');
    expect(result.error).toBe('legacy child failed');
    expect(result.calls.some(c => c.cmd === 'docker' && c.args[0] === 'stop')).toBe(true);
  });
  it('stops readiness polling after interruption and still performs owned cleanup', () => {
    const result = scenario('interrupt');
    expect(result.error).toMatch(/Interrupted/);
    expect(result.calls.filter(c => c.args.includes('pg_isready'))).toHaveLength(1);
    expect(result.calls.some(c => c.cmd === 'docker' && c.args[0] === 'stop')).toBe(true);
    expect(result.calls.some(c => c.args.includes('createdb'))).toBe(false);
  });
  it('rejects duplicate manifest entries before running tests or Docker', () => {
    const result = scenario('duplicate');
    expect(result.error).toMatch(/duplicate/);
    expect(result.calls).toHaveLength(1);
  });
  it('refuses stopping a container with a foreign owner label', () => {
    const result = scenario('foreign');
    expect(result.error).toMatch(/ownership/);
    expect(result.calls.some(c => c.cmd === 'docker' && c.args[0] === 'stop')).toBe(false);
  });
});
