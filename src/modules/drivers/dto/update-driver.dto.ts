import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Length, Max, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const MAX_VEHICLE_CAPACITY = 2_147_483_647;

/**
 * Corrección ADMIN de un perfil. Solo nombre, correo, vehículo y capacidad. El rol, la disponibilidad, las
 * rutas y las reservas no se pueden modificar desde aquí. Al menos un campo es obligatorio (lo valida el servicio).
 */
export class UpdateDriverDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 120, example: 'Carlos Chofer' })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El nombre no puede estar vacío' })
  @Length(2, 120, { message: 'El nombre debe tener entre 2 y 120 caracteres' })
  name?: string;

  @ApiPropertyOptional({ format: 'email', example: 'carlos@delivery.com' })
  @IsOptional()
  @Transform(trimLower)
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email?: string;

  @ApiPropertyOptional({ minLength: 2, maxLength: 120, example: 'Camioneta Hilux blanca' })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'El vehículo debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El vehículo no puede estar vacío' })
  @Length(2, 120, { message: 'El vehículo debe tener entre 2 y 120 caracteres' })
  vehicle?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_VEHICLE_CAPACITY,
    example: 6,
    description: 'Capacidad del vehículo en unidades de productos (entero positivo). Omitirla la conserva sin cambios; enviar null la limpia.',
  })
  @IsOptional()
  @IsInt({ message: 'La capacidad del vehículo debe ser un número entero' })
  @Min(1, { message: 'La capacidad del vehículo debe ser al menos 1' })
  @Max(MAX_VEHICLE_CAPACITY, { message: 'La capacidad del vehículo supera el máximo permitido' })
  vehicleCapacity?: number | null;
}
