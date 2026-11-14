import type { PrismaService } from '../database/prisma.service.js';
import { isEmailUniqueViolation, normalizedEmail } from '../modules/auth/email-identity.util.js';
import { hashNewPassword } from '../modules/auth/password-hash.util.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];

export const DEFAULT_SEED_ADMIN_NAME = 'Administrator';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SeedAdminConfig {
  email: string;
  password: string;
  name: string;
}

export type SeedProductionAdminResult =
  | {
      status: 'created';
      email: string;
      userId: string;
    }
  | {
      status: 'skipped';
      reason: 'email_already_exists' | 'admin_already_exists';
      email: string;
      userId: string;
    };

/** Validates and normalizes production admin bootstrap variables from the environment. */
export function parseSeedAdminConfig(env: NodeJS.ProcessEnv = process.env): SeedAdminConfig {
  const rawEmail = env['SEED_ADMIN_EMAIL'];
  if (typeof rawEmail !== 'string' || rawEmail.trim().length === 0) {
    throw new Error('SEED_ADMIN_EMAIL is required to seed the initial ADMIN account');
  }

  const email = normalizedEmail(rawEmail);
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error('SEED_ADMIN_EMAIL must be a valid email address');
  }

  const password = env['SEED_ADMIN_PASSWORD'];
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('SEED_ADMIN_PASSWORD is required to seed the initial ADMIN account');
  }
  if (password.length < 8 || password.length > 128) {
    throw new Error('SEED_ADMIN_PASSWORD must be between 8 and 128 characters');
  }

  const rawName = env['SEED_ADMIN_NAME'];
  const name =
    typeof rawName === 'string' && rawName.trim().length > 0
      ? rawName.trim()
      : DEFAULT_SEED_ADMIN_NAME;
  if (name.length < 2 || name.length > 120) {
    throw new Error('SEED_ADMIN_NAME must be between 2 and 120 characters');
  }

  return { email, password, name };
}

/**
 * Idempotently creates the initial ADMIN user from environment variables without touching existing
 * users, roles, or catalog/demo tables. Fails closed if a non-ADMIN account owns that email.
 */
export async function seedProductionAdmin(
  client: Client,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedProductionAdminResult> {
  const config = parseSeedAdminConfig(env);

  try {
    return await client.transaction(async (tx: Transaction) => {
      const matchingUsers = await tx.query(
        client.raw.sql`
          SELECT "id", "email", "role"
          FROM public."user"
          WHERE lower("email") = ${config.email}
          LIMIT 2
        `
          .returnsRow({
            id: 'pg/text@1',
            email: 'pg/text@1',
            role: 'pg/text@1',
          })
          .build(),
      );

      if (matchingUsers.length > 0) {
        const nonAdmin = matchingUsers.find((user) => user.role !== 'ADMIN');
        if (nonAdmin) {
          throw new Error(
            `Cannot seed ADMIN: a non-ADMIN account already exists for ${config.email}`,
          );
        }

        return {
          status: 'skipped',
          reason: 'email_already_exists',
          email: matchingUsers[0].email,
          userId: matchingUsers[0].id,
        };
      }

      const existingAdmins = await tx.query(
        client.raw.sql`
          SELECT "id", "email"
          FROM public."user"
          WHERE "role" = 'ADMIN'
          LIMIT 1
        `
          .returnsRow({
            id: 'pg/text@1',
            email: 'pg/text@1',
          })
          .build(),
      );

      if (existingAdmins.length > 0) {
        return {
          status: 'skipped',
          reason: 'admin_already_exists',
          email: existingAdmins[0].email,
          userId: existingAdmins[0].id,
        };
      }

      const passwordHash = await hashNewPassword(config.password);

      const created = await tx.orm.public.User.create({
        name: config.name,
        email: config.email,
        password: passwordHash,
        role: 'ADMIN',
      });

      return {
        status: 'created',
        email: created.email,
        userId: created.id,
      };
    });
  } catch (error) {
    if (isEmailUniqueViolation(error)) {
      throw new Error(`Cannot seed ADMIN: ${config.email} collided with a concurrent write`);
    }
    throw error;
  }
}
