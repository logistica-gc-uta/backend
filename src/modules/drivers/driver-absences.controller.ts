import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { DriverDayAvailabilityResponseDto } from '../routes/dto/driver-availability-response.dto.js';
import { DriverAbsencesService } from './driver-absences.service.js';
import {
  CancelDriverAbsenceDto,
  CreateDriverAbsenceDto,
  DriverAbsenceResponseDto,
  DriverAvailabilityQueryDto,
  ListDriverAbsencesQueryDto,
} from './dto/driver-absence.dto.js';

/** Ausencias y disponibilidad por fecha de los repartidores. Solo ADMIN (#44). */
@ApiTags('Drivers')
@ApiBearerAuth('JWT-auth')
@Controller('drivers/:driverId')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class DriverAbsencesController {
  constructor(private readonly absences: DriverAbsencesService) {}

  @Post('absences')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Registrar la ausencia de un repartidor (hoy o fechas futuras)',
    description:
      'Rango cerrado [startDate, endDate] de días operativos (America/Guayaquil). Si el repartidor ya tiene rutas asignadas o en curso en el rango, la ausencia se registra igualmente y la respuesta lista esas rutas en `conflicts` para que el ADMIN decida: no se cancela, libera ni reasigna nada. Mientras la ausencia esté activa, el repartidor no es asignable en esos días.',
  })
  @ApiResponse({ status: 201, type: DriverAbsenceResponseDto })
  @ApiResponse({ status: 400, description: 'Fechas inválidas, pasadas o rango invertido (INVALID_DATE, ABSENCE_DATE_IN_PAST, ABSENCE_RANGE_INVALID)' })
  @ApiResponse({ status: 403, description: 'Se requiere rol ADMIN' })
  @ApiResponse({ status: 404, description: 'Driver profile not found' })
  @ApiResponse({ status: 409, description: 'ABSENCE_OVERLAP: ya hay una ausencia activa que se cruza' })
  create(
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @Body() dto: CreateDriverAbsenceDto,
    @CurrentUser('userId') actorId: string,
  ) {
    return this.absences.create(driverId, dto, actorId);
  }

  @Get('absences')
  @ApiOperation({ summary: 'Consultar las ausencias de un repartidor, con las rutas en conflicto' })
  @ApiResponse({ status: 200, type: [DriverAbsenceResponseDto] })
  @ApiResponse({ status: 404, description: 'Driver profile not found' })
  list(@Param('driverId', ParseUUIDPipe) driverId: string, @Query() query: ListDriverAbsencesQueryDto) {
    return this.absences.list(driverId, query);
  }

  @Post('absences/:absenceId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Anular (levantar) una ausencia vigente o futura',
    description:
      'Marca la ausencia como anulada con quién y cuándo. No elimina el registro ni libera reservas operativas pendientes. Una ausencia que ya terminó no se modifica.',
  })
  @ApiResponse({ status: 200, type: DriverAbsenceResponseDto })
  @ApiResponse({ status: 404, description: 'Driver absence not found' })
  @ApiResponse({ status: 409, description: 'ABSENCE_ALREADY_CANCELLED o ABSENCE_ALREADY_ELAPSED' })
  cancel(
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @Param('absenceId', ParseUUIDPipe) absenceId: string,
    @Body() dto: CancelDriverAbsenceDto,
    @CurrentUser('userId') actorId: string,
  ) {
    return this.absences.cancel(driverId, absenceId, dto, actorId);
  }

  @Get('availability')
  @ApiOperation({
    summary: 'Disponibilidad efectiva de un repartidor en un día operativo',
    description:
      'Combina reservas/rutas persistidas, la bandera de compatibilidad y la ausencia de ese día. Una ausencia de otro día no bloquea.',
  })
  @ApiResponse({ status: 200, type: DriverDayAvailabilityResponseDto })
  @ApiResponse({ status: 400, description: 'Fecha inválida o pasada' })
  @ApiResponse({ status: 404, description: 'Driver profile not found' })
  availabilityOn(@Param('driverId', ParseUUIDPipe) driverId: string, @Query() query: DriverAvailabilityQueryDto) {
    return this.absences.availabilityOn(driverId, query.date);
  }
}
