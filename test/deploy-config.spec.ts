import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string; target?: string };
  restart?: string;
  ports?: string[];
  expose?: string[];
  volumes?: string[];
  profiles?: string[];
  mem_limit?: string;
  healthcheck?: { test?: string[] };
  environment?: Record<string, string>;
}

interface ComposeDocument {
  services?: Record<string, ComposeService>;
}

describe('Server Deployment Artifacts Contract (Coolify / stephserver)', () => {
  const root = process.cwd();
  const dockerfilePath = path.join(root, 'Dockerfile');
  const dockerignorePath = path.join(root, '.dockerignore');
  const composePath = path.join(root, 'docker-compose.coolify.yml');

  it('defines a multi-stage Debian slim Node 26 Dockerfile with non-root production and migrations targets', () => {
    expect(fs.existsSync(dockerfilePath)).toBe(true);
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

    expect(dockerfile).toContain('FROM node:26-bookworm-slim AS base');
    expect(dockerfile).not.toContain('alpine');
    expect(dockerfile).toContain('pnpm@12.4.1');
    expect(dockerfile).toContain('COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile).toContain('COPY types ./types');
    expect(dockerfile).toContain('AS migrations');
    expect(dockerfile).toContain('AS production');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('/api/v1/health');
    expect(dockerfile).toContain('CMD ["node", "dist/main.js"]');

    expect(dockerfile).not.toContain('logistica_password123');
    expect(dockerfile).not.toContain('uta_logistica_jwt_secret_key');
    expect(dockerfile).not.toMatch(/ENV\s+(JWT_SECRET|DATABASE_URL)=/i);
  });

  it('defines .dockerignore excluding secrets, VCS, build caches, local artifacts, and tests', () => {
    expect(fs.existsSync(dockerignorePath)).toBe(true);
    const lines = fs
      .readFileSync(dockerignorePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    for (const required of [
      '.git',
      '.env',
      '.env.*',
      'node_modules',
      'dist',
      'coverage',
      'reports',
      'test',
      'odd',
      'osrm-data',
      '.agents',
      '.pi',
    ]) {
      expect(lines).toContain(required);
    }
  });

  it('defines docker-compose.coolify.yml without host DB/OSRM ports or dev fallback credentials', () => {
    expect(fs.existsSync(composePath)).toBe(true);
    const rawCompose = fs.readFileSync(composePath, 'utf8');
    expect(rawCompose).not.toContain('logistica_password123');
    expect(rawCompose).not.toContain('uta_logistica_jwt_secret_key');

    const parsed = parse(rawCompose) as ComposeDocument;
    const services = parsed.services ?? {};
    expect(Object.keys(services)).toEqual(expect.arrayContaining(['postgres', 'backend', 'osrm']));

    const postgres = services.postgres;
    expect(postgres.image).toBe('postgres:16-alpine');
    expect(postgres.restart).toBe('unless-stopped');
    expect(postgres.ports).toBeUndefined();
    expect(postgres.healthcheck?.test?.join(' ')).toContain('pg_isready');

    const backend = services.backend;
    expect(backend.build?.target).toBe('production');
    expect(backend.restart).toBe('unless-stopped');
    expect(backend.ports).toBeUndefined();
    expect(backend.expose).toContain('3000');
    expect(backend.healthcheck?.test?.join(' ')).toContain('/api/v1/health');
    expect(backend.environment?.NODE_ENV).toContain('production');

    const osrm = services.osrm;
    expect(osrm.profiles).toContain('road');
    expect(osrm.restart).toBe('unless-stopped');
    expect(osrm.ports).toBeUndefined();
    expect(osrm.mem_limit).toBe('${OSRM_MEM_LIMIT:-2g}');
    expect(osrm.volumes?.some((entry) => entry.endsWith(':/data:ro'))).toBe(true);
  });
});
