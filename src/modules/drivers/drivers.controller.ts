import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { ListDriverRoutesQueryDto } from './dto/list-driver-routes-query.dto.js';
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

  @Get('me/routes')
  @Roles(Role.DRIVER)
  @ApiOperation({
    summary: 'Read routes assigned to the authenticated DRIVER',
    description:
      'JWT subject is the sole identity source. Optional date filters Route.date using the America/Guayaquil local day, inclusive start and exclusive next midnight. Orders include all statuses and are ordered by stopOrder, NULL last, then id.',
  })
  @ApiResponse({
    status: 200,
    description: 'Assigned routes; [] when no routes or driver profile exists',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'date', 'zone', 'orders'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          date: { type: 'string', format: 'date-time' },
          zone: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              code: { type: 'string' },
            },
          },
          orders: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                deliveryAddress: { type: 'string' },
                status: {
                  type: 'string',
                  enum: [
                    'PENDING',
                    'ASSIGNED',
                    'IN_TRANSIT',
                    'DELIVERED',
                    'CANCELLED',
                  ],
                },
                scheduledDeliveryDate: {
                  type: 'string',
                  format: 'date-time',
                  nullable: true,
                },
                stopOrder: { type: 'integer', nullable: true },
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid calendar date, repeated date, or unknown query field',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Requires DRIVER role' })
  async findMyRoutes(
    @CurrentUser('userId') userId: string,
    @Query() query: ListDriverRoutesQueryDto,
  ) {
    return this.driversService.findMyRoutes(userId, query.date);
  }

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Listar repartidores con su disponibilidad (Solo ADMIN)',
  })
  @ApiResponse({
    status: 200,
    description: 'Listado de repartidores con su usuario asociado',
  })
  @ApiResponse({ status: 403, description: 'Prohibido: se requiere rol ADMIN' })
  async findAll() {
    return this.driversService.findAll();
  }
}
