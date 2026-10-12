// Prisma 8 mapea las columnas timestamptz a Temporal.Instant (no a Date), por lo
// que cualquier fecha enviada a la base de datos debe convertirse antes de escribir.
export function toInstant(value: Date | string): Temporal.Instant {
  const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return Temporal.Instant.from(iso);
}

export function nowInstant(): Temporal.Instant {
  return Temporal.Now.instant();
}

// Zona horaria del negocio: define qué es "el mismo día" para rutas y pedidos.
export const BUSINESS_TIME_ZONE = 'America/Guayaquil';

export function businessDay(instant: Temporal.Instant): Temporal.PlainDate {
  return instant.toZonedDateTimeISO(BUSINESS_TIME_ZONE).toPlainDate();
}

export function isSameBusinessDay(a: Temporal.Instant, b: Temporal.Instant): boolean {
  return businessDay(a).equals(businessDay(b));
}
