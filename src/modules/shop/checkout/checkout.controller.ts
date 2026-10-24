import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { Role } from '../../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { ShopHttpExceptionFilter } from '../shop-http.filter.js';
import { CheckoutConfirmationService } from './checkout-confirmation.service.js';
import { CheckoutService } from './checkout.service.js';
import { CheckoutRequestDto } from './dto/checkout-request.dto.js';
import { CheckoutSuccessDto } from './dto/checkout-response.dto.js';
import { QuoteRequestDto } from './dto/quote-request.dto.js';
import { QuoteResponseDto } from './dto/quote-response.dto.js';

@ApiTags('Shop Checkout')
@Controller('shop/checkout')
@UseFilters(ShopHttpExceptionFilter)
export class CheckoutController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly confirmationService: CheckoutConfirmationService,
  ) {}

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cotizar sin reservar inventario',
    operationId: 'post__shop_checkout_quote',
    description:
      'Genera una cotización firmada con validez de 15 minutos; vinculada a versión comercial y precios. No reserva inventario.',
  })
  @ApiResponse({
    status: 200,
    description: 'Cotización calculada exitosamente',
    type: QuoteResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Error de validación en request' })
  @ApiResponse({ status: 401, description: 'Autenticación requerida' })
  @ApiResponse({ status: 403, description: 'Acceso restringido a rol CLIENT' })
  @ApiResponse({ status: 404, description: 'Producto o zona no encontrados' })
  @ApiResponse({
    status: 409,
    description: 'Conflicto por producto despublicado o categoría inactiva',
  })
  @ApiResponse({
    status: 422,
    description:
      'Límite de unidades excedido, entrega fuera de horario comercial o ubicación no elegible',
  })
  @ApiResponse({ status: 500, description: 'Error interno de servidor' })
  async quote(
    @CurrentUser() user: { userId: string },
    @Body() dto: QuoteRequestDto,
  ): Promise<QuoteResponseDto> {
    return this.checkoutService.quoteCheckout(user.userId, dto);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Pago ficticio y pedido atómicos',
    operationId: 'post__shop_checkout',
    description:
      'Confirma de forma atómica la compra con tarjeta ficticia en PostgreSQL real bajo control de idempotencia (Idempotency-Key UUIDv4).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'UUID v4 por intención de compra; se debe reutilizar en reintentos del mismo payload.',
    required: true,
  })
  @ApiResponse({
    status: 201,
    description: 'Compra confirmada exitosamente',
    type: CheckoutSuccessDto,
  })
  @ApiResponse({ status: 400, description: 'Error de validación en request o Idempotency-Key inválida' })
  @ApiResponse({ status: 401, description: 'Autenticación requerida' })
  @ApiResponse({ status: 403, description: 'Acceso restringido a rol CLIENT' })
  @ApiResponse({ status: 404, description: 'Producto o zona no encontrados' })
  @ApiResponse({
    status: 409,
    description: 'Conflicto por stock insuficiente, precio modificado, cotización expirada, cambio de configuración o clave reutilizada',
  })
  @ApiResponse({
    status: 422,
    description: 'Tarjeta inválida o expirada, fondos insuficientes, límites excedidos o entrega no elegible',
  })
  @ApiResponse({ status: 503, description: 'Simulador de pagos deshabilitado' })
  @ApiResponse({ status: 500, description: 'Error interno de servidor' })
  async confirm(
    @CurrentUser() user: { userId: string },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CheckoutRequestDto,
  ): Promise<CheckoutSuccessDto> {
    return this.confirmationService.confirmCheckout(user.userId, idempotencyKey, dto);
  }
}
