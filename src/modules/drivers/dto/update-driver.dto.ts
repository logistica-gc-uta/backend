import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/**
 * Corrección ADMIN de un perfil. Solo nombre, correo y vehículo. El rol, la disponibilidad, las rutas y
 * las reservas no se pueden modificar desde aquí. Al menos un campo es obligatorio (lo valida el servicio).
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
}
