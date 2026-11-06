import { createHmac } from 'node:crypto';
import { FIXTURE_COLUMNS, buildFixtureCsv, mintJwt } from './fixture.js';
import { cpuPercent, parseDockerStats, parseMemoryMb, summarizeResources } from './monitor.js';
import { DEFAULT_SAFETY_LIMITS, loadStages, recoveryStage, safetyStop, stressStages } from './stages.js';

describe('JWT y fixture de JMeter', () => {
  it('firma un HS256 verificable con sub, email, role y vencimiento', () => {
    const token = mintJwt('secreto', { sub: 'u1', email: 'a@perf.test', role: 'ADMIN' }, 600, 1_700_000_000_000);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      sub: 'u1', email: 'a@perf.test', role: 'ADMIN', iat: 1_700_000_000, exp: 1_700_000_600,
    });
    expect(signature).toBe(createHmac('sha256', 'secreto').update(`${header}.${payload}`).digest('base64url'));
    expect(mintJwt('otro', { sub: 'u1', email: 'a@perf.test', role: 'ADMIN' }, 600, 1_700_000_000_000)).not.toBe(token);
  });

  it('arma el CSV con la cabecera que espera el plan', () => {
    const csv = buildFixtureCsv([{ adminToken: 'A', clientToken: 'C', zoneId: 'Z', productId: 'P', lat: -1.2, lng: -78.6 }]);
    expect(csv.split('\n')[0]).toBe(FIXTURE_COLUMNS.join(','));
    expect(csv.split('\n')[1]).toBe('A,C,Z,P,-1.2,-78.6');
    expect(() => buildFixtureCsv([])).toThrow('al menos una fila');
  });
});

describe('lecturas de recursos', () => {
  it('convierte unidades de memoria de Docker a MB', () => {
    expect(parseMemoryMb('512MiB')).toBe(512);
    expect(parseMemoryMb('1.5GiB')).toBe(1536);
    expect(parseMemoryMb('2048kB')).toBe(2);
    expect(parseMemoryMb('basura')).toBeNaN();
  });

  it('interpreta una línea de docker stats', () => {
    expect(parseDockerStats('{"CPUPerc":"12.50%","MemUsage":"300MiB / 7.6GiB"}')).toEqual({ cpuPct: 12.5, memMb: 300 });
    expect(() => parseDockerStats('{"CPUPerc":"--","MemUsage":"x"}')).toThrow('no reconocida');
  });

  it('calcula el CPU % normalizado a los núcleos', () => {
    expect(cpuPercent(10, 12, 2, 4)).toBeCloseTo(25); // 2 s de CPU en 2 s con 4 núcleos
    expect(cpuPercent(10, 9, 2, 4)).toBe(0);
    expect(cpuPercent(10, 12, 0, 4)).toBe(0);
  });

  it('resume promedios y máximos de la serie', () => {
    const base = { t: 0, apiCpuPct: 10, apiRssMb: 100, dbCpuPct: 20, dbMemMb: 200, dbConnections: 5 };
    const summary = summarizeResources([base, { ...base, apiCpuPct: 30, apiRssMb: 300, dbConnections: 9 }]);
    expect(summary).toMatchObject({ samples: 2, apiCpuAvg: 20, apiCpuMax: 30, apiRssMaxMb: 300, dbConnectionsMax: 9, dbMemMaxMb: 200 });
    expect(summarizeResources([]).apiCpuAvg).toBeNaN();
  });
});

describe('etapas y límites seguros', () => {
  it('la carga pedida es 25/50/100 y 200 solo si se habilita', () => {
    expect(loadStages().map((s) => s.users)).toEqual([25, 50, 100]);
    expect(loadStages({ include200: true }).map((s) => s.users)).toEqual([25, 50, 100, 200]);
    expect(loadStages().every((s) => s.kind === 'load' && s.durationSeconds === 60)).toBe(true);
  });

  it('el estrés escala de 100 en 100 hasta el máximo y la recuperación es una carga baja', () => {
    expect(stressStages().map((s) => s.users)).toEqual([100, 200, 300, 400]);
    expect(stressStages({ startUsers: 50, stepUsers: 50, maxUsers: 150 }).map((s) => s.name)).toEqual(['estres-50', 'estres-100', 'estres-150']);
    expect(recoveryStage()).toMatchObject({ kind: 'recovery', users: 10 });
  });

  it('los límites seguros solo se activan al superarse y dicen el motivo', () => {
    expect(safetyStop(DEFAULT_SAFETY_LIMITS, { errorRate: 0.01, apiRssMb: 500, p95Ms: 800 })).toBeUndefined();
    expect(safetyStop(DEFAULT_SAFETY_LIMITS, { errorRate: 0.6, apiRssMb: 500, p95Ms: 800 })).toContain('errores');
    expect(safetyStop(DEFAULT_SAFETY_LIMITS, { errorRate: 0, apiRssMb: 4000, p95Ms: 800 })).toContain('memoria');
    expect(safetyStop(DEFAULT_SAFETY_LIMITS, { errorRate: 0, apiRssMb: 500, p95Ms: 60_000 })).toContain('p95');
  });
});
