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
  @ApiProperty({ description: 'Bandera de compatibilidad; la disponibilidad real es `effectiveAvailability`.' }) isAvailable!: boolean;
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
