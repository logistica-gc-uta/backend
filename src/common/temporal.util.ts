// Prisma 8 mapea las columnas timestamptz a Temporal.Instant (no a Date), por lo
// que cualquier fecha enviada a la base de datos debe convertirse antes de escribir.
export function toInstant(value: Date | string): Temporal.Instant {
  const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return Temporal.Instant.from(iso);
}

export function nowInstant(): Temporal.Instant {
  return Temporal.Now.instant();
}
