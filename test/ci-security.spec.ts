import * as fs from 'node:fs';
import * as path from 'node:path';

describe('CI Workflow Configuration & Security Contract', () => {
  const workflowPath = path.resolve(process.cwd(), '.github/workflows/ci.yml');
  let workflowContent: string;

  beforeAll(() => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    workflowContent = fs.readFileSync(workflowPath, 'utf8');
  });

  it('workflow file exists and defines required concurrency and node version', () => {
    expect(workflowContent).toContain('cancel-in-progress: true');
    expect(workflowContent).toMatch(/NODE_VERSION:\s*['"]?26['"]?/);
  });

  it('quality job retains oxlint, build, coverage threshold >= 80% and coverage artifact upload', () => {
    expect(workflowContent).toContain('pnpm run lint');
    expect(workflowContent).toContain('pnpm run build');
    expect(workflowContent).toContain('pnpm run test:cov');
    expect(workflowContent).toContain(
      '--coverageThreshold=\'{"global":{"statements":80,"branches":80,"functions":80,"lines":80}}\'',
    );
    expect(workflowContent).toContain('actions/upload-artifact@v4');
    expect(workflowContent).toContain('path: coverage/');
  });

  it('includes shell syntax (bash -n) and shellcheck validation in CI', () => {
    expect(workflowContent).toContain(
      'bash -n test/run-newman-isolated.sh test/run-e2e-isolated.sh',
    );
    expect(workflowContent).toContain(
      'shellcheck test/run-newman-isolated.sh test/run-e2e-isolated.sh',
    );
  });

  it('executes the complete isolated E2E manifest before build and Newman', () => {
    expect(workflowContent).toContain(
      'run: env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e:isolated',
    );
    expect(workflowContent).not.toMatch(/pnpm run test:e2e(?:\s|$)/m);

    const e2eIndex = workflowContent.indexOf('test:e2e:isolated');
    const buildIndex = workflowContent.indexOf(
      'Compilar backend para pruebas de API',
    );
    const newmanIndex = workflowContent.indexOf('test:api:report');
    expect(e2eIndex).toBeGreaterThan(0);
    expect(newmanIndex).toBeGreaterThan(0);
    expect(e2eIndex).toBeLessThan(newmanIndex);
    expect(buildIndex).toBeGreaterThan(e2eIndex);
    expect(buildIndex).toBeLessThan(newmanIndex);
    expect(workflowContent.slice(buildIndex, newmanIndex)).toContain(
      'pnpm run build',
    );
  });

  it('delegates all 18 suites to owned runners without a shared CI database or JWT', () => {
    expect(workflowContent).not.toMatch(/^\s*(services|DATABASE_URL|JWT_SECRET|POSTGRES_DB):/m);
    expect(workflowContent).not.toContain('secrets.');
    expect(workflowContent).toContain('run: docker pull postgres:16-alpine');
    const packageJson: { scripts: Record<string, string> } = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    expect(packageJson.scripts['test:e2e:isolated']).toBe('bash test/run-e2e-isolated.sh');
    expect(packageJson.scripts['test:api:report']).toBe('./test/run-newman-isolated.sh --report');
    const shell = fs.readFileSync(path.resolve(process.cwd(), 'test/run-e2e-isolated.sh'), 'utf8');
    expect(shell).toContain('exec node test/run-e2e-isolated.mjs "$@"');
    const runner = fs.readFileSync(path.resolve(process.cwd(), 'test/run-e2e-isolated.mjs'), 'utf8');
    expect(fs.readdirSync(path.resolve(process.cwd(), 'test')).filter(
      (file) => file.endsWith('.e2e-spec.ts'),
    )).toHaveLength(18);
    expect(runner).toContain("const jest = ['run', 'test:e2e', '--runInBand'];");
    expect(runner).toContain("[...jest, '--listTests', '--json']");
    expect(runner).toContain("[...jest, '--runTestsByPath', ...managed], { env: clean }");
    expect(runner).toContain("delete clean.DATABASE_URL;");
    expect(runner).toContain("delete clean.JWT_SECRET;");
    expect(runner).toContain("DOTENV_CONFIG_PATH: '/dev/null'");
    expect(runner).toContain("throw new Error('Refusing ambient DATABASE_URL')");
    expect(runner).toContain("const legacyNames = ['app.e2e-spec.ts', 'orders-security.e2e-spec.ts', 'drivers-routes-security.e2e-spec.ts'];");
    expect(runner).toContain("'--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432'");
    expect(runner).toContain('`delivery.issue11.owner=${nonce}`');
    expect(runner).toContain("owned.set(db, url)");
    expect(runner).toContain('DATABASE_URL: owned.get(db), JWT_SECRET: randomUUID()');
    expect(runner).toContain("['prisma', 'db', 'migrate', '--db', owned.get(db), '--to', target]");
    expect(runner).toContain("['prisma', 'db', 'verify', '--db', owned.get(db)]");
    expect(runner).toContain("[...jest, '--runTestsByPath', file], { env: childEnv, interruptible: true }");
  });

  it('unsets DATABASE_URL when invoking isolated Newman runner to prevent external DB collision', () => {
    expect(workflowContent).toMatch(
      /^\s*run: env -u DATABASE_URL DOTENV_CONFIG_PATH=\/dev\/null pnpm run test:api:report\s*$/m,
    );
  });

  it('removes redundant persistent background server start and shared seed', () => {
    expect(workflowContent).not.toMatch(/nohup\s+pnpm\s+run\s+start:prod/);
    expect(workflowContent).not.toMatch(/curl\s+-sf.*\/api\/v1\/zones/);
    expect(workflowContent).not.toMatch(/pnpm\s+run\s+seed/);
  });

  it('never uses continue-on-error on verification or test steps', () => {
    expect(workflowContent).not.toMatch(/continue-on-error:\s*true/i);
  });

  it('retains Newman HTML report artifact upload', () => {
    expect(workflowContent).toContain('name: informe-newman');
    expect(workflowContent).toContain('path: reports/newman/');
  });
});
