import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';

const PASSWORD_VERSION = 'bcrypt-sha256:v1:';
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function fullPasswordDigest(password: string): string {
  // 64 ASCII hex bytes; bcrypt never truncates this digest and every UTF-8 byte contributes.
  return createHash('sha256').update(password, 'utf8').digest('hex');
}

export async function hashNewPassword(password: string): Promise<string> {
  return `${PASSWORD_VERSION}${await bcrypt.hash(fullPasswordDigest(password), 10)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith(PASSWORD_VERSION)) {
    const bcryptHash = stored.slice(PASSWORD_VERSION.length);
    if (!BCRYPT_HASH.test(bcryptHash)) return false;
    return bcrypt.compare(fullPasswordDigest(password), bcryptHash);
  }
  // Unknown/malformed versioned credentials are never retried as legacy raw bcrypt.
  if (stored.includes(':') || !BCRYPT_HASH.test(stored)) return false;
  return bcrypt.compare(password, stored);
}
