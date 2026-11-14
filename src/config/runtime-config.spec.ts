import {
  ConfigurationError,
  corsOriginPolicy,
  isCanonicalOrigin,
  loadRuntimeConfig,
  requireJwtSecret,
} from './runtime-config.js';

// Valores de prueba generados aquí: ninguno es una credencial real.
const STRONG = 'k9Vx2mQpL7wZr4TnB8yHc3FdJ6sAe1UgN5oXiP0aRtMvDqWb';
const production = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  JWT_SECRET: STRONG,
  DATABASE_URL: 'postgresql://app:Zq7rT2vN9xLp@db.internal:5432/app',
  CORS_ALLOWED_ORIGINS: 'https://tienda.example.test',
  ...extra,
});
const problemsOf = (env: NodeJS.ProcessEnv): readonly string[] => {
  try {
    loadRuntimeConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as ConfigurationError).problems;
  }
  return [];
};

describe('configuración de ejecución (#53)', () => {
  describe('secreto JWT', () => {
    it('en producción sin secreto no arranca y no existe valor de respaldo', () => {
      const env = production();
      delete env.JWT_SECRET;
      expect(problemsOf(env)).toEqual(['JWT_SECRET es obligatorio']);
      expect(problemsOf(production({ JWT_SECRET: '   ' }))).toEqual(['JWT_SECRET es obligatorio']);
    });

    it.each([
      ['el valor fijo que tuvo el código', 'uta_logistica_jwt_secret_key_2026_super_secure'],
      ['el valor del ejemplo de .env', 'super_secret_dev_key'],
    ])('rechaza %s en producción y en demo', (_name, value) => {
      for (const NODE_ENV of ['production', 'demo'])
        expect(problemsOf(production({ NODE_ENV, JWT_SECRET: value }))).toEqual([
          expect.stringContaining('valor de desarrollo conocido'),
        ]);
    });

    it('rechaza un secreto corto sin repetirlo en el mensaje', () => {
      const weak = 'corta-pero-secreta';
      try {
        loadRuntimeConfig(production({ JWT_SECRET: weak }));
        throw new Error('debía fallar');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('al menos 32 caracteres');
        expect(message).not.toContain(weak);
        expect(JSON.stringify(error)).not.toContain(weak);
      }
    });

    it('acepta un secreto fuerte y lo devuelve recortado', () => {
      expect(loadRuntimeConfig(production({ JWT_SECRET: `  ${STRONG}  ` })).jwtSecret).toBe(STRONG);
    });

    it('en desarrollo y pruebas no usa un valor fijo: sin secreto genera uno aleatorio por proceso', () => {
      const first = loadRuntimeConfig({ NODE_ENV: 'development' }).jwtSecret;
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(first).not.toBe('uta_logistica_jwt_secret_key_2026_super_secure');
      expect(loadRuntimeConfig({ NODE_ENV: 'test' }).jwtSecret).toBe(first);
    });

    it('en desarrollo acepta un secreto corto configurado', () => {
      expect(loadRuntimeConfig({ NODE_ENV: 'development', JWT_SECRET: 'corto' }).jwtSecret).toBe('corto');
    });

    it('requireJwtSecret publica el secreto efímero para que los demás módulos firmen igual', () => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
      const secret = requireJwtSecret(env);
      expect(env.JWT_SECRET).toBe(secret);
      const configured: NodeJS.ProcessEnv = { NODE_ENV: 'test', JWT_SECRET: 'otro' };
      expect(requireJwtSecret(configured)).toBe('otro');
    });

    it('requireJwtSecret falla en producción sin secreto', () => {
      const env = production();
      delete env.JWT_SECRET;
      expect(() => requireJwtSecret(env)).toThrow(ConfigurationError);
    });
  });

  describe('entorno', () => {
    it('sin NODE_ENV se asume desarrollo con un aviso; un valor desconocido se rechaza', () => {
      const config = loadRuntimeConfig({});
      expect(config).toMatchObject({ environment: 'development', deployed: false });
      expect(config.warnings).toEqual([expect.stringContaining('NODE_ENV no está definido')]);
      // un valor desconocido se trata como desplegado: además de nombrarlo, exige lo propio de un despliegue
      expect(problemsOf({ NODE_ENV: 'staging' })[0]).toContain('NODE_ENV debe ser');
      expect(problemsOf({ NODE_ENV: 'staging' })).toContain('JWT_SECRET es obligatorio');
    });

    it('production y demo son entornos desplegados; development y test no', () => {
      expect(loadRuntimeConfig(production()).deployed).toBe(true);
      expect(loadRuntimeConfig(production({ NODE_ENV: 'demo' })).deployed).toBe(true);
      expect(loadRuntimeConfig({ NODE_ENV: 'development' }).deployed).toBe(false);
      expect(loadRuntimeConfig({ NODE_ENV: 'test' }).deployed).toBe(false);
    });

    it('acumula todos los problemas sin mostrar valores', () => {
      expect(problemsOf({ NODE_ENV: 'production' })).toEqual([
        'JWT_SECRET es obligatorio',
        'CORS_ALLOWED_ORIGINS es obligatorio (orígenes exactos separados por comas)',
        'DATABASE_URL es obligatorio',
      ]);
    });
  });

  describe('CORS', () => {
    it('en desarrollo sin lista queda abierto para que Flutter web y los frontends locales sigan funcionando', () => {
      expect(loadRuntimeConfig({ NODE_ENV: 'development' }).corsOrigins).toBeNull();
      expect(corsOriginPolicy(null)).toBe(true);
    });

    it('en producción exige una lista explícita de orígenes exactos', () => {
      const env = production();
      delete env.CORS_ALLOWED_ORIGINS;
      expect(problemsOf(env)).toEqual([expect.stringContaining('CORS_ALLOWED_ORIGINS es obligatorio')]);
      for (const bad of ['*', 'https://*.example.test', 'https://tienda.example.test/ruta', 'tienda.example.test', 'https://user:pw@tienda.example.test'])
        expect(problemsOf(production({ CORS_ALLOWED_ORIGINS: bad }))).toEqual([expect.stringContaining('orígenes exactos')]);
    });

    it('en producción solo admite http para localhost', () => {
      expect(problemsOf(production({ CORS_ALLOWED_ORIGINS: 'http://tienda.example.test' }))).toEqual([
        expect.stringContaining('https salvo para localhost'),
      ]);
      expect(loadRuntimeConfig(production({ CORS_ALLOWED_ORIGINS: 'http://localhost:5173' })).corsOrigins).toEqual(['http://localhost:5173']);
    });

    it('elimina duplicados y espacios, y la política deja pasar solo lo permitido', async () => {
      const config = loadRuntimeConfig(
        production({ CORS_ALLOWED_ORIGINS: ' https://a.example.test , https://b.example.test,https://a.example.test ' }),
      );
      expect(config.corsOrigins).toEqual(['https://a.example.test', 'https://b.example.test']);
      const policy = corsOriginPolicy(config.corsOrigins) as Exclude<ReturnType<typeof corsOriginPolicy>, true>;
      const decide = (origin?: string) => new Promise<boolean | undefined>((resolve) => policy(origin, (_e, allow) => resolve(allow)));
      expect(await decide('https://a.example.test')).toBe(true);
      expect(await decide('https://evil.example.test')).toBe(false);
      expect(await decide(undefined)).toBe(true); // clientes sin Origin (Flutter, servidores): CORS no aplica
    });

    it('isCanonicalOrigin acepta solo origen exacto', () => {
      expect(isCanonicalOrigin('https://tienda.example.test')).toBe(true);
      expect(isCanonicalOrigin('http://localhost:5173')).toBe(true);
      expect(isCanonicalOrigin('')).toBe(false);
      expect(isCanonicalOrigin('ftp://tienda.example.test')).toBe(false);
    });
  });

  describe('Swagger', () => {
    it('por defecto está activo en desarrollo y pruebas y apagado en producción y demo', () => {
      expect(loadRuntimeConfig({ NODE_ENV: 'development' }).swaggerEnabled).toBe(true);
      expect(loadRuntimeConfig({ NODE_ENV: 'test' }).swaggerEnabled).toBe(true);
      expect(loadRuntimeConfig(production()).swaggerEnabled).toBe(false);
      expect(loadRuntimeConfig(production({ NODE_ENV: 'demo' })).swaggerEnabled).toBe(false);
    });

    it('SWAGGER_ENABLED lo decide explícitamente y rechaza valores ambiguos', () => {
      expect(loadRuntimeConfig(production({ SWAGGER_ENABLED: 'true' })).swaggerEnabled).toBe(true);
      expect(loadRuntimeConfig({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' }).swaggerEnabled).toBe(false);
      expect(problemsOf(production({ SWAGGER_ENABLED: 'yes' }))).toEqual(['SWAGGER_ENABLED debe ser true o false']);
    });
  });

  describe('PostgreSQL y puerto', () => {
    it('en producción exige DATABASE_URL y rechaza la credencial de la base de desarrollo sin mostrarla', () => {
      const missing = production();
      delete missing.DATABASE_URL;
      expect(problemsOf(missing)).toEqual(['DATABASE_URL es obligatorio']);
      const dev = 'postgresql://logistica_user:logistica_password123@db.internal:5432/logistica_db';
      try {
        loadRuntimeConfig(production({ DATABASE_URL: dev }));
        throw new Error('debía fallar');
      } catch (error) {
        expect((error as Error).message).toContain('DATABASE_URL usa la credencial de la base de datos de desarrollo');
        expect((error as Error).message).not.toContain('logistica_password123');
      }
    });

    it('en desarrollo no exige DATABASE_URL ni rechaza la credencial de ejemplo', () => {
      expect(() =>
        loadRuntimeConfig({
          NODE_ENV: 'development',
          DATABASE_URL: 'postgresql://logistica_user:logistica_password123@localhost:5432/logistica_db',
        }),
      ).not.toThrow();
    });

    it('PORT por defecto 3000 y se valida', () => {
      expect(loadRuntimeConfig(production()).port).toBe(3000);
      expect(loadRuntimeConfig(production({ PORT: '8080' })).port).toBe(8080);
      for (const bad of ['abc', '0', '70000', '30.5'])
        expect(problemsOf(production({ PORT: bad }))).toEqual(['PORT debe ser un entero entre 1 y 65535']);
    });
  });
});
