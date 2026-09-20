import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { AssignRouteDto } from './dto/assign-route.dto.js';
import { RoutesService } from './routes.service.js';

@Controller('routes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Post('assign')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async assign(@Body() dto: AssignRouteDto) {
    return this.routesService.assignRoute(dto);
  }

  @Get()
  @Roles(Role.ADMIN)
  async findAll() {
    return this.routesService.findAll();
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  async findOne(@Param('id') id: string) {
    return this.routesService.findOne(id);
  }
}
