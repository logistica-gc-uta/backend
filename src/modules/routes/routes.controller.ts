import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { AssignRouteDto } from './dto/assign-route.dto.js';
import { RoutesService } from './routes.service.js';

@ApiTags('Routes')
@ApiBearerAuth('JWT-auth')
@Controller('routes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Post('assign')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Asignar pedidos a una ruta/repartidor (Regla core: máximo 4 pedidos) (Solo ADMIN)',
    description:
      'Crea una ruta y asocia pedidos en estado PENDING de la misma zona. Si se envían más de 4 pedidos, responde 400 Bad Request.',
  })
  @ApiResponse({ status: 201, description: 'Ruta creada y pedidos asignados exitosamente' })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida: más de 4 pedidos, chofer no disponible o pedidos no PENDING',
  })
  @ApiResponse({ status: 404, description: 'Repartidor, zona o pedido no encontrado' })
  @HttpCode(HttpStatus.CREATED)
  async assign(@Body() dto: AssignRouteDto) {
    return this.routesService.assignRoute(dto);
  }

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Listar todas las rutas creadas con chofer y órdenes (Solo ADMIN)' })
  @ApiResponse({ status: 200, description: 'Listado de rutas' })
  async findAll() {
    return this.routesService.findAll();
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Consultar detalle de una ruta por ID (Solo ADMIN)' })
  @ApiResponse({ status: 200, description: 'Detalle de la ruta' })
  @ApiResponse({ status: 404, description: 'Ruta no encontrada' })
  async findOne(@Param('id') id: string) {
    return this.routesService.findOne(id);
  }
}
