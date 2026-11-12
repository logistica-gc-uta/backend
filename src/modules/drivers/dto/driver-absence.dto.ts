import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

/** Ausencia de un repartidor para un rango cerrado de días operativos (America/Guayaquil). */
export class CreateDriverAbsenceDto {
  @ApiProperty({ example: '2030-02-14', description: 'Primer día ausente (YYYY-MM-DD). Hoy o futuro.' })
  @IsString()
  @Matches(DAY, { message: 'startDate debe ser una fecha YYYY-MM-DD' })
  startDate!: string;

  @ApiProperty({ example: '2030-02-15', description: 'Último día ausente, inclusive (YYYY-MM-DD). Puede ser el mismo día.' })
  @IsString()
  @Matches(DAY, { message: 'endDate debe ser una fecha YYYY-MM-DD' })
  endDate!: string;

  @ApiPropertyOptional({ description: 'Motivo opcional, entre 1 y 300 caracteres', maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  reason?: string;
}

export class CancelDriverAbsenceDto {
  @ApiPropertyOptional({ description: 'Motivo opcional de la anulación, entre 1 y 300 caracteres', maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  reason?: string;
}

export class ListDriverAbsencesQueryDto {
  @ApiPropertyOptional({ example: '2030-02-14', description: 'Solo ausencias que terminan en esta fecha o después. Por defecto, hoy.' })
  @IsOptional()
  @IsString()
  @Matches(DAY, { message: 'from debe ser una fecha YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ description: 'Incluir las ausencias anuladas (por defecto solo las activas)', default: false })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeCancelled?: boolean;
}

export class DriverAvailabilityQueryDto {
  @ApiPropertyOptional({ example: '2030-02-14', description: 'Día operativo a consultar (hoy o futuro). Por defecto, hoy.' })
  @IsOptional()
  @IsString()
  @Matches(DAY, { message: 'date debe ser una fecha YYYY-MM-DD' })
  date?: string;
}

export class AbsenceConflictDto {
  @ApiProperty() routeId!: string;
  @ApiProperty({ enum: ['ASSIGNED', 'IN_PROGRESS'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) date!: string;
  @ApiProperty({ type: [String], description: 'Pedidos de la ruta; se conservan sin cambios' }) orderIds!: string[];
}

export class DriverAbsenceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() driverId!: string;
  @ApiProperty({ example: '2030-02-14' }) startDate!: string;
  @ApiProperty({ example: '2030-02-15' }) endDate!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ enum: ['ACTIVE', 'CANCELLED'] }) status!: string;
  @ApiProperty() createdById!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledById!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({
    type: [AbsenceConflictDto],
    description:
      'Rutas asignadas o en curso del repartidor dentro del rango. Solo informa para que el ADMIN decida: nada se cancela, libera ni reasigna automáticamente.',
  })
  conflicts!: AbsenceConflictDto[];
}
