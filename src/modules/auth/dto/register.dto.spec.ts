import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './login.dto.js';
import { RegisterDto } from './register.dto.js';

/**
 * Mirrors the global ValidationPipe options of src/main.ts so the DTO contract
 * is pinned exactly where the HTTP boundary enforces it.
 */
const PIPE_OPTIONS = {
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
};

describe('RegisterDto public contract', () => {
  it('rejects a caller-supplied role as a non-whitelisted property', async () => {
    const dto = plainToInstance(RegisterDto, {
      name: 'Escalated Caller',
      email: 'escalated@example.com',
      password: 'password123',
      role: 'ADMIN',
    });

    const errors = await validate(dto, PIPE_OPTIONS);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('role');
    expect(errors[0].constraints).toHaveProperty('whitelistValidation');
  });

  it('accepts and normalizes the registration fields at their minimum lengths', async () => {
    const dto = plainToInstance(RegisterDto, {
      name: ' AB ',
      email: ' USER@EXAMPLE.COM ',
      password: '12345678',
    });

    expect(await validate(dto, PIPE_OPTIONS)).toEqual([]);
    expect(dto.name).toBe('AB');
    expect(dto.email).toBe('user@example.com');
  });

  it('accepts the registration fields at their maximum lengths', async () => {
    const dto = plainToInstance(RegisterDto, {
      name: 'N'.repeat(120),
      email: 'nuevo@example.com',
      password: 'p'.repeat(128),
    });

    expect(await validate(dto, PIPE_OPTIONS)).toEqual([]);
  });

  it.each([
    { name: 'A', email: 'valid@example.com', password: '12345678' },
    { name: 'N'.repeat(121), email: 'valid@example.com', password: '12345678' },
    { name: 'Valid Name', email: 'not-an-email', password: '12345678' },
    { name: 'Valid Name', email: 'valid@example.com', password: '123456' },
    { name: 'Valid Name', email: 'valid@example.com', password: 'p'.repeat(129) },
  ])('rejects registration values outside the contract: %#', async (input) => {
    const dto = plainToInstance(RegisterDto, input);

    expect(await validate(dto, PIPE_OPTIONS)).not.toEqual([]);
  });

  it('keeps legacy short passwords valid for login DTOs', async () => {
    const dto = plainToInstance(LoginDto, {
      email: ' LEGACY@EXAMPLE.COM ',
      password: 'short',
    });

    expect(await validate(dto, PIPE_OPTIONS)).toEqual([]);
    expect(dto.email).toBe('legacy@example.com');
    expect(dto.password).toBe('short');
  });
});
