import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { CheckoutService } from './checkout.service.js';
import { QuoteRequestDto } from './dto/quote-request.dto.js';
import { QuoteResponseDto } from './dto/quote-response.dto.js';

@ApiTags('Shop Checkout')
@Controller('shop/checkout')
@UseFilters(ShopHttpExceptionFilter)
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

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
}
