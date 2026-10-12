import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { CreateAdminOrderDto } from './dto/create-admin-order.dto.js';
import { ListAdminOrdersDto } from './dto/list-admin-orders.dto.js';
import {
  AdminOrdersPageDto,
  OrderCreatedResponseDto,
  OrderResponseDto,
} from './dto/order-response.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { OrdersService } from './orders.service.js';

@ApiTags('Orders')
@ApiBearerAuth('JWT-auth')
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @Roles(Role.CLIENT)
  @ApiOperation({
    summary: 'Crear un pedido con reserva de inventario (Solo CLIENT)',
  })
  @ApiResponse({
    status: 201,
    description:
      'Pedido creado exitosamente con estado PENDING y persistencia escalar de coordenadas',
    type: OrderCreatedResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Stock insuficiente para alguno de los productos o coordenadas inválidas',
  })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.ordersService.createOrder(userId, dto);
  }

  @Post('admin')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a delivery for a registered CLIENT or GUEST (ADMIN)' })
  @ApiResponse({ status: 201, type: OrderCreatedResponseDto, description: 'Created with JWT creator and recipient snapshot' })
  @ApiResponse({ status: 400, description: 'Invalid recipient, location, schedule/window or insufficient stock' })
  @ApiResponse({ status: 401, description: 'JWT required' })
  @ApiResponse({ status: 403, description: 'ADMIN role required' })
  @ApiResponse({ status: 404, description: 'Registered client, zone or product not found' })
  @HttpCode(HttpStatus.CREATED)
  async createAdmin(@CurrentUser('userId') actorId: string, @Body() dto: CreateAdminOrderDto) {
    return this.ordersService.createAdminOrder(actorId, dto);
  }

  @Get('my-orders')
  @Roles(Role.CLIENT)
  @ApiOperation({
    summary:
      'Listar historial de pedidos del cliente autenticado (Solo CLIENT)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Historial de pedidos con items, zona enriquecida, deliveryLocation y preparación geográfica',
    type: [OrderResponseDto],
  })
  async findMyOrders(@CurrentUser('userId') userId: string) {
    return this.ordersService.findMyOrders(userId);
  }

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Listado global de todos los pedidos (Solo ADMIN)' })
  @ApiResponse({
    status: 200,
    description:
      'Paginated ADMIN envelope; scheduled Guayaquil date, zone and status filters; ascending scheduled date/id, NULL dates last',
    type: AdminOrdersPageDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid filters or pagination bounds' })
  @ApiResponse({ status: 401, description: 'JWT required' })
  @ApiResponse({ status: 403, description: 'ADMIN role required' })
  async findAll(@Query() dto: ListAdminOrdersDto = new ListAdminOrdersDto()) {
    return this.ordersService.findAll(dto);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Consultar detalle de un pedido por ID (CLIENT propio, DRIVER asignado a ruta, ADMIN global)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Detalle del pedido con items, zona enriquecida, deliveryLocation y preparación geográfica',
    type: OrderResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Acceso denegado: no autorizado para consultar este pedido',
  })
  @ApiResponse({ status: 404, description: 'Pedido no encontrado' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.findOne(id, user);
  }

  @Patch(':id/status')
  @Roles(Role.DRIVER, Role.ADMIN)
  @ApiOperation({
    summary:
      'Update order status: DRIVER active-visit progress; ADMIN cancellation without operational history',
  })
  @ApiResponse({
    status: 200,
    description: 'Estado actualizado correctamente',
    type: OrderCreatedResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Transición inválida o asignación no permitida en este endpoint',
  })
  @ApiResponse({
    status: 403,
    description:
      'Access denied: unauthorized role, missing driver profile or route ownership',
  })
  @ApiResponse({ status: 404, description: 'Pedido no encontrado' })
  @ApiResponse({
    status: 409,
    description: 'Conflicto por modificación concurrente del pedido',
  })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.updateStatus(id, dto, user);
  }
}
