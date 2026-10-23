import bcrypt from 'bcryptjs';
import { hashNewPassword, verifyPassword } from './password-hash.util.js';

describe('versioned password verification', () => {
  it('uses all UTF-8 bytes before bcrypt, including suffixes after byte 72', async () => {
    const password = `${'a'.repeat(72)}🔐${'b'.repeat(54)}`;
    const hash = await hashNewPassword(password);
    expect(hash).toMatch(/^bcrypt-sha256:v1:\$2[aby]\$10\$/);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(`${'a'.repeat(72)}🔑${'b'.repeat(54)}`, hash)).toBe(false);
  });

  it('keeps raw bcrypt credentials for existing accounts', async () => {
    const hash = await bcrypt.hash('short', 10);
    expect(await verifyPassword('short', hash)).toBe(true);
    expect(await verifyPassword('different', hash)).toBe(false);
  });

  it.each([
    'bcrypt-sha256:v1:',
    'bcrypt-sha256:v1:not-a-bcrypt-hash',
    'bcrypt-sha256:v2:$2b$10$.....................................................',
    'unknown:v1:$2b$10$.....................................................',
    'invalid',
  ])('rejects unknown or malformed versioned hashes without falling back: %s', async (stored) => {
    expect(await verifyPassword('password', stored)).toBe(false);
  });
});
