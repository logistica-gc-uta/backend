import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminClientsController } from './admin-clients.controller.js';
import { AdminClientsService } from './admin-clients.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { JwtStrategy } from './jwt.strategy.js';
import { requireJwtSecret } from '../../config/runtime-config.js';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      // Sin secreto de respaldo: el valor sale de la configuración validada (#53).
      useFactory: () => ({
        secret: requireJwtSecret(),
        signOptions: {
          expiresIn: (process.env.JWT_EXPIRES_IN || '24h') as any,
        },
      }),
    }),
  ],
  controllers: [AuthController, AdminClientsController],
  providers: [
    AuthService,
    AdminClientsService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [
    AuthService,
    AdminClientsService,
    JwtModule,
    PassportModule,
    JwtAuthGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
