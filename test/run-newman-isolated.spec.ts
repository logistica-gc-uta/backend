import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Isolated Newman Runner Safety & Isolation Contract', () => {
  const runnerScriptPath = path.resolve(
    process.cwd(),
    'test/run-newman-isolated.sh',
  );
  let tempDir: string;
  let fakeBinDir: string;
  let logFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newman-runner-spec-'));
    fakeBinDir = path.join(tempDir, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    logFile = path.join(tempDir, 'calls.log');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createFakeExecutable(name: string, scriptContent: string) {
    const filePath = path.join(fakeBinDir, name);
    fs.writeFileSync(filePath, `#!/usr/bin/env bash\n${scriptContent}\n`, {
      mode: 0o755,
    });
    return filePath;
  }

  function setupStandardFakeBinaries(options?: {
    newmanExitCode?: number;
    backendHang?: boolean;
    wrongOwner?: boolean;
    ownerInspectFailure?: boolean;
    unknownId?: boolean;
    removalFailure?: boolean;
    removedDespiteFailure?: boolean;
    postRemovalError?: string;
    postRemovalStdout?: string;
    postRemovalStatus?: number;
    initializationExitCode?: number;
    remainsAfterRemoval?: boolean;
  }) {
    const newmanCode = options?.newmanExitCode ?? 0;

    createFakeExecutable(
      'docker',
      `
echo "docker $@" >> "${logFile}"
if [ "$1" = "run" ]; then
  for arg in "$@"; do
    if [[ "$arg" == delivery.issue6.owner=* ]]; then
      printf '%s' "\${arg#*=}" > "${tempDir}/owner"
    fi
  done
  touch "${tempDir}/container"
  echo "mock-pg-container-id-777"
  exit 0
elif [ "$1" = "inspect" ]; then
  ${options?.unknownId ? 'exit 1' : ':'}
  ${options?.wrongOwner ? 'echo "foreign-owner"; exit 0' : ':'}
  if [ ! -f "${tempDir}/container" ]; then
    printf '%s' '${options?.postRemovalStdout ?? ''}'
    echo "inspect-locale=$LC_ALL" >> "${logFile}"
    echo '${options?.postRemovalError ?? 'Error: No such object: mock-pg-container-id-777'}' >&2
    exit ${options?.postRemovalStatus ?? 1}
  fi
  if [ "$2" = "-f" ]; then
    cat "${tempDir}/owner"
    exit ${options?.ownerInspectFailure ? 1 : 0}
  fi
  exit 0
elif [ "$1" = "rm" ]; then
  ${(options?.removalFailure && !options?.removedDespiteFailure) || options?.remainsAfterRemoval ? ':' : `rm -f "${tempDir}/container"`}
  exit ${options?.removalFailure ? 1 : 0}
elif [ "$1" = "port" ]; then
  echo "127.0.0.1:54999"
  exit 0
elif [ "$1" = "logs" ]; then
  echo "PostgreSQL init process complete; ready for start up."
  exit 0
elif [ "$1" = "exec" ]; then
  exit 0
elif [ "$1" = "rm" ]; then
  exit 0
fi
exit 0
`,
    );

    createFakeExecutable(
      'pnpm',
      `
echo "pnpm $@" >> "${logFile}"
if [ "$1" = "prisma" ] && [ "$3" = "migrate" ]; then
  exit ${options?.initializationExitCode ?? 0}
fi
if [ "$1" = "exec" ]; then
  shift
  exec "$@"
fi
exit 0
`,
    );

    createFakeExecutable(
      'curl',
      `
echo "curl $@" >> "${logFile}"
exit 0
`,
    );

    createFakeExecutable(
      'node',
      `
if [ "$1" = "-e" ]; then
  echo "48999"
  exit 0
fi
if [[ "$*" == *"dist/main.js"* ]]; then
  echo "backend-started" >> "${logFile}"
  trap 'echo "backend-killed" >> "${logFile}"; exit 0' TERM INT HUP
  while true; do
    sleep 0.1
  done
fi
exit 0
`,
    );

    createFakeExecutable(
      'newman',
      `
echo "newman $@" >> "${logFile}"
exit ${newmanCode}
`,
    );
  }

  function readCallLog(): string[] {
    if (!fs.existsSync(logFile)) return [];
    return fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
  }

  it('script exists and is executable bash file with strict flags and signal traps', () => {
    expect(fs.existsSync(runnerScriptPath)).toBe(true);
    const content = fs.readFileSync(runnerScriptPath, 'utf8');
    expect(content).toMatch(/^#!\/usr\/bin\/env bash|^#!\/bin\/bash/);
    expect(content).toContain('set -euo pipefail');
    expect(content).toContain('trap');
    expect(content).toMatch(/trap\s+cleanup\s+EXIT/);
    expect(content).toMatch(/trap\s+['"]handle_signal\s+130['"]\s+INT/);
    expect(content).toMatch(/trap\s+['"]handle_signal\s+143['"]\s+TERM/);
    expect(content).toMatch(/trap\s+['"]handle_signal\s+129['"]\s+HUP/);
    expect(content).toMatch(/-r\s+['"]cli,htmlextra['"]/);
    // Must NOT contain testing bypass flags
    expect(content).not.toContain('RUNNER_TEST_MODE');
    expect(content).not.toContain('ALLOW_UNSAFE_EXTERNAL_DB');
  });

  it('rejects forbidden arguments before starting docker or network', () => {
    setupStandardFakeBinaries();

    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    };

    const dangerousArgs = [
      ['--env-var', 'baseUrl=http://attacker.com'],
      ['-e', 'custom_env.json'],
      ['--environment', 'prod.json'],
      ['custom_collection.json'],
      ['--unknown-flag'],
    ];

    for (const args of dangerousArgs) {
      const res = spawnSync('bash', [runnerScriptPath, ...args], {
        env,
        encoding: 'utf8',
        timeout: 10000,
      });

      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toMatch(
        /forbidden|error|invalid|unknown|report/i,
      );

      // Must NOT have invoked docker
      const calls = readCallLog();
      const dockerCalls = calls.filter((c) => c.startsWith('docker'));
      expect(dockerCalls.length).toBe(0);
    }
  });

  it('refuses external DATABASE_URL unconditionally without bypass', () => {
    setupStandardFakeBinaries();

    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      DATABASE_URL:
        'postgresql://admin:secret@shared-dev-host:5432/delivery_dev',
    };

    const res = spawnSync('bash', [runnerScriptPath], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/refus|external|database_url/i);

    // Docker must NOT have been called
    const calls = readCallLog();
    expect(calls.filter((c) => c.startsWith('docker run')).length).toBe(0);
  });

  it('runs full lifecycle and terminates dedicated backend PID and container on exit', () => {
    setupStandardFakeBinaries();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    };
    // Ensure DATABASE_URL is not set
    delete env.DATABASE_URL;

    const res = spawnSync('bash', [runnerScriptPath], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).toBe(0);

    const calls = readCallLog();
    expect(
      calls.some(
        (c) =>
          c.startsWith('docker run') &&
          c.includes('--rm') &&
          c.includes('--pull=never') &&
          c.includes('--label delivery.issue6.owner='),
      ),
    ).toBe(true);
    expect(calls.filter((c) => c.startsWith('docker inspect')).length).toBe(2);
    expect(calls.some((c) => c.includes('backend-started'))).toBe(true);
    expect(calls.some((c) => c.includes('backend-killed'))).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.includes('docker rm') && c.includes('mock-pg-container-id-777'),
      ),
    ).toBe(true);
  });

  it('passes single quoted reporter comma argument -r cli,htmlextra when --report flag is provided', () => {
    setupStandardFakeBinaries();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    };
    delete env.DATABASE_URL;

    const res = spawnSync('bash', [runnerScriptPath, '--report'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).toBe(0);

    const calls = readCallLog();
    const newmanCall = calls.find((c) => c.startsWith('newman'));
    expect(newmanCall).toBeDefined();
    expect(newmanCall).toContain('-r cli,htmlextra');
    expect(newmanCall).toContain(
      '--reporter-htmlextra-export reports/newman/informe-api.html',
    );
  });

  it('preserves failure exit code 42 from Newman and cleans up backend PID and container', () => {
    setupStandardFakeBinaries({ newmanExitCode: 42 });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    };
    delete env.DATABASE_URL;

    const res = spawnSync('bash', [runnerScriptPath], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).toBe(42);

    const calls = readCallLog();
    expect(calls.some((c) => c.includes('backend-started'))).toBe(true);
    expect(calls.some((c) => c.includes('backend-killed'))).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.includes('docker rm') && c.includes('mock-pg-container-id-777'),
      ),
    ).toBe(true);
  });

  it.each([
    { removalFailure: true },
    { removalFailure: true, removedDespiteFailure: true },
    { postRemovalError: 'Cannot connect to the Docker daemon' },
    { postRemovalError: 'permission denied while trying to connect to Docker' },
    { postRemovalError: 'Error: No such object: another-container' },
    { postRemovalError: '' },
    { postRemovalStatus: 2 },
    { remainsAfterRemoval: true },
  ])('fails closed when cleanup cannot be proven: %p', (options) => {
    setupStandardFakeBinaries(options);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };
    delete env.DATABASE_URL;
    const result = spawnSync('bash', [runnerScriptPath], {
      env, encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cleanup|removal/i);
    const dockerCalls = readCallLog().filter((call) => call.startsWith('docker '));
    expect(dockerCalls.filter((call) => call.startsWith('docker rm '))).toEqual([
      'docker rm -f mock-pg-container-id-777',
    ]);
    expect(dockerCalls.filter((call) => call.startsWith('docker inspect ')))
      .toEqual([
        'docker inspect -f {{ index .Config.Labels "delivery.issue6.owner" }} mock-pg-container-id-777',
        'docker inspect -f {{.Id}} mock-pg-container-id-777',
      ]);
    expect(dockerCalls.every((call) => !/docker (ps|system|container)/.test(call))).toBe(true);
  });

  it.each([
    { removalFailure: true },
    { postRemovalError: 'Cannot connect to the Docker daemon' },
    { wrongOwner: true },
  ])('preserves the primary Newman failure when cleanup also fails: %p', (options) => {
    setupStandardFakeBinaries({ ...options, newmanExitCode: 42 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };
    delete env.DATABASE_URL;
    const result = spawnSync('bash', [runnerScriptPath], {
      env, encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).toBe(42);
    expect(result.stderr).toMatch(/cleanup|removal/i);
  });

  it('accepts the exact Docker 29.9 absence protocol (stdout LF, lowercase stderr, status 1)', () => {
    setupStandardFakeBinaries({
      postRemovalStdout: '\n',
      postRemovalError: 'error: no such object: mock-pg-container-id-777',
      postRemovalStatus: 1,
    });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };
    delete env.DATABASE_URL;
    const result = spawnSync('bash', [runnerScriptPath], { env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0);
    expect(readCallLog()).toContain('inspect-locale=C');
    expect(result.stdout).toContain('container=mock-pg-container-id-777 owner=48999');
    expect(result.stderr).not.toContain('cleanup was not confirmed');
  });

  it('accepts the exact GitHub Actions Docker absence protocol (stdout LF, capitalized stderr, status 1)', () => {
    setupStandardFakeBinaries({
      postRemovalStdout: '\n',
      postRemovalError: 'Error: No such object: mock-pg-container-id-777',
      postRemovalStatus: 1,
    });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };
    delete env.DATABASE_URL;
    const result = spawnSync('bash', [runnerScriptPath], { env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0);
    expect(readCallLog()).toContain('inspect-locale=C');
    expect(result.stdout).toContain('container=mock-pg-container-id-777 owner=48999');
    expect(result.stderr).not.toContain('cleanup was not confirmed');
  });

  it.each([
    { postRemovalError: 'error: no such object: another-container', postRemovalStdout: '\n' },
    { postRemovalError: 'error: no such object: mock-pg-container-id-777', postRemovalStatus: 0 },
    { postRemovalError: 'ERROR: NO SUCH OBJECT: mock-pg-container-id-777' },
    { postRemovalError: 'error: no such object: mock-pg-container-id-777 extra' },
    { postRemovalError: 'error: no such object: mock-pg-container-id-777', postRemovalStdout: 'unexpected' },
    { postRemovalError: 'Error: No such object: another-container', postRemovalStdout: '\n' },
    { postRemovalError: 'Error: No such object: mock-pg-container-id-777', postRemovalStdout: '\n', postRemovalStatus: 0 },
    { postRemovalError: 'Error: No such object: mock-pg-container-id-777 extra', postRemovalStdout: '\n' },
  ])('rejects non-exact Docker absence variants: %p', (options) => {
    setupStandardFakeBinaries(options);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };
    delete env.DATABASE_URL;
    const result = spawnSync('bash', [runnerScriptPath], { env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cleanup was not confirmed');
  });

  it('preserves a schema initialization failure when removal also fails', () => {
    setupStandardFakeBinaries({ initializationExitCode: 7, removalFailure: true });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };
    delete env.DATABASE_URL;
    const result = spawnSync('bash', [runnerScriptPath], {
      env, encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('Owned container removal failed');
    expect(readCallLog().some((call) => call.startsWith('newman '))).toBe(false);
  });

  it.each([{ wrongOwner: true }, { unknownId: true }, { ownerInspectFailure: true }])(
    'refuses container removal when ownership cannot be verified: %p',
    (options) => {
      setupStandardFakeBinaries(options);
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };
      delete env.DATABASE_URL;
      const result = spawnSync('bash', [runnerScriptPath], {
        env,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Refusing cleanup without exact container ownership',
      );
      expect(readCallLog().some((c) => c.startsWith('docker rm'))).toBe(false);
      expect(readCallLog().some((c) => c.includes('backend-killed'))).toBe(
        true,
      );
    },
  );

  it('exits with non-zero signal status on SIGINT/SIGTERM and cleans up resources', (done) => {
    createFakeExecutable(
      'docker',
      `
echo "docker $@" >> "${logFile}"
if [ "$1" = "run" ]; then
  for arg in "$@"; do
    if [[ "$arg" == delivery.issue6.owner=* ]]; then
      printf '%s' "\${arg#*=}" > "${tempDir}/owner"
    fi
  done
  touch "${tempDir}/container"
  echo "mock-pg-container-id-sig"
  exit 0
elif [ "$1" = "inspect" ]; then
  if [ ! -f "${tempDir}/container" ]; then
    echo 'Error: No such object: mock-pg-container-id-sig' >&2
    exit 1
  fi
  if [ "$2" = "-f" ]; then cat "${tempDir}/owner"; fi
  exit 0
elif [ "$1" = "rm" ]; then
  rm -f "${tempDir}/container"
  exit 0
elif [ "$1" = "port" ]; then
  echo "127.0.0.1:54999"
  exit 0
elif [ "$1" = "logs" ]; then
  echo "PostgreSQL init process complete; ready for start up."
  exit 0
fi
exit 0
`,
    );

    createFakeExecutable(
      'pnpm',
      `
echo "pnpm $@" >> "${logFile}"
if [ "$1" = "exec" ]; then
  shift
  exec "$@"
fi
exit 0
`,
    );

    createFakeExecutable('curl', `exit 0`);

    createFakeExecutable(
      'node',
      `
if [ "$1" = "-e" ]; then
  echo "48999"
  exit 0
fi
if [[ "$*" == *"dist/main.js"* ]]; then
  echo "backend-started" >> "${logFile}"
  trap 'echo "backend-killed" >> "${logFile}"; exit 0' TERM INT HUP
  while true; do
    sleep 0.1
  done
fi
exit 0
`,
    );

    // Newman hangs until signaled
    createFakeExecutable(
      'newman',
      `
echo "newman-started" >> "${logFile}"
sleep 10
exit 0
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    };
    delete env.DATABASE_URL;

    const child = spawn('bash', [runnerScriptPath], { env });

    // Wait until newman has started, then send SIGINT
    const interval = setInterval(() => {
      const calls = readCallLog();
      if (calls.includes('newman-started')) {
        clearInterval(interval);
        child.kill('SIGINT');
      }
    }, 50);

    child.on('close', (code) => {
      clearInterval(interval);
      // SIGINT exit code should be 130 (128 + 2)
      expect(code).toBe(130);
      const calls = readCallLog();
      expect(calls.some((c) => c.includes('backend-killed'))).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.includes('docker rm') && c.includes('mock-pg-container-id-sig'),
        ),
      ).toBe(true);
      done();
    });
  }, 15000);
});
