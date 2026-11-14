import { randomBytes } from 'node:crypto';

/**
 * Configuración de ejecución validada ANTES de arrancar (#53).
 *
 * Reglas:
 * - En `production` y `demo` (entornos desplegados) no existe ningún secreto de respaldo: `JWT_SECRET` es obligatorio,
 *   de al menos 32 caracteres y distinto de los valores conocidos de desarrollo; `DATABASE_URL` es obligatorio y no
 *   puede usar la credencial de la base de desarrollo; los orígenes CORS deben declararse de forma explícita y
 *   Swagger queda apagado salvo que `SWAGGER_ENABLED=true`.
 * - En `development`, `test` (y mientras `NODE_ENV` no esté definido) no hay secreto fijo en el código: si falta
 *   `JWT_SECRET` se usa un secreto aleatorio por proceso, que invalida los tokens al reiniciar.
 * - Los errores nombran las variables, nunca sus valores.
 */
export type RuntimeEnvironment = 'development' | 'test' | 'demo' | 'production';

export interface RuntimeConfig {
  environment: RuntimeEnvironment;
  /** `true` en `production` y `demo`: no se toleran valores de desarrollo. */
  deployed: boolean;
  jwtSecret: string;
  jwtExpiresIn: string;
  /** `null`: CORS abierto (solo desarrollo y pruebas). Lista: únicamente esos orígenes exactos. */
  corsOrigins: readonly string[] | null;
  swaggerEnabled: boolean;
  port: number;
  /** Avisos sin datos sensibles (p. ej. `NODE_ENV` sin definir). */
  warnings: readonly string[];
}

