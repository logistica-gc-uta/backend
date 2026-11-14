import { parseSeedAdminConfig, seedProductionAdmin } from '../src/prisma/prod-admin-seed.js';
import { verifyPassword } from '../src/modules/auth/password-hash.util.js';

type FakeUserRow = {
  id: string;
  name: string;
  email: string;
  password: string;
  role: 'ADMIN' | 'CLIENT' | 'DRIVER';
};

function createFakeClient(initialUsers: FakeUserRow[] = []) {
  const users = [...initialUsers];
  const createdCalls: Array<{ name: string; email: string; password: string; role: string }> = [];

  const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
    returnsRow: () => ({
      build: () => ({ strings, values }),
    }),
    build: () => ({ strings, values }),
  });

  const tx = {
    query: async (plan: { strings: TemplateStringsArray; values: unknown[] }) => {
      const sql = plan.strings.join('?');
      if (sql.includes('lower("email")')) {
        const targetEmail = String(plan.values[0]).toLowerCase();
        return users
          .filter((u) => u.email.toLowerCase() === targetEmail)
          .slice(0, 2)
          .map((u) => ({ id: u.id, email: u.email, role: u.role }));
      }
      if (sql.includes('"role" = \'ADMIN\'')) {
        return users
          .filter((u) => u.role === 'ADMIN')
          .slice(0, 1)
          .map((u) => ({ id: u.id, email: u.email }));
      }
      throw new Error(`Unexpected query in fake client: ${sql}`);
    },
    orm: {
      public: {
        User: {
          create: async (input: { name: string; email: string; password: string; role: 'ADMIN' }) => {
            createdCalls.push(input);
            const row: FakeUserRow = {
              id: `user-${users.length + 1}`,
              ...input,
            };
            users.push(row);
            return row;
          },
        },
      },
    },
  };

  const client = {
    raw: { sql: sqlTag },
    transaction: async <T>(fn: (transaction: typeof tx) => Promise<T>): Promise<T> => fn(tx),
  };

  return { client, users, createdCalls };
}

describe('parseSeedAdminConfig', () => {
  it('normalizes email, defaults name, and preserves password characters', () => {
    const config = parseSeedAdminConfig({
      SEED_ADMIN_EMAIL: '  Admin@Regalia.EC  ',
      SEED_ADMIN_PASSWORD: '  StrongPass#2026  ',
    });

    expect(config).toEqual({
      email: 'admin@regalia.ec',
      password: '  StrongPass#2026  ',
      name: 'Administrator',
    });
  });

  it('accepts custom trimmed SEED_ADMIN_NAME', () => {
    const config = parseSeedAdminConfig({
      SEED_ADMIN_EMAIL: 'boss@regalia.ec',
      SEED_ADMIN_PASSWORD: 'StrongPassword123',
      SEED_ADMIN_NAME: '  Stephania Admin  ',
    });

    expect(config.name).toBe('Stephania Admin');
  });

  it.each([
    ['missing email', { SEED_ADMIN_PASSWORD: 'StrongPassword123' }, /SEED_ADMIN_EMAIL/],
    ['invalid email', { SEED_ADMIN_EMAIL: 'not-an-email', SEED_ADMIN_PASSWORD: 'StrongPassword123' }, /SEED_ADMIN_EMAIL/],
    ['missing password', { SEED_ADMIN_EMAIL: 'admin@regalia.ec' }, /SEED_ADMIN_PASSWORD/],
    ['short password', { SEED_ADMIN_EMAIL: 'admin@regalia.ec', SEED_ADMIN_PASSWORD: 'short' }, /8/],
    [
      'overlong password',
      { SEED_ADMIN_EMAIL: 'admin@regalia.ec', SEED_ADMIN_PASSWORD: 'x'.repeat(129) },
      /128/,
    ],
    [
      'too short name',
      { SEED_ADMIN_EMAIL: 'admin@regalia.ec', SEED_ADMIN_PASSWORD: 'StrongPassword123', SEED_ADMIN_NAME: 'A' },
      /SEED_ADMIN_NAME/,
    ],
  ])('rejects %s', (_label, env, pattern) => {
    expect(() => parseSeedAdminConfig(env)).toThrow(pattern);
  });
});

describe('seedProductionAdmin', () => {
  it('creates an ADMIN with a verifiable password hash when no admin exists', async () => {
    const { client, users, createdCalls } = createFakeClient();

    const result = await seedProductionAdmin(client as never, {
      SEED_ADMIN_EMAIL: 'Admin@Regalia.EC',
      SEED_ADMIN_PASSWORD: 'ProductionSecret#2026',
      SEED_ADMIN_NAME: 'Super Admin',
    });

    expect(result).toEqual({
      status: 'created',
      email: 'admin@regalia.ec',
      userId: 'user-1',
    });
    expect(createdCalls).toHaveLength(1);
    expect(createdCalls[0].role).toBe('ADMIN');
    expect(createdCalls[0].email).toBe('admin@regalia.ec');
    expect(createdCalls[0].name).toBe('Super Admin');
    expect(createdCalls[0].password).toMatch(/^bcrypt-sha256:v1:/);
    await expect(verifyPassword('ProductionSecret#2026', users[0].password)).resolves.toBe(true);
  });

  it('is idempotent when the same ADMIN email already exists (case-insensitive)', async () => {
    const { client, createdCalls } = createFakeClient([
      {
        id: 'existing-admin',
        name: 'Original Admin',
        email: 'admin@regalia.ec',
        password: 'already-hashed-password',
        role: 'ADMIN',
      },
    ]);

    const result = await seedProductionAdmin(client as never, {
      SEED_ADMIN_EMAIL: 'ADMIN@regalia.ec',
      SEED_ADMIN_PASSWORD: 'AnotherPassword123',
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'email_already_exists',
      email: 'admin@regalia.ec',
      userId: 'existing-admin',
    });
    expect(createdCalls).toHaveLength(0);
  });

  it('is idempotent when a different ADMIN already exists', async () => {
    const { client, createdCalls } = createFakeClient([
      {
        id: 'first-admin',
        name: 'First Admin',
        email: 'first@regalia.ec',
        password: 'hashed-password',
        role: 'ADMIN',
      },
    ]);

    const result = await seedProductionAdmin(client as never, {
      SEED_ADMIN_EMAIL: 'second@regalia.ec',
      SEED_ADMIN_PASSWORD: 'ProductionSecret#2026',
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'admin_already_exists',
      email: 'first@regalia.ec',
      userId: 'first-admin',
    });
    expect(createdCalls).toHaveLength(0);
  });

  it('fails closed when a non-ADMIN account already uses SEED_ADMIN_EMAIL', async () => {
    const { client, createdCalls } = createFakeClient([
      {
        id: 'client-1',
        name: 'Client User',
        email: 'user@regalia.ec',
        password: 'hashed-password',
        role: 'CLIENT',
      },
    ]);

    await expect(
      seedProductionAdmin(client as never, {
        SEED_ADMIN_EMAIL: 'User@Regalia.ec',
        SEED_ADMIN_PASSWORD: 'ProductionSecret#2026',
      }),
    ).rejects.toThrow(/non-ADMIN/i);
    expect(createdCalls).toHaveLength(0);
  });
});
