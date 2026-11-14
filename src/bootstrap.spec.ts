import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { configureApp, startApplication } from './bootstrap.js';
import { loadRuntimeConfig } from './config/runtime-config.js';

// Valores generados para la prueba: ninguno es una credencial real.
const STRONG = 'Qw3rTy9uIoP2aSdF5gHjK8lZxC1vBnM4qWeRtY7uIoPaSdFg';
const production = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  JWT_SECRET: STRONG,
  DATABASE_URL: 'postgresql://app:Zq7rT2vN9xLp@db.internal:5432/app',
  CORS_ALLOWED_ORIGINS: 'https://tienda.example.test',
  ...extra,
});

function fakeApp() {
  const calls: string[] = [];
  const cors: unknown[] = [];
  const app = {
    enableCors: (options: unknown) => (cors.push(options), calls.push('cors')),
    setGlobalPrefix: (prefix: string) => calls.push(`prefix:${prefix}`),
    enableShutdownHooks: () => calls.push('shutdown'),
    useGlobalPipes: () => calls.push('pipes'),
  } as unknown as INestApplication;
  return { app, calls, cors };
}

describe('bootstrap (#53)', () => {
  it('startApplication con configuración insegura no arranca, informa solo las variables y sale con código 1', async () => {
    const logger = new Logger('test');
    const errors: string[] = [];
    jest.spyOn(logger, 'error').mockImplementation((message: unknown) => void errors.push(String(message)));
    const env = production({ JWT_SECRET: 'corto-y-privado' });
    expect(await startApplication(env, logger)).toEqual({ started: false, exitCode: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('JWT_SECRET');
    expect(errors[0]).not.toContain('corto-y-privado');
    expect(errors[0]).not.toContain('Zq7rT2vN9xLp');
  });

  it('configureApp aplica prefijo, cierre ordenado, validación y la política de CORS configurada', () => {
    const { app, calls, cors } = fakeApp();
    configureApp(app, loadRuntimeConfig(production()));
    expect(calls).toEqual(['cors', 'prefix:api/v1', 'shutdown', 'pipes']);
    expect(typeof (cors[0] as { origin: unknown }).origin).toBe('function');
  });

  it('en desarrollo sin lista el CORS queda abierto', () => {
    const { app, cors } = fakeApp();
    configureApp(app, loadRuntimeConfig({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' }));
    expect((cors[0] as { origin: unknown }).origin).toBe(true);
  });
});
