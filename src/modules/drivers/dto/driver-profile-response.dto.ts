import { ApiProperty } from '@nestjs/swagger';
import { DriverAvailabilityResponseDto } from '../../routes/dto/driver-availability-response.dto.js';

export class DriverUserSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty({ enum: ['DRIVER'] }) role!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

/** Perfil de repartidor tal como lo consumen web y Flutter. Nunca incluye hashes ni secretos. */
export class DriverProfileResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() vehicle!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 2_147_483_647,
    description: 'Capacidad configurada del vehículo en unidades de productos, o null cuando no está definida.',
  })
  vehicleCapacity!: number | null;
  @ApiProperty({ description: 'Bandera de compatibilidad; la disponibilidad real es `effectiveAvailability`.' }) isAvailable!: boolean;
  @ApiProperty({
    description:
      'Estado administrativo (#82): false si el repartidor está dado de baja (no inicia sesión ni recibe asignaciones). Distinto de `isAvailable` y de las ausencias.',
  })
  isActive!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Último cambio de estado (baja o reactivación), o null si nunca cambió.' })
  statusChangedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) statusChangedById!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Motivo del último cambio de estado.' }) statusReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: DriverUserSummaryDto }) user!: DriverUserSummaryDto;
  @ApiProperty({ type: DriverAvailabilityResponseDto }) effectiveAvailability!: DriverAvailabilityResponseDto;
}

export class DriverCreatedResponseDto extends DriverProfileResponseDto {
  @ApiProperty({
    description:
      'Contraseña temporal generada por el servidor. Se muestra UNA sola vez en esta respuesta (no se guarda en claro ni se registra) para que el ADMIN la entregue en persona. No se puede recuperar después.',
  })
  temporaryPassword!: string;
}
