import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export enum Role {
  ADMIN = 'ADMIN',
  CLIENT = 'CLIENT',
  DRIVER = 'DRIVER',
}

export class RegisterDto {
  @ApiProperty({ description: 'Nombre completo del usuario', example: 'Carlos Chofer' })
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  @ApiProperty({ description: 'Correo electrónico único', example: 'carlos@delivery.com' })
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  @IsNotEmpty({ message: 'El correo electrónico es obligatorio' })
  email!: string;

  @ApiProperty({ description: 'Contraseña con mínimo 6 caracteres', example: 'claveSegura123', minLength: 6 })
  @IsString({ message: 'La contraseña debe ser una cadena de texto' })
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres' })
  password!: string;

  @ApiPropertyOptional({
    description: 'Rol del usuario en el sistema',
    enum: Role,
    default: Role.CLIENT,
    example: Role.CLIENT,
  })
  @IsOptional()
  @IsEnum(Role, { message: 'El rol debe ser ADMIN, CLIENT o DRIVER' })
  role?: Role;
}

