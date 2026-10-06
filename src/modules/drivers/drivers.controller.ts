import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { DriversService } from './drivers.service.js';

@ApiTags('Drivers')
@ApiBearerAuth('JWT-auth')
@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Listar repartidores con su disponibilidad (Solo ADMIN)' })
  @ApiResponse({ status: 200, description: 'Listado de repartidores con su usuario asociado' })
  @ApiResponse({ status: 403, description: 'Prohibido: se requiere rol ADMIN' })
  async findAll() {
    return this.driversService.findAll();
  }
}
