import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureApp, startApplication } from './bootstrap.js';
import { loadRuntimeConfig } from './config/runtime-config.js';

jest.mock('./app.module.js', () => ({ AppModule: class AppModule {} }));
jest.mock('./database/prisma.service.js', () => ({ PrismaService: class PrismaService {} }));

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
  afterEach(() => jest.restoreAllMocks());

  function fakeStartup() {
    const { app, calls } = fakeApp();
    const execute = jest.fn();
    const transaction = jest.fn(async (run: (tx: { execute: typeof execute }) => Promise<void>) => {
      await run({ execute });
      calls.push('provisioned');
    });
    const client = { transaction, raw: { sql: () => ({ affectedCount: () => ({ build: () => ({}) }) }) } };
    const get = jest.fn(() => ({ client }));
    const listen = jest.fn(async (port: number) => { calls.push(`listen:${port}`); });
    const close = jest.fn(async () => { calls.push('close'); });
    Object.assign(app, { get, listen, close });
    const create = jest.spyOn(NestFactory, 'create').mockResolvedValue(app);
    const logger = new Logger('test');
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    return { app, calls, create, get, transaction, listen, close, logger, error };
  }

  it('aprovisiona antes de escuchar en producción habilitada usando el entorno suministrado', async () => {
    const { app, calls, transaction, logger } = fakeStartup();
    const env = production({ PORT: '4321', SIMULATED_PAYMENTS_ENABLED: 'true' });
    jest.replaceProperty(process, 'env', { NODE_ENV: 'development', SIMULATED_PAYMENTS_ENABLED: 'false' });
    expect(await startApplication(env, logger)).toEqual({ app, started: true, exitCode: 0 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['cors', 'prefix:api/v1', 'shutdown', 'pipes', 'provisioned', 'listen:4321']);
  });

  it.each([
    ['production', 'false'],
    ['production', undefined],
    ['production', '1'],
    ['development', 'true'],
    ['test', 'true'],
    ['demo', 'true'],
  ])('escucha sin aprovisionar en %s con bandera %s', async (environment, flag) => {
    const { app, get, transaction, listen, close, logger } = fakeStartup();
    const env = production({ NODE_ENV: environment, SIMULATED_PAYMENTS_ENABLED: flag, SWAGGER_ENABLED: 'false' });
    expect(await startApplication(env, logger)).toEqual({ app, started: true, exitCode: 0 });
    expect(get).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('cierra sin escuchar ni revelar detalles si falla el aprovisionamiento', async () => {
    const { transaction, listen, close, logger, error } = fakeStartup();
    transaction.mockRejectedValueOnce(new Error('private-db-driver-detail'));
    expect(await startApplication(production({ SIMULATED_PAYMENTS_ENABLED: 'true' }), logger))
      .toEqual({ started: false, exitCode: 1 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(listen).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([['No se pudieron inicializar las tarjetas de pago simuladas.']]);
  });

  it('startApplication con configuración insegura no arranca, informa solo las variables y sale con código 1', async () => {
    const { create, transaction, listen } = fakeStartup();
    const logger = new Logger('test');
    const errors: string[] = [];
    jest.spyOn(logger, 'error').mockImplementation((message: unknown) => void errors.push(String(message)));
    const env = production({ JWT_SECRET: 'corto-y-privado', SIMULATED_PAYMENTS_ENABLED: 'true' });
    expect(await startApplication(env, logger)).toEqual({ started: false, exitCode: 1 });
    expect(create).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
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
