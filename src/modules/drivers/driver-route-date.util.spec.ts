import { BadRequestException } from '@nestjs/common';
import { driverRouteDay } from './driver-route-date.util.js';

describe('driverRouteDay', () => {
  it('uses Guayaquil midnight and next midnight, including leap days', () => {
    const range = driverRouteDay('2024-02-29')!;
    expect(range.start.toString()).toBe('2024-02-29T05:00:00Z');
    expect(range.end.toString()).toBe('2024-03-01T05:00:00Z');
  });
  it('does not depend on process timezone', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      expect(driverRouteDay('2026-12-31')!.end.toString()).toBe(
        '2027-01-01T05:00:00Z',
      );
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it('allows an omitted filter', () =>
    expect(driverRouteDay(undefined)).toBeUndefined());
  it.each([
    '2023-02-29',
    '2024-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-1-01',
    '2026-01-01T00:00:00Z',
    '',
    null,
    20260101,
    ['2026-01-01'],
  ])('rejects invalid date %p without rollover', (date) => {
    expect(() => driverRouteDay(date)).toThrow(BadRequestException);
  });
});
