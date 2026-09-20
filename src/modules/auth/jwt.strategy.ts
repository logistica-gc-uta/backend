import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../database/prisma.service.js';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'uta_logistica_jwt_secret_key_2026_super_secure',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.where({ id: payload.sub }).first();
    if (!user) {
      throw new UnauthorizedException('Token no válido o usuario inexistente');
    }
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
    };
  }
}
