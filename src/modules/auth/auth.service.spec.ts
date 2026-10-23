import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../../database/prisma.service.js';
import { AuthService } from './auth.service.js';
import { RegisterDto, Role } from './dto/register.dto.js';

describe('AuthService', () => {
  let service: AuthService;
  let prismaMock: any;
  let jwtMock: any;
  let lookupRows: any[];
  let queryMock: jest.Mock;
  let rawSqlMock: jest.Mock;

  beforeEach(async () => {
    lookupRows = [];
    queryMock = jest.fn(() => Promise.resolve(lookupRows));
    const builder = {
      returnsRow: jest.fn(),
      build: jest.fn(() => ({ kind: 'email-lookup' })),
    };
    builder.returnsRow.mockReturnValue(builder);
    rawSqlMock = jest.fn(() => builder);

    prismaMock = {
      user: {
        create: jest.fn(),
      },
      client: {
        raw: { sql: rawSqlMock },
        transaction: jest.fn(async (callback: any) => callback({ query: queryMock })),
      },
    };

    jwtMock = {
      sign: jest.fn().mockReturnValue('mocked.jwt.token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
        {
          provide: JwtService,
          useValue: jwtMock,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('login', () => {
    const rawPassword = 'password123';
    let hashedPassword: string;

    beforeAll(async () => {
      hashedPassword = await bcrypt.hash(rawPassword, 10);
    });

    it.each([Role.ADMIN, Role.CLIENT, Role.DRIVER])(
      'conserva el login legado de %s y su respuesta allowlist',
      async (role) => {
        const user = {
          id: `user-${role.toLowerCase()}`,
          name: 'Usuario Prueba',
          email: `${role.toLowerCase()}@example.com`,
          password: hashedPassword,
          role,
        };
        lookupRows = [user];

        const result = await service.login({
          email: ` ${user.email.toUpperCase()} `,
          password: rawPassword,
        });

        expect(result).toEqual({
          access_token: 'mocked.jwt.token',
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role,
          },
        });
        expect(Object.keys(result.user).sort()).toEqual([
          'email',
          'id',
          'name',
          'role',
        ]);
        expect(jwtMock.sign).toHaveBeenCalledWith({
          sub: user.id,
          email: user.email,
          role,
        });
      },
    );

    it('mantiene válidos los passwords cortos de cuentas legadas', async () => {
      const legacyPassword = 'short';
      const user = {
        id: 'legacy-user',
        name: 'Cuenta anterior',
        email: 'legacy@example.com',
        password: await bcrypt.hash(legacyPassword, 10),
        role: Role.CLIENT,
      };
      lookupRows = [user];

      await expect(
        service.login({ email: user.email, password: legacyPassword }),
      ).resolves.toMatchObject({ user: { id: user.id, role: Role.CLIENT } });
    });

    it('responde INVALID_CREDENTIALS para cuenta inexistente o password incorrecto', async () => {
      await expect(
        service.login({ email: 'notfound@example.com', password: rawPassword }),
      ).rejects.toMatchObject({
        response: {
          statusCode: 401,
          message: 'Credenciales inválidas',
          error: 'Unauthorized',
          code: 'INVALID_CREDENTIALS',
        },
      });

      lookupRows = [
        {
          id: 'user-client',
          name: 'Cliente',
          email: 'client@example.com',
          password: hashedPassword,
          role: Role.CLIENT,
        },
      ];
      await expect(
        service.login({ email: 'client@example.com', password: 'incorrect' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INVALID_CREDENTIALS' }),
      });
    });

    it('rechaza sin seleccionar arbitrariamente cuentas con emails legacy ambiguos', async () => {
      lookupRows = [
        { id: 'legacy-one', password: hashedPassword },
        { id: 'legacy-two', password: hashedPassword },
      ];

      await expect(
        service.login({ email: 'duplicate@example.com', password: rawPassword }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INVALID_CREDENTIALS' }),
      });
      expect(jwtMock.sign).not.toHaveBeenCalled();
    });
  });

  describe('register', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');

    it('normaliza datos, persiste hash y devuelve únicamente la allowlist CLIENT', async () => {
      prismaMock.user.create.mockImplementation((data: any) =>
        Promise.resolve({ id: 'new-user-id', ...data, createdAt }),
      );

      const result = await service.register({
        name: '  Nuevo Cliente  ',
        email: ' NUEVO@EXAMPLE.COM ',
        password: 'password123',
      });

      const stored = prismaMock.user.create.mock.calls[0][0];
      expect(stored).toMatchObject({
        name: 'Nuevo Cliente',
        email: 'nuevo@example.com',
        role: Role.CLIENT,
      });
      expect(stored.password).not.toBe('password123');
      expect(stored.password).toMatch(/^bcrypt-sha256:v1:\$2[aby]\$10\$/);
      lookupRows = [{ id: 'new-user-id', name: stored.name, email: stored.email, password: stored.password, role: Role.CLIENT }];
      await expect(service.login({ email: stored.email, password: 'password123' })).resolves.toMatchObject({
        user: { id: 'new-user-id', role: Role.CLIENT },
      });
      expect(result).toEqual({
        id: 'new-user-id',
        name: 'Nuevo Cliente',
        email: 'nuevo@example.com',
        role: Role.CLIENT,
        createdAt,
      });
      expect(Object.keys(result).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'name',
        'role',
      ]);
      expect(result).not.toHaveProperty('password');
      expect(prismaMock.client.transaction).toHaveBeenCalledTimes(2);
    });

    it('no autentica un sufijo diferente después de 72 bytes, preserva Unicode y 128 caracteres', async () => {
      prismaMock.user.create.mockImplementation((data: any) =>
        Promise.resolve({ id: 'long-user', ...data, createdAt }),
      );
      const fullPassword = `${'x'.repeat(72)}🔐${'y'.repeat(54)}`; // 128 characters, >72 UTF-8 bytes
      await service.register({ name: 'Long Password', email: 'long@example.com', password: fullPassword });
      const stored = prismaMock.user.create.mock.calls[0][0];
      lookupRows = [{ id: 'long-user', name: stored.name, email: stored.email, password: stored.password, role: Role.CLIENT }];

      await expect(service.login({ email: stored.email, password: fullPassword })).resolves.toMatchObject({
        user: { id: 'long-user' },
      });
      await expect(service.login({ email: stored.email, password: `${'x'.repeat(72)}🔑${'y'.repeat(54)}` }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'INVALID_CREDENTIALS' }) });
    });

    it('persiste siempre CLIENT aunque el objeto interno contenga un rol manipulado', async () => {
      prismaMock.user.create.mockImplementation((data: any) =>
        Promise.resolve({ id: 'new-user-id', ...data, createdAt }),
      );

      const result = await service.register({
        name: 'Escalated Caller',
        email: 'escalated@example.com',
        password: 'password123',
        role: Role.ADMIN,
      } as RegisterDto);

      expect(prismaMock.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ role: Role.CLIENT }),
      );
      expect(result.role).toBe(Role.CLIENT);
    });

    it('rechaza un email ya existente con EMAIL_ALREADY_EXISTS y campos Nest heredados', async () => {
      lookupRows = [{ id: 'existing-user' }];

      await expect(
        service.register({
          name: 'Duplicado',
          email: 'existing@example.com',
          password: 'password123',
        }),
      ).rejects.toMatchObject({
        response: {
          statusCode: 409,
          message: 'El correo electrónico ya se encuentra registrado',
          error: 'Conflict',
          code: 'EMAIL_ALREADY_EXISTS',
        },
      });
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it.each([
      { code: 'P2002', meta: { target: ['email'] } },
      { code: '23505', constraint: 'user_email_key' },
    ])('mapea la violación real del índice único de email durante una carrera', async (details) => {
      const uniqueError = Object.assign(
        new Error('Unique constraint failed'),
        details,
      );
      prismaMock.user.create.mockRejectedValue(uniqueError);

      await expect(
        service.register({
          name: 'Carrera',
          email: 'race@example.com',
          password: 'password123',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          statusCode: 409,
          code: 'EMAIL_ALREADY_EXISTS',
        }),
      });
    });

    it('no transforma errores de DB distintos de la unicidad de email', async () => {
      const databaseError = Object.assign(new Error('Database unavailable'), {
        code: 'P2002',
        meta: { target: ['name'] },
      });
      prismaMock.user.create.mockRejectedValue(databaseError);

      await expect(
        service.register({
          name: 'Error',
          email: 'error@example.com',
          password: 'password123',
        }),
      ).rejects.toBe(databaseError);
    });
  });
});
