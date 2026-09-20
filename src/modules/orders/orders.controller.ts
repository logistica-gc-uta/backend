import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
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
  @ApiOperation({ summary: 'Crear un pedido con reserva de inventario (Solo CLIENT)' })
  @ApiResponse({ status: 201, description: 'Pedido creado exitosamente con estado PENDING' })
  @ApiResponse({ status: 400, description: 'Stock insuficiente para alguno de los productos' })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.ordersService.createOrder(userId, dto);
  }

  @Get('my-orders')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Listar historial de pedidos del cliente autenticado (Solo CLIENT)' })
  @ApiResponse({ status: 200, description: 'Historial de pedidos con items y zona' })
  async findMyOrders(@CurrentUser('userId') userId: string) {
    return this.ordersService.findMyOrders(userId);
  }

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Listado global de todos los pedidos (Solo ADMIN)' })
  @ApiResponse({ status: 200, description: 'Listado completo de pedidos' })
  async findAll() {
    return this.ordersService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar detalle de un pedido por ID' })
  @ApiResponse({ status: 200, description: 'Detalle del pedido' })
  @ApiResponse({ status: 404, description: 'Pedido no encontrado' })
  async findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Patch(':id/status')
  @Roles(Role.DRIVER, Role.ADMIN)
  @ApiOperation({ summary: 'Actualizar estado del pedido (IN_TRANSIT, DELIVERED, CANCELLED) (DRIVER/ADMIN)' })
  @ApiResponse({ status: 200, description: 'Estado actualizado correctamente' })
  @ApiResponse({ status: 400, description: 'El repartidor no puede modificar pedidos en estado PENDING' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.updateStatus(id, dto, user);
  }
}
