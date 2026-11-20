import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../database/prisma.service.js';
import { DRIVER_INACTIVE, isDriverInactive } from '../drivers/driver-status.util.js';
import { requireJwtSecret } from '../../config/runtime-config.js';

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
      secretOrKey: requireJwtSecret(),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.where({ id: payload.sub }).first();
    if (!user) {
      throw new UnauthorizedException('Token no válido o usuario inexistente');
    }
    // Una sesión emitida antes de la baja deja de valer en la siguiente petición (#82).
    if (user.role === 'DRIVER' && isDriverInactive(await this.prisma.driver.where({ userId: user.id }).first())) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'La cuenta de repartidor está dada de baja',
        error: 'Unauthorized',
        code: DRIVER_INACTIVE,
      });
    }
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
    };
  }
}
