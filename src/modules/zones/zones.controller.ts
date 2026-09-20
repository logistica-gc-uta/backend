import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateZoneDto } from './dto/create-zone.dto.js';
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
}
