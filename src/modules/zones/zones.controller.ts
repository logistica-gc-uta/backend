import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateZoneDto } from './dto/create-zone.dto.js';
import { UpdateZoneDto } from './dto/update-zone.dto.js';
import { ZonesService } from './zones.service.js';

@ApiTags('Zones')
@Controller('zones')
export class ZonesController {
  constructor(private readonly zonesService: ZonesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar todas las zonas de entrega' })
  @ApiResponse({ status: 200, description: 'Listado de zonas obtenido correctamente' })
  async findAll() {
    return this.zonesService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener los detalles de una zona por su ID' })
  @ApiParam({ name: 'id', description: 'ID único de la zona', example: 'cm123abc456' })
  @ApiResponse({ status: 200, description: 'Zona obtenida correctamente' })
  @ApiResponse({ status: 404, description: 'Zona no encontrada' })
  async findOne(@Param('id') id: string) {
    return this.zonesService.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Crear una nueva zona de entrega (Solo ADMIN)' })
  @ApiResponse({ status: 201, description: 'Zona creada exitosamente' })
  @ApiResponse({ status: 403, description: 'Prohibido: se requiere rol ADMIN' })
  @ApiResponse({ status: 409, description: 'Nombre o código de zona ya existente' })
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateZoneDto) {
    return this.zonesService.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Actualizar una zona de entrega (Solo ADMIN)' })
  @ApiParam({ name: 'id', description: 'ID de la zona a actualizar', example: 'cm123abc456' })
  @ApiResponse({ status: 200, description: 'Zona actualizada exitosamente' })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos' })
  @ApiResponse({ status: 403, description: 'Prohibido: se requiere rol ADMIN' })
  @ApiResponse({ status: 404, description: 'Zona no encontrada' })
  @ApiResponse({ status: 409, description: 'Conflicto: nombre o código ya existente' })
  async update(@Param('id') id: string, @Body() dto: UpdateZoneDto) {
    return this.zonesService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Eliminar una zona de entrega (Solo ADMIN)' })
  @ApiParam({ name: 'id', description: 'ID de la zona a eliminar', example: 'cm123abc456' })
  @ApiResponse({ status: 200, description: 'Zona eliminada exitosamente' })
  @ApiResponse({ status: 403, description: 'Prohibido: se requiere rol ADMIN' })
  @ApiResponse({ status: 404, description: 'Zona no encontrada' })
  @ApiResponse({ status: 409, description: 'Conflicto: la zona tiene pedidos o rutas asociadas' })
  async remove(@Param('id') id: string) {
    return this.zonesService.remove(id);
  }
}

