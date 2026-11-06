import { createHmac } from 'node:crypto';

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** Firma un JWT HS256 como lo hace la API (sub, email, role), con el secreto efímero de la corrida. */
export function mintJwt(secret: string, claims: { sub: string; email: string; role: string }, ttlSeconds = 3600, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds }));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(signature)}`;
}

export interface FixtureRow {
  adminToken: string;
  clientToken: string;
  zoneId: string;
  productId: string;
  lat: number;
  lng: number;
}

export const FIXTURE_COLUMNS = ['adminToken', 'clientToken', 'zoneId', 'productId', 'lat', 'lng'] as const;

/** CSV para el CSVDataSet de JMeter (con cabecera, que el plan ignora). */
export function buildFixtureCsv(rows: readonly FixtureRow[]): string {
  if (rows.length === 0) throw new Error('El fixture necesita al menos una fila');
  const lines = rows.map((row) => FIXTURE_COLUMNS.map((column) => String(row[column])).join(','));
  return [FIXTURE_COLUMNS.join(','), ...lines].join('\n') + '\n';
}
