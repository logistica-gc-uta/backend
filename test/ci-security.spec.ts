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
    expect(workflowContent).toMatch(/bash\s+-n/);
    expect(workflowContent).toMatch(/shellcheck/);
  });

  it('executes E2E PostgreSQL test suite with --runInBand before Newman', () => {
    expect(workflowContent).toMatch(/test:e2e.*--runInBand/);

    const e2eIndex = workflowContent.indexOf('test:e2e');
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

  it('uses the same run-attempt-unique loopback database for PostgreSQL health and E2E', () => {
    const database = 'issue6_ci_${{ github.run_id }}_${{ github.run_attempt }}';
    const apiJob = workflowContent.slice(
      workflowContent.indexOf('  api-tests:'),
    );
    const databaseName = apiJob.match(/^\s+POSTGRES_DB:\s*(.+)$/m)?.[1];
    const healthDatabase = apiJob.match(
      /--health-cmd "pg_isready -U logistica_user -d ([^"]+)"/,
    )?.[1];
    const databaseUrl = apiJob.match(/^\s+DATABASE_URL:\s*(.+)$/m)?.[1];

    expect(databaseName).toBe(database);
    expect(healthDatabase).toBe(databaseName);
    expect(databaseUrl).toBe(
      `postgresql://logistica_user:logistica_password123@127.0.0.1:5432/${database}?schema=public`,
    );
    expect(apiJob).toContain('JWT_SECRET: ci_only_jwt_secret');
    expect(apiJob).not.toContain('secrets.');
  });

  it('unsets DATABASE_URL when invoking isolated Newman runner to prevent external DB collision', () => {
    expect(workflowContent).toMatch(
      /env\s+-u\s+DATABASE_URL\s+pnpm\s+run\s+test:api:report/,
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
