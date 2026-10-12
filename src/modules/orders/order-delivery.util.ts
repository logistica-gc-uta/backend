import { BadRequestException } from '@nestjs/common';
import { isSameBusinessDay } from '../../common/temporal.util.js';
import type { PrismaService } from '../../database/prisma.service.js';

// Require an explicit instant, never interpret a wall time in the host timezone.
export const EXPLICIT_OFFSET = /T.*(?:Z|[+-]\d{2}:\d{2})$/;
export interface DeliveryTiming {
  scheduledDeliveryDate: Temporal.Instant | null;
  deliveryWindowStart: Temporal.Instant | null;
  deliveryWindowEnd: Temporal.Instant | null;
}

function explicitInstant(value: string): Temporal.Instant {
  try {
    if (typeof value !== 'string' || !EXPLICIT_OFFSET.test(value)) throw new Error('Missing offset');
    return Temporal.Instant.from(value);
  } catch {
    throw new BadRequestException('Date must be a valid ISO instant with explicit offset');
  }
}

export function parseDeliveryTiming(input: {
  scheduledDeliveryDate?: string; deliveryWindowStart?: string; deliveryWindowEnd?: string;
}, requireSchedule = false): DeliveryTiming {
  const scheduled = input.scheduledDeliveryDate === undefined ? null : explicitInstant(input.scheduledDeliveryDate);
  const start = input.deliveryWindowStart === undefined ? null : explicitInstant(input.deliveryWindowStart);
  const end = input.deliveryWindowEnd === undefined ? null : explicitInstant(input.deliveryWindowEnd);
  if (requireSchedule && !scheduled) throw new BadRequestException('Scheduled delivery date is required');
  if ((start === null) !== (end === null) || (start && end && (!scheduled ||
    Temporal.Instant.compare(start, end) >= 0 ||
    Temporal.Instant.compare(scheduled, start) < 0 || Temporal.Instant.compare(scheduled, end) > 0 ||
    !isSameBusinessDay(start, end) || !isSameBusinessDay(start, scheduled)
  ))) throw new BadRequestException('Invalid paired delivery window');
  return { scheduledDeliveryDate: scheduled, deliveryWindowStart: start, deliveryWindowEnd: end };
}

export function assertDeliveryFuture(timing: DeliveryTiming, now: Temporal.Instant): void {
  for (const deadline of [timing.scheduledDeliveryDate, timing.deliveryWindowStart]) {
    if (deadline && Temporal.Instant.compare(deadline, now) <= 0) {
      // Deliberately excludes address, recipient, owner and input date.
      throw new BadRequestException('Scheduled delivery and window start must be strictly future');
    }
  }
}

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];
export async function deliveryClock(tx: Transaction, raw: Client['raw']): Promise<Temporal.Instant> {
  // PostgreSQL now()/transaction_timestamp() freeze at transaction start and
  // cannot detect expiration during locks/writes. This plan runs on tx.query.
  // Codec matches the emitted timestamptz contract (rc.11), preserving precision.
  const plan = raw.sql`SELECT clock_timestamp() AS instant`
    .returnsRow({ instant: 'pg/timestamptz-temporal@1' }).build();
  const [row] = await tx.query(plan);
  if (!row) throw new Error('Database delivery clock unavailable');
  return row.instant;
}
