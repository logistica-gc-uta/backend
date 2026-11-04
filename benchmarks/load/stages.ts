/** Una etapa de carga de JMeter: usuarios concurrentes, rampa y duración. */
export interface Stage {
  name: string;
  kind: 'load' | 'stress' | 'recovery';
  users: number;
  rampupSeconds: number;
  durationSeconds: number;
}

/** Carga pedida por el Issue #15: 25, 50 y 100 usuarios; 200 solo si los recursos lo permiten. */
export function loadStages(options: { include200?: boolean; durationSeconds?: number } = {}): Stage[] {
  const durationSeconds = options.durationSeconds ?? 60;
  const users = options.include200 ? [25, 50, 100, 200] : [25, 50, 100];
  return users.map((n) => ({ name: `carga-${n}`, kind: 'load' as const, users: n, rampupSeconds: Math.min(15, Math.round(durationSeconds / 4)), durationSeconds }));
}

/** Estrés escalonado: sube de 100 en 100 usuarios hasta `maxUsers`, o hasta que se active un límite seguro. */
export function stressStages(options: { startUsers?: number; stepUsers?: number; maxUsers?: number; durationSeconds?: number } = {}): Stage[] {
  const start = options.startUsers ?? 100;
  const step = options.stepUsers ?? 100;
  const maxUsers = options.maxUsers ?? 400;
  const durationSeconds = options.durationSeconds ?? 45;
  const stages: Stage[] = [];
  for (let users = start; users <= maxUsers; users += step) {
    stages.push({ name: `estres-${users}`, kind: 'stress', users, rampupSeconds: 10, durationSeconds });
  }
  return stages;
}

/** Tras el estrés se vuelve a una carga baja para comprobar que el sistema se recupera. */
export const recoveryStage = (users = 10, durationSeconds = 30): Stage => ({
  name: `recuperacion-${users}`, kind: 'recovery', users, rampupSeconds: 5, durationSeconds,
});

/**
 * Límites SEGUROS para no dañar el equipo ni dejar la corrida colgada. No son umbrales de aprobación:
 * solo deciden cuándo dejar de subir la carga. Cada uno se registra en el reporte como causa de parada.
 */
export interface SafetyLimits {
  maxErrorRate: number;
  maxApiRssMb: number;
  maxP95Ms: number;
}
export const DEFAULT_SAFETY_LIMITS: SafetyLimits = { maxErrorRate: 0.5, maxApiRssMb: 3000, maxP95Ms: 30_000 };

export function safetyStop(
  limits: SafetyLimits,
  observed: { errorRate: number; apiRssMb: number; p95Ms: number },
): string | undefined {
  if (observed.errorRate > limits.maxErrorRate) return `tasa de errores ${(observed.errorRate * 100).toFixed(1)} % > ${(limits.maxErrorRate * 100).toFixed(0)} %`;
  if (observed.apiRssMb > limits.maxApiRssMb) return `memoria de la API ${Math.round(observed.apiRssMb)} MB > ${limits.maxApiRssMb} MB`;
  if (observed.p95Ms > limits.maxP95Ms) return `p95 ${Math.round(observed.p95Ms)} ms > ${limits.maxP95Ms} ms`;
  return undefined;
}
