import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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

  it('accepts the documented public registration payload', async () => {
    const dto = plainToInstance(RegisterDto, {
      name: 'Nuevo Cliente',
      email: 'nuevo@example.com',
      password: 'password123',
    });

    expect(await validate(dto, PIPE_OPTIONS)).toEqual([]);
  });
});
