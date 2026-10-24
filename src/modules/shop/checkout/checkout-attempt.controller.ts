import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { Role } from '../../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { ShopHttpExceptionFilter } from '../shop-http.filter.js';
import { CheckoutAttemptService } from './checkout-attempt.service.js';
import { CheckoutAttemptStatusDto } from './dto/checkout-attempt-status.dto.js';

@ApiTags('Shop Checkout')
@Controller('shop/checkout-attempts')
@UseFilters(ShopHttpExceptionFilter)
export class CheckoutAttemptController {
  constructor(private readonly attemptService: CheckoutAttemptService) {}

  @Get(':idempotencyKey')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Consultar estado seguro del intento',
    operationId: 'get__shop_checkout_attempts__idempotencyKey',
    description:
      'Consulta el estado de un intento de checkout idempotente por clave. Requiere rol CLIENT dueño. Clave inexistente o ajena retorna 404 indistinguible.',
  })
  @ApiParam({
    name: 'idempotencyKey',
    type: 'string',
    format: 'uuid',
    description: 'Clave de idempotencia UUIDv4 enviada originalmente en el header Idempotency-Key',
  })
  @ApiResponse({
    status: 200,
    description: 'Estado seguro del intento',
    type: CheckoutAttemptStatusDto,
  })
  @ApiResponse({ status: 400, description: 'Idempotency key no es UUIDv4 válido' })
  @ApiResponse({ status: 401, description: 'Autenticación requerida' })
  @ApiResponse({ status: 403, description: 'Acceso restringido a rol CLIENT' })
  @ApiResponse({ status: 404, description: 'Intento de checkout no encontrado' })
  async getAttemptStatus(
    @CurrentUser() user: { userId: string; role: Role },
    @Param('idempotencyKey') idempotencyKey: string,
  ): Promise<CheckoutAttemptStatusDto> {
    return this.attemptService.getAttemptStatus(user.userId, idempotencyKey);
  }
}
