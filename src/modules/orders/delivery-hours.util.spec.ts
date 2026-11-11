import { HttpException, HttpStatus } from '@nestjs/common';
import { assertWithinOperatingHours } from './delivery-hours.util.js';

const hours = { startTime: '07:00', endTime: '17:00', timeZone: 'America/Guayaquil' };

describe('assertWithinOperatingHours', () => {
  it('accepts inclusive 07:00 and 17:00 America/Guayaquil instants', () => {
    expect(() =>
      assertWithinOperatingHours(Temporal.Instant.from('2026-11-15T07:00:00-05:00'), hours),
    ).not.toThrow();
    expect(() =>
      assertWithinOperatingHours(Temporal.Instant.from('2026-11-15T17:00:00-05:00'), hours),
    ).not.toThrow();
  });

  it('rejects 06:59 and 17:01 with DELIVERY_OUTSIDE_HOURS', () => {
    try {
      assertWithinOperatingHours(Temporal.Instant.from('2026-11-15T06:59:00-05:00'), hours);
      throw new Error('expected 06:59 to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect((error as HttpException).getResponse()).toMatchObject({
        error: { code: 'DELIVERY_OUTSIDE_HOURS', details: { requestedTime: '06:59' } },
      });
    }

    try {
      assertWithinOperatingHours(Temporal.Instant.from('2026-11-15T17:01:00-05:00'), hours);
      throw new Error('expected 17:01 to fail');
    } catch (error) {
      expect((error as HttpException).getResponse()).toMatchObject({
        error: { code: 'DELIVERY_OUTSIDE_HOURS', details: { requestedTime: '17:01' } },
      });
    }
  });
});
