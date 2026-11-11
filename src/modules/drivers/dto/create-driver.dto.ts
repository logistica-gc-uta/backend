import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/**
 * Alta ADMIN de un repartidor. Solo estos tres campos: el rol DRIVER, la disponibilidad inicial y la
 * contraseña temporal las decide el servidor; cualquier otro campo (por ejemplo `role`) se rechaza con 400.
 */
export class CreateDriverDto {
  @ApiProperty({ description: 'Nombre recortado, entre 2 y 120 caracteres', example: 'Carlos Chofer', minLength: 2, maxLength: 120 })
  @Transform(trim)
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @Length(2, 120, { message: 'El nombre debe tener entre 2 y 120 caracteres' })
  name!: string;

  @ApiProperty({ description: 'Correo válido, recortado y normalizado a minúsculas; identifica el acceso del repartidor', example: 'carlos@delivery.com', format: 'email' })
  @Transform(trimLower)
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  @IsNotEmpty({ message: 'El correo electrónico es obligatorio' })
  email!: string;

  @ApiProperty({ description: 'Vehículo del repartidor, entre 2 y 120 caracteres', example: 'Camioneta Hilux blanca', minLength: 2, maxLength: 120 })
  @Transform(trim)
  @IsString({ message: 'El vehículo debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El vehículo es obligatorio' })
  @Length(2, 120, { message: 'El vehículo debe tener entre 2 y 120 caracteres' })
  vehicle!: string;
}
