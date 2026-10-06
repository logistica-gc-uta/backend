import { nowInstant, toInstant } from './temporal.util.js';

describe('temporal.util', () => {
  it('toInstant convierte un string ISO 8601 en Temporal.Instant', () => {
    const instant = toInstant('2026-09-25T14:30:00.000Z');

    expect(instant).toBeInstanceOf(Temporal.Instant);
    expect(instant.toString()).toBe('2026-09-25T14:30:00Z');
  });

  it('toInstant convierte un Date en Temporal.Instant conservando el instante', () => {
    const date = new Date('2026-02-14T15:00:00.000Z');

    expect(toInstant(date).epochMilliseconds).toBe(date.getTime());
  });

  it('nowInstant devuelve un Temporal.Instant cercano a la hora actual', () => {
    const before = Date.now();
    const instant = nowInstant();

    expect(instant).toBeInstanceOf(Temporal.Instant);
    expect(instant.epochMilliseconds).toBeGreaterThanOrEqual(before);
    expect(instant.epochMilliseconds).toBeLessThanOrEqual(Date.now());
  });
});
