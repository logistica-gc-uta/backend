import { randomUUID } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { toInstant } from '../../../common/temporal.util.js';
import type { PrismaService } from '../../../database/prisma.service.js';
import { shopError } from '../shop-http.filter.js';

export interface SimulatedCardFixture {
  readonly fixtureId: string;
  readonly holderName: string;
  readonly last4: string;
  readonly normalizedNumber: string;
  readonly cvv: string;
  readonly expiresMonth: number;
  readonly expiresYear: number;
  readonly initialBalanceCents: bigint;
}

export interface CardInput {
  number: string;
  holderName: string;
  expiresMonth: number;
  expiresYear: number;
  cvv: string;
}

export interface ValidatedCardIdentity {
  readonly fixtureId: string;
  readonly last4: string;
}

type Transaction = Parameters<Parameters<PrismaService['client']['transaction']>[0]>[0];

export type PrismaHandle =
  | PrismaService
  | PrismaService['client'];

export function resolvePrismaClient(handle: PrismaHandle): PrismaService['client'] {
  if ('client' in handle) {
    return handle.client;
  }
  return handle;
}

/**
 * Three exact in-memory fixtures specified by CI-SHOP-001 v1.2 §9 and Issue #33 S7.
 * Plaintext card numbers and CVVs exist ONLY in memory here for comparison during validation;
 * they are NEVER stored in the database, logged, or returned in any API response.
 */
export const SIMULATED_CARD_FIXTURES: readonly SimulatedCardFixture[] = [
  {
    fixtureId: 'DEMO_APPROVED',
    holderName: 'PRUEBA APROBADA',
    last4: '0001',
    normalizedNumber: '9000000000000001',
    cvv: '111',
    expiresMonth: 12,
    expiresYear: 2030,
    initialBalanceCents: 50000n,
  },
  {
    fixtureId: 'DEMO_LIMITED',
    holderName: 'PRUEBA LIMITADA',
    last4: '0002',
    normalizedNumber: '9000000000000002',
    cvv: '222',
    expiresMonth: 12,
    expiresYear: 2030,
    initialBalanceCents: 2000n,
  },
  {
    fixtureId: 'DEMO_EMPTY',
    holderName: 'PRUEBA SIN SALDO',
    last4: '0003',
    normalizedNumber: '9000000000000003',
    cvv: '333',
    expiresMonth: 12,
    expiresYear: 2030,
    initialBalanceCents: 0n,
  },
];

/**
 * Validates that simulation is permitted in the current runtime environment.
 * Fails closed with HTTP 503 PAYMENT_SIMULATION_DISABLED unless:
 * - NODE_ENV is explicitly 'test' or 'demo'
 * - SIMULATED_PAYMENTS_ENABLED is explicitly 'true'
 */
export function assertPaymentSimulationEnabled(): void {
  const nodeEnv = (process.env.NODE_ENV ?? '').trim();
  const simulationEnabled = (process.env.SIMULATED_PAYMENTS_ENABLED ?? '').trim() === 'true';

  if ((nodeEnv !== 'test' && nodeEnv !== 'demo') || !simulationEnabled) {
    throw shopError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'PAYMENT_SIMULATION_DISABLED',
      'El simulador de pagos no está habilitado en este entorno',
      {},
    );
  }
}

function getCardExpiryInstant(expiresMonth: number, expiresYear: number): Temporal.Instant {
  // Expiry is at the end of the given month in business timezone America/Guayaquil
  const nextMonthYear = expiresMonth === 12 ? expiresYear + 1 : expiresYear;
  const nextMonth = expiresMonth === 12 ? 1 : expiresMonth + 1;
  const mm = String(nextMonth).padStart(2, '0');
  const yyyy = String(nextMonthYear);
  const isoString = `${yyyy}-${mm}-01T00:00:00-05:00`;
  return toInstant(isoString);
}

