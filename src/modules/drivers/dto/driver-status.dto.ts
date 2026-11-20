import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Cuerpo de la baja y de la reactivación de un repartidor (#82). El actor sale siempre del JWT. */
export class ChangeDriverStatusDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 500, description: 'Motivo operativo del cambio, visible en el historial.' })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 500)
  reason?: string;
}

/** Una baja o reactivación del historial append-only de un repartidor. */
export class DriverStatusChangeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'true: reactivación; false: baja.' }) active!: boolean;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty() actorId!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
