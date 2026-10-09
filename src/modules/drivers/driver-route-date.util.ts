import { BadRequestException } from '@nestjs/common';

/** Strict calendar day in America/Guayaquil; UTC instants, independent of process TZ. */
export function driverRouteDay(
  value: unknown,
): { start: Temporal.Instant; end: Temporal.Instant } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(
      'date must be a valid YYYY-MM-DD calendar date',
    );
  }
  try {
    const day = Temporal.PlainDate.from(value, { overflow: 'reject' });
    return {
      start: day.toZonedDateTime('America/Guayaquil').toInstant(),
      end: day
        .add({ days: 1 })
        .toZonedDateTime('America/Guayaquil')
        .toInstant(),
    };
  } catch {
    throw new BadRequestException(
      'date must be a valid YYYY-MM-DD calendar date',
    );
  }
}
