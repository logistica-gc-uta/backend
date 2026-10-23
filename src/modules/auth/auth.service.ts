import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto, Role } from './dto/register.dto.js';
import { JwtPayload } from './jwt.strategy.js';
import { hashNewPassword, verifyPassword } from './password-hash.util.js';

type CreatedUser = Awaited<ReturnType<PrismaService['user']['create']>>;

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailAlreadyExists(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'El correo electrónico ya se encuentra registrado',
    error: 'Conflict',
    code: 'EMAIL_ALREADY_EXISTS',
  });
}

function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    message: 'Credenciales inválidas',
    error: 'Unauthorized',
    code: 'INVALID_CREDENTIALS',
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

function isEmailUniqueViolation(error: unknown): boolean {
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  private async findNormalizedEmailUsers(email: string) {
    const query = this.prisma.client.raw.sql`
      SELECT "id", "name", "email", "password", "role"
      FROM public."user"
      WHERE lower("email") = ${email}
      LIMIT 2
    `
      .returnsRow({
        id: 'pg/text@1',
        name: 'pg/text@1',
        email: 'pg/text@1',
        password: 'pg/text@1',
        role: 'pg/text@1',
      })
      .build();

    return this.prisma.client.transaction((transaction) =>
      transaction.query(query),
    );
  }

  async register(dto: RegisterDto) {
    const email = normalizedEmail(dto.email);
    const existing = await this.findNormalizedEmailUsers(email);
    if (existing.length > 0) throw emailAlreadyExists();

    const hashedPassword = await hashNewPassword(dto.password);

    let user: CreatedUser;
    try {
      user = await this.prisma.user.create({
        name: dto.name.trim(),
        email,
        password: hashedPassword,
        // Public registration is CLIENT-only; the role is never taken from the caller.
        role: Role.CLIENT,
      });
    } catch (error) {
      if (isEmailUniqueViolation(error)) throw emailAlreadyExists();
      throw error;
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  async login(dto: LoginDto) {
    const matchingUsers = await this.findNormalizedEmailUsers(
      normalizedEmail(dto.email),
    );

    // Case-insensitive legacy matches may collide; never select one arbitrarily.
    if (matchingUsers.length !== 1) throw invalidCredentials();
    const user = matchingUsers[0];

    const isPasswordValid = await verifyPassword(dto.password, user.password);
    if (!isPasswordValid) throw invalidCredentials();

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = this.jwtService.sign(payload);

    return {
      access_token: accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    };
  }
}
