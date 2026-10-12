import { businessDay, isSameBusinessDay, nowInstant, toInstant } from './temporal.util.js';

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

  describe('día de negocio (America/Guayaquil)', () => {
    const at = (iso: string) => Temporal.Instant.from(iso);

    it('businessDay devuelve la fecha local de Guayaquil, no la UTC', () => {
      expect(businessDay(at('2026-10-11T04:59:59Z')).toString()).toBe('2026-10-10');
      expect(businessDay(at('2026-10-11T05:00:00Z')).toString()).toBe('2026-10-11');
    });

    it('instantes a distinta hora del mismo día local son del mismo día', () => {
      expect(isSameBusinessDay(at('2026-10-10T05:00:00Z'), at('2026-10-11T04:59:59Z'))).toBe(true);
    });

    it('cruzar la medianoche UTC no cambia el día local (18:30 y 23:00 de Guayaquil)', () => {
      expect(isSameBusinessDay(at('2026-10-10T23:30:00Z'), at('2026-10-11T04:00:00Z'))).toBe(true);
    });

    it('cruzar la medianoche local sí cambia el día aunque estén a un segundo', () => {
      expect(isSameBusinessDay(at('2026-10-11T04:59:59Z'), at('2026-10-11T05:00:00Z'))).toBe(false);
    });
  });
});
