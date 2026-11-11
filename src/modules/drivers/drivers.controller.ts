import { RouteHistoryResponseDto } from '../routes/dto/route-history-response.dto.js';
import { DriverAvailabilityResponseDto } from '../routes/dto/driver-availability-response.dto.js';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { ListDriverRoutesQueryDto } from './dto/list-driver-routes-query.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { DriversService } from './drivers.service.js';
import { CreateDriverDto } from './dto/create-driver.dto.js';
import { DriverCreatedResponseDto, DriverProfileResponseDto } from './dto/driver-profile-response.dto.js';
import { UpdateDriverDto } from './dto/update-driver.dto.js';

@ApiTags('Drivers')
@ApiBearerAuth('JWT-auth')
@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get('me/availability')
  @Roles(Role.DRIVER)
  @ApiOperation({
    summary: 'Read effective availability of the authenticated driver',
  })
  @ApiResponse({ status: 200, type: DriverAvailabilityResponseDto })
  @ApiResponse({ status: 404, description: 'Driver profile not found' })
  async findMyAvailability(
    @CurrentUser('userId') userId: string,
  ): Promise<DriverAvailabilityResponseDto> {
    return this.driversService.findMyAvailability(userId);
  }

  @Get('me/routes')
  @Roles(Role.DRIVER)
  @ApiOperation({
    summary: 'Read routes assigned to the authenticated DRIVER',
    description:
      'JWT subject is the sole identity source. Optional date filters Route.date using the America/Guayaquil local day, inclusive start and exclusive next midnight. Historical orders derive stable RouteStop association; current commercial fields are not snapshots. Raw sequence is preserved, NULL last, ties by stop ID.',
  })
  @ApiResponse({
    status: 200,
    description: 'Assigned routes; [] when no routes or driver profile exists',
    type: [RouteHistoryResponseDto],
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

  @Post()
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Registrar un repartidor (solo ADMIN)',
    description:
      'Crea en una sola transacción la identidad DRIVER y su perfil. El rol lo fija el servidor: el cuerpo solo acepta name, email y vehicle. El acceso inicial es una contraseña temporal aleatoria devuelta UNA vez en `temporaryPassword` (no se guarda en claro ni se registra); el ADMIN la entrega en persona. No envía correos.',
  })
  @ApiResponse({ status: 201, type: DriverCreatedResponseDto })
  @ApiResponse({ status: 400, description: 'Campos inválidos o no permitidos (por ejemplo `role`)' })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Prohibido: se requiere rol ADMIN' })
  @ApiResponse({ status: 409, description: 'EMAIL_ALREADY_EXISTS' })
  async create(@Body() dto: CreateDriverDto) {
    return this.driversService.create(dto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Corregir nombre, correo o vehículo de un repartidor (solo ADMIN)',
    description:
      'No modifica el rol, `isAvailable`, rutas ni reservas: editar un perfil no libera a un repartidor ocupado ni reasigna rutas. La baja o desactivación no está definida y no existe.',
  })
  @ApiResponse({ status: 200, type: DriverProfileResponseDto })
  @ApiResponse({ status: 400, description: 'Campos inválidos, no permitidos o ninguno enviado' })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Prohibido: se requiere rol ADMIN' })
  @ApiResponse({ status: 404, description: 'Driver profile not found' })
  @ApiResponse({ status: 409, description: 'EMAIL_ALREADY_EXISTS' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDriverDto) {
    return this.driversService.update(id, dto);
  }
}
