import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../../database/prisma.service.js';
import { AuthService } from './auth.service.js';
import { Role } from './dto/register.dto.js';

describe('AuthService', () => {
  let service: AuthService;
  let prismaMock: any;
  let jwtMock: any;

  beforeEach(async () => {
    prismaMock = {
      user: {
        where: jest.fn(),
        create: jest.fn(),
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

    it('Caso 1: Login exitoso con credenciales correctas', async () => {
      const mockUser = {
        id: 'user-uuid-1',
        name: 'Usuario Prueba',
        email: 'test@example.com',
        password: hashedPassword,
        role: Role.CLIENT,
      };

      prismaMock.user.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(mockUser),
      });

      const result = await service.login({
        email: 'test@example.com',
        password: rawPassword,
      });

      expect(result).toBeDefined();
      expect(result.access_token).toBe('mocked.jwt.token');
      expect(result.user).toEqual({
        id: mockUser.id,
        name: mockUser.name,
        email: mockUser.email,
        role: mockUser.role,
      });
      expect(jwtMock.sign).toHaveBeenCalledWith({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });
    });

    it('Caso 2: Rechazo con UnauthorizedException para contraseñas inválidas', async () => {
      const mockUser = {
        id: 'user-uuid-1',
        name: 'Usuario Prueba',
        email: 'test@example.com',
        password: hashedPassword,
        role: Role.CLIENT,
      };

      prismaMock.user.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(mockUser),
      });

      await expect(
        service.login({
          email: 'test@example.com',
          password: 'wrong_password',
        }),
      ).rejects.toThrow(new UnauthorizedException('Credenciales inválidas'));
    });

    it('Caso 2 (variante): Rechazo con UnauthorizedException si el usuario no existe', async () => {
      prismaMock.user.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.login({
          email: 'notfound@example.com',
          password: 'somepassword',
        }),
      ).rejects.toThrow(new UnauthorizedException('Credenciales inválidas'));
    });
  });

  describe('register', () => {
    it('debe registrar exitosamente un nuevo usuario', async () => {
      prismaMock.user.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      prismaMock.user.create.mockImplementation((data: any) =>
        Promise.resolve({
          id: 'new-user-id',
          ...data,
          createdAt: new Date(),
        }),
      );

      const result = await service.register({
        name: 'Nuevo Cliente',
        email: 'nuevo@example.com',
        password: 'password123',
        role: Role.CLIENT,
      });

      expect(result).toBeDefined();
      expect(result.id).toBe('new-user-id');
      expect(result.email).toBe('nuevo@example.com');
      expect((result as any).password).toBeUndefined();
    });

    it('debe lanzar ConflictException si el email ya existe', async () => {
      prismaMock.user.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'existing', email: 'existing@example.com' }),
      });

      await expect(
        service.register({
          name: 'Duplicado',
          email: 'existing@example.com',
          password: 'password123',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
