import { BadRequestException } from '@nestjs/common';
import { BUSINESS_TIME_ZONE, isSameBusinessDay } from '../../common/temporal.util.js';
import { assertDeliveryFuture, parseDeliveryTiming } from './order-delivery.util.js';
import { evaluatePlanningEligibility } from './order-geography.util.js';
import { isOrderPlanningEligible } from '../routes/route-lifecycle.policy.js';
import { OrderStatus } from './dto/update-order-status.dto.js';

const instant = (value: string) => Temporal.Instant.from(value);
const schedule = '2030-02-15T01:00:00Z'; // Still Feb 14 in Guayaquil.
const timing = (scheduledDeliveryDate = schedule) => parseDeliveryTiming({ scheduledDeliveryDate });

describe('delivery instant policy', () => {
  it.each(['2030-02-30T01:00:00Z', '2030-02-29T01:00:00Z', '2030-13-01T01:00:00Z',
    '2030-02-14T24:00:00Z', '2030-02-14T01:00:00+25:00', '2030-02-14T01:00:00+05:60',
    '2030-02-14T01:00:00', '2030-02-14', 'invalid', '', null])('rejects malformed, overflow or implicit instant %s', (value) => {
    expect(() => parseDeliveryTiming({ scheduledDeliveryDate: value as string })).toThrow(BadRequestException);
  });
  it('accepts leap day and preserves submillisecond precision', () => {
    expect(timing('2032-02-29T10:00:00.123456Z').scheduledDeliveryDate?.toString()).toBe('2032-02-29T10:00:00.123456Z');
  });
  it('omitted CLIENT date is compatible, required ADMIN date is not', () => {
    const omitted = parseDeliveryTiming({});
    expect(omitted.scheduledDeliveryDate).toBeNull();
    expect(() => assertDeliveryFuture(omitted, instant(schedule))).not.toThrow();
    expect(() => parseDeliveryTiming({}, true)).toThrow(BadRequestException);
  });
  it.each(['UTC', 'Asia/Tokyo', 'America/Los_Angeles'])('is host-TZ neutral under %s', (tz) => {
    const original = process.env.TZ;
    try {
      process.env.TZ = tz;
      expect(timing('2030-02-14T20:00:00-05:00').scheduledDeliveryDate?.equals(instant(schedule))).toBe(true);
      expect(BUSINESS_TIME_ZONE).toBe('America/Guayaquil');
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  });
  it.each(['2030-02-15T01:00:00Z', '2030-02-15T01:00:00.000001Z', '2030-02-16T01:00:00Z'])('rejects equal/past relative to %s', (now) => {
    expect(() => assertDeliveryFuture(timing(), instant(now))).toThrow(BadRequestException);
  });
  it('accepts strictly future across Guayaquil midnight', () => {
    expect(() => assertDeliveryFuture(timing('2030-02-15T05:00:00Z'), instant('2030-02-15T04:59:59.999999Z'))).not.toThrow();
    expect(isSameBusinessDay(instant('2030-02-15T04:59:59Z'), instant('2030-02-15T05:00:00Z'))).toBe(false);
  });
});

describe('delivery window and planning compatibility', () => {
  it.each([
    { deliveryWindowStart: schedule },
    { deliveryWindowEnd: schedule },
    { deliveryWindowStart: schedule, deliveryWindowEnd: schedule },
    { deliveryWindowStart: '2030-02-15T02:00:00Z', deliveryWindowEnd: schedule },
    { deliveryWindowStart: '2030-02-15T02:00:00Z', deliveryWindowEnd: '2030-02-15T03:00:00Z' },
    { deliveryWindowStart: '2030-02-14T23:00:00Z', deliveryWindowEnd: '2030-02-15T00:00:00Z' },
    { deliveryWindowStart: schedule, deliveryWindowEnd: '2030-02-15T05:00:00Z' },
  ])('rejects partial, inverted, outside or cross-business-day window %#', (window) => {
    expect(() => parseDeliveryTiming({ scheduledDeliveryDate: schedule, ...window })).toThrow(BadRequestException);
  });
  it('rejects window without schedule', () => {
    expect(() => parseDeliveryTiming({ deliveryWindowStart: schedule, deliveryWindowEnd: '2030-02-15T03:00:00Z' })).toThrow(BadRequestException);
  });
  it.each([schedule, '2030-02-15T03:00:00Z'])('accepts inclusive schedule endpoint %s and mixed offsets', (scheduledDeliveryDate) => {
    expect(() => parseDeliveryTiming({ scheduledDeliveryDate,
      deliveryWindowStart: '2030-02-14T20:00:00-05:00', deliveryWindowEnd: '2030-02-15T03:00:00Z' })).not.toThrow();
  });
  it('rejects expired window start even with future scheduled instant', () => {
    const window = parseDeliveryTiming({ scheduledDeliveryDate: '2030-02-15T03:00:00Z',
      deliveryWindowStart: schedule, deliveryWindowEnd: '2030-02-15T03:00:00Z' });
    expect(() => assertDeliveryFuture(window, instant(schedule))).toThrow(BadRequestException);
  });
  it('reuses geography and assignment business-day helpers without engine changes', () => {
    const order = { deliveryLat: -1.2, deliveryLng: -78.6, scheduledDeliveryDate: instant(schedule) };
    expect(evaluatePlanningEligibility(order, { depotLat: -1.2, depotLng: -78.6 }).planningEligibility.eligible).toBe(true);
    expect(evaluatePlanningEligibility({ deliveryLat: null, deliveryLng: null }, { depotLat: -1.2, depotLng: -78.6 }).planningEligibility.eligible).toBe(false);
    expect(isOrderPlanningEligible(OrderStatus.PENDING, false, false)).toBe(true);
    expect(isSameBusinessDay(order.scheduledDeliveryDate, instant('2030-02-14T15:00:00Z'))).toBe(true);
    expect(isSameBusinessDay(order.scheduledDeliveryDate, instant('2030-02-15T15:00:00Z'))).toBe(false);
  });
});