export class ConfigurationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuración inválida: ${problems.join('; ')}`);
    this.name = 'ConfigurationError';
  }
}

export const MIN_JWT_SECRET_LENGTH = 32;
// Valores que existieron en el repositorio (código, ejemplo de .env, pruebas): jamás valen como secreto desplegado.
const KNOWN_DEV_SECRETS = new Set([
  'uta_logistica_jwt_secret_key_2026_super_secure',
  'super_secret_dev_key',
]);
const KNOWN_DEV_DATABASE_PASSWORDS = ['logistica_password123'];
const ENVIRONMENTS: readonly RuntimeEnvironment[] = ['development', 'test', 'demo', 'production'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Un solo secreto efímero por proceso: nunca un valor fijo del repositorio.
let ephemeralSecret: string | undefined;

/** Origen exacto (esquema + host + puerto), sin comodín, ruta ni credenciales. */
export function isCanonicalOrigin(candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes('*')) return false;
  try {
    const parsed = new URL(candidate);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.origin === candidate &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function resolveEnvironment(raw: string | undefined, problems: string[], warnings: string[]): RuntimeEnvironment {
  const value = (raw ?? '').trim();
  if (value === '') {
    warnings.push('NODE_ENV no está definido: se asume development. Defínalo como production en un despliegue.');
    return 'development';
  }
  if (!(ENVIRONMENTS as readonly string[]).includes(value)) {
    problems.push(`NODE_ENV debe ser uno de ${ENVIRONMENTS.join(', ')}`);
    return 'production';
  }
  return value as RuntimeEnvironment;
}

function resolveSecret(env: NodeJS.ProcessEnv, deployed: boolean, problems: string[]): string {
  const configured = env.JWT_SECRET?.trim();
  if (configured) {
    if (deployed && KNOWN_DEV_SECRETS.has(configured))
      problems.push('JWT_SECRET usa un valor de desarrollo conocido: genere uno propio');
    else if (deployed && configured.length < MIN_JWT_SECRET_LENGTH)
      problems.push(`JWT_SECRET debe tener al menos ${MIN_JWT_SECRET_LENGTH} caracteres`);
    return configured;
  }
  if (deployed) {
    problems.push('JWT_SECRET es obligatorio');
    return '';
  }
  ephemeralSecret ??= randomBytes(48).toString('base64url');
  return ephemeralSecret;
}

function resolveCors(env: NodeJS.ProcessEnv, deployed: boolean, problems: string[]): readonly string[] | null {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (raw === undefined || raw.trim() === '') {
    if (deployed) problems.push('CORS_ALLOWED_ORIGINS es obligatorio (orígenes exactos separados por comas)');
    return deployed ? [] : null;
  }
  const origins = raw.split(',').map((entry) => entry.trim());
  for (const origin of origins) {
    if (!isCanonicalOrigin(origin)) {
      problems.push('CORS_ALLOWED_ORIGINS solo admite orígenes exactos (sin comodín, ruta ni credenciales)');
      break;
    }
    // Un despliegue sirve la web por HTTPS; HTTP solo se admite para probar en la misma máquina.
    if (deployed && new URL(origin).protocol === 'http:' && !LOOPBACK_HOSTS.has(new URL(origin).hostname)) {
      problems.push('CORS_ALLOWED_ORIGINS debe usar https salvo para localhost');
      break;
    }
  }
  return [...new Set(origins)];
}

function resolveSwagger(env: NodeJS.ProcessEnv, deployed: boolean, problems: string[]): boolean {
  const raw = env.SWAGGER_ENABLED?.trim();
  if (raw === undefined || raw === '') return !deployed;
  if (raw !== 'true' && raw !== 'false') {
    problems.push('SWAGGER_ENABLED debe ser true o false');
    return false;
  }
  return raw === 'true';
}

function checkDatabase(env: NodeJS.ProcessEnv, deployed: boolean, problems: string[]): void {
  if (!deployed) return;
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    problems.push('DATABASE_URL es obligatorio');
    return;
  }
  if (KNOWN_DEV_DATABASE_PASSWORDS.some((password) => url.includes(password)))
    problems.push('DATABASE_URL usa la credencial de la base de datos de desarrollo');
}

function resolvePort(env: NodeJS.ProcessEnv, problems: string[]): number {
  const raw = env.PORT?.trim();
  if (raw === undefined || raw === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('PORT debe ser un entero entre 1 y 65535');
    return 3000;
  }
  return port;
}

/** Valida y normaliza la configuración. Lanza `ConfigurationError` con todos los problemas, sin valores. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  const environment = resolveEnvironment(env.NODE_ENV, problems, warnings);
  const deployed = environment === 'production' || environment === 'demo';
  const config: RuntimeConfig = {
    environment,
    deployed,
    jwtSecret: resolveSecret(env, deployed, problems),
    jwtExpiresIn: env.JWT_EXPIRES_IN?.trim() || '24h',
    corsOrigins: resolveCors(env, deployed, problems),
    swaggerEnabled: resolveSwagger(env, deployed, problems),
    port: resolvePort(env, problems),
    warnings,
  };
  checkDatabase(env, deployed, problems);
  if (problems.length) throw new ConfigurationError(problems);
  return config;
}

/**
 * Secreto JWT vigente para firmar y verificar. Reutiliza la misma validación; en desarrollo sin `JWT_SECRET` publica el
 * secreto efímero en `process.env` para que el resto de módulos (tiempo real, tokens de cotización) firmen con el mismo.
 */
export function requireJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const { jwtSecret } = loadRuntimeConfig(env);
  if (!env.JWT_SECRET?.trim()) env.JWT_SECRET = jwtSecret;
  return jwtSecret;
}

/** Función `origin` de CORS: sin cabecera `Origin` (móvil, servidores) no aplica; con ella solo pasan los permitidos. */
export function corsOriginPolicy(
  allowed: readonly string[] | null,
): true | ((origin: string | undefined, done: (error: Error | null, allow?: boolean) => void) => void) {
  if (allowed === null) return true;
  const list = new Set(allowed);
  return (origin, done) => done(null, origin === undefined || list.has(origin));
}
