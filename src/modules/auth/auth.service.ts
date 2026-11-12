import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto, Role } from './dto/register.dto.js';
import { JwtPayload } from './jwt.strategy.js';
import {
  emailAlreadyExists,
  isEmailUniqueViolation,
  normalizedEmail,
} from './email-identity.util.js';
import { hashNewPassword, verifyPassword } from './password-hash.util.js';

type CreatedUser = Awaited<ReturnType<PrismaService['user']['create']>>;

function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    message: 'Credenciales inválidas',
    error: 'Unauthorized',
    code: 'INVALID_CREDENTIALS',
  });
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
