import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  UseFilters,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { Role } from '../../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { ShopHttpExceptionFilter } from '../shop-http.filter.js';
import { OrderDetailDto } from './dto/order-detail.dto.js';
import { OrderListDto } from './dto/order-summary.dto.js';
import { OrderStatus, ShopOrdersQueryDto } from './dto/orders-query.dto.js';
import { ReceiptDto } from './dto/receipt.dto.js';
import { ShopOrdersService } from './orders.service.js';

@ApiTags('Shop Orders')
@Controller('shop/orders')
@UseFilters(ShopHttpExceptionFilter)
export class OrdersController {
  constructor(private readonly ordersService: ShopOrdersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT)
  @ApiBearerAuth()
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  @ApiOperation({
    summary: 'Historial propio paginado',
    operationId: 'get__shop_orders',
    description:
      'Devuelve el historial paginado de compras del cliente autenticado, con datos y precios históricos inmutables.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, description: 'Número de página' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 10, description: 'Elementos por página' })
  @ApiQuery({ name: 'status', required: false, enum: OrderStatus, description: 'Filtro por estado de pedido' })
  @ApiResponse({ status: 200, description: 'Historial de compras obtenido exitosamente', type: OrderListDto })
  @ApiResponse({ status: 400, description: 'Error de validación en parámetros' })
  @ApiResponse({ status: 401, description: 'Autenticación requerida' })
  @ApiResponse({ status: 403, description: 'Acceso restringido a rol CLIENT' })
  async listOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ShopOrdersQueryDto,
  ): Promise<OrderListDto> {
    return this.ordersService.listOrders(user.userId, query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Detalle completo del pedido propio',
    operationId: 'get__shop_orders__id',
    description:
      'Obtiene el detalle completo de un pedido propio con precios congelados y línea temporal verificada.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'ID del pedido' })
  @ApiResponse({ status: 200, description: 'Detalle de pedido obtenido exitosamente', type: OrderDetailDto })
  @ApiResponse({ status: 400, description: 'ID de pedido no es un UUID válido' })
  @ApiResponse({ status: 401, description: 'Autenticación requerida' })
  @ApiResponse({ status: 403, description: 'Acceso restringido a rol CLIENT' })
  @ApiResponse({ status: 404, description: 'Pedido no encontrado' })
  async getOrderDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<OrderDetailDto> {
    return this.ordersService.getOrderDetail(user.userId, id);
  }

  @Get(':id/receipt')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Comprobante simulado propio y único',
    operationId: 'get__shop_orders__id__receipt',
    description:
      'Obtiene el comprobante de compra simulado inmutable del pedido propio para visualización o impresión HTML.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'ID del pedido' })
  @ApiResponse({ status: 200, description: 'Comprobante de compra obtenido exitosamente', type: ReceiptDto })
  @ApiResponse({ status: 400, description: 'ID de pedido no es un UUID válido' })
  @ApiResponse({ status: 401, description: 'Autenticación requerida' })
  @ApiResponse({ status: 403, description: 'Acceso restringido a rol CLIENT' })
  @ApiResponse({ status: 404, description: 'Pedido o comprobante no encontrado' })
  async getOrderReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ReceiptDto> {
    return this.ordersService.getOrderReceipt(user.userId, id);
  }
}
