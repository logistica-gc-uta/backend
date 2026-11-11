import { HttpStatus } from '@nestjs/common';
import { shopError } from '../shop/shop-http.filter.js';

export const OPERATING_TIME_ZONE = 'America/Guayaquil';

export function assertWithinOperatingHours(
  scheduled: Temporal.Instant,
  schedule: { startTime: string; endTime: string; timeZone?: string },
): void {
  const timeZone = schedule.timeZone ?? OPERATING_TIME_ZONE;
  const localTime = scheduled.toZonedDateTimeISO(timeZone).toPlainTime();
  const startTime = Temporal.PlainTime.from(schedule.startTime);
  const endTime = Temporal.PlainTime.from(schedule.endTime);
  if (
    Temporal.PlainTime.compare(localTime, startTime) < 0 ||
    Temporal.PlainTime.compare(localTime, endTime) > 0
  ) {
    const requestedTime = `${String(localTime.hour).padStart(2, '0')}:${String(localTime.minute).padStart(2, '0')}`;
    throw shopError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'DELIVERY_OUTSIDE_HOURS',
      `Scheduled delivery time ${requestedTime} is outside commercial delivery hours (${schedule.startTime} - ${schedule.endTime})`,
      {
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        timeZone,
        requestedTime,
      },
    );
  }
}
