import { ConflictException } from '@nestjs/common';

/** Reglas de identidad por correo compartidas por el registro público y la gestión ADMIN de repartidores. */
export function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailAlreadyExists(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'El correo electrónico ya se encuentra registrado',
    error: 'Conflict',
    code: 'EMAIL_ALREADY_EXISTS',
  });
}

function isEmailConstraint(target: unknown): boolean {
  const values = Array.isArray(target) ? target : [target];
  return values.some(
    (value) =>
      typeof value === 'string' &&
      /(^|[^a-z0-9])email([^a-z0-9]|$)/i.test(value),
  );
}

export function isEmailUniqueViolation(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  for (let index = 0; index < pending.length; index += 1) {
    const candidate = pending[index];
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    const record = candidate as Record<string, unknown>;
    const meta =
      record.meta && typeof record.meta === 'object'
        ? (record.meta as Record<string, unknown>)
        : undefined;
    const target =
      meta?.target ??
      record.constraint ??
      record.constraint_name ??
      record.constraintName ??
      record.message;
    const isUniqueError = record.code === 'P2002' || record.code === '23505';

    if (isUniqueError && isEmailConstraint(target)) return true;

    pending.push(record.cause, record.originalError);
  }

  return false;
}