/**
 * Validates card input against in-memory simulation fixtures and an authoritative Temporal instant.
 * - Normalizes number spaces and holder trim/case.
 * - Verifies exact fixture identity and CVV match.
 * - Enforces calendar expiry against the provided authoritative Temporal.Instant.
 * - Returns ONLY safe non-sensitive identity: { fixtureId, last4 }.
 * - Never returns or leaks PAN, CVV, or balance.
 */
export function validateSimulatedCard(
  input: CardInput,
  authoritativeNow: Temporal.Instant,
): ValidatedCardIdentity {
  if (
    !input ||
    typeof input.number !== 'string' ||
    typeof input.holderName !== 'string' ||
    typeof input.cvv !== 'string' ||
    typeof input.expiresMonth !== 'number' ||
    !Number.isInteger(input.expiresMonth) ||
    typeof input.expiresYear !== 'number' ||
    !Number.isInteger(input.expiresYear)
  ) {
    throw shopError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'CARD_INVALID',
      'Los datos de la tarjeta son inválidos',
      {},
    );
  }

  const normalizedNumber = input.number.replace(/\s+/g, '');
  const normalizedHolder = input.holderName.trim().toUpperCase();
  const normalizedCvv = input.cvv.trim();
  const month = input.expiresMonth;
  const year = input.expiresYear;

  if (
    month < 1 ||
    month > 12 ||
    year < 2026 ||
    normalizedNumber.length !== 16 ||
    normalizedCvv.length !== 3 ||
    normalizedHolder.length < 2 ||
    normalizedHolder.length > 100
  ) {
    throw shopError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'CARD_INVALID',
      'Los datos de la tarjeta son inválidos',
      {},
    );
  }

  const fixture = SIMULATED_CARD_FIXTURES.find(
    (f) => f.normalizedNumber === normalizedNumber,
  );

  if (!fixture) {
    throw shopError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'CARD_INVALID',
      'Los datos de la tarjeta son inválidos',
      {},
    );
  }

  if (
    fixture.holderName !== normalizedHolder ||
    fixture.cvv !== normalizedCvv ||
    fixture.expiresMonth !== month ||
    fixture.expiresYear !== year
  ) {
    throw shopError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'CARD_INVALID',
      'Los datos de la tarjeta son inválidos',
      {},
    );
  }

  const expiryInstant = getCardExpiryInstant(fixture.expiresMonth, fixture.expiresYear);
  const compareResult = Temporal.Instant.compare(authoritativeNow, expiryInstant);
  if (compareResult >= 0) {
    throw shopError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'CARD_EXPIRED',
      'La tarjeta de pago ha expirado',
      {},
    );
  }

  return {
    fixtureId: fixture.fixtureId,
    last4: fixture.last4,
  };
}

/**
 * Idempotently bootstraps simulation card fixtures in the database using Prisma 8.
 * - Fails closed if simulation is not enabled.
 * - Uses parameterized raw.sql INSERT ... ON CONFLICT ("fixtureId") DO NOTHING within a transaction.
 * - Completely eliminates read-before-insert race conditions under concurrency.
 * - Inserts MISSING fixtures ONLY.
 * - NEVER overwrites spent balances, reset card states, or reactivates modified cards.
 */
export async function bootstrapSimulatedCards(db: PrismaHandle): Promise<void> {
  assertPaymentSimulationEnabled();

  const client = resolvePrismaClient(db);

  const executePlans = async (tx: Transaction) => {
    for (const fixture of SIMULATED_CARD_FIXTURES) {
      const id = randomUUID();
      const plan = client.raw.sql`
        INSERT INTO public."simulatedCard" ("id", "fixtureId", "last4", "active", "balanceCents", "createdAt", "updatedAt")
        VALUES (${id}, ${fixture.fixtureId}, ${fixture.last4}, true, ${fixture.initialBalanceCents}, clock_timestamp(), clock_timestamp())
        ON CONFLICT ("fixtureId") DO NOTHING
      `.affectedCount().build();
      await tx.execute(plan);
    }
  };

  await client.transaction(async (tx) => {
    await executePlans(tx);
  });
}
