import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

export enum Role {
  ADMIN = 'ADMIN',
  CLIENT = 'CLIENT',
  DRIVER = 'DRIVER',
}

export class RegisterDto {
  @ApiProperty({
    description: 'Nombre recortado, entre 2 y 120 caracteres',
    example: 'Carlos Chofer',
    minLength: 2,
    maxLength: 120,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @Length(2, 120, { message: 'El nombre debe tener entre 2 y 120 caracteres' })
  name!: string;

  @ApiProperty({
    description: 'Correo electrónico válido, recortado y normalizado a minúsculas',
    example: 'carlos@delivery.com',
    format: 'email',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  @IsNotEmpty({ message: 'El correo electrónico es obligatorio' })
  email!: string;

  @ApiProperty({
    description: 'Contraseña con entre 8 y 128 caracteres',
    example: 'claveSegura123',
    minLength: 8,
    maxLength: 128,
  })
  @IsString({ message: 'La contraseña debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'La contraseña es obligatoria' })
  @Length(8, 128, {
    message: 'La contraseña debe tener entre 8 y 128 caracteres',
  })
  password!: string;
}

