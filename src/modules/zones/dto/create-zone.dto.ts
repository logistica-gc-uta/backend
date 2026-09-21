import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateZoneDto {
  @ApiProperty({ description: 'Nombre de la zona de entrega', example: 'Ficoa' })
  @IsString({ message: 'El nombre de la zona debe ser texto' })
  @IsNotEmpty({ message: 'El nombre de la zona es obligatorio' })
  name!: string;

  @ApiProperty({ description: 'Código único identificador de la zona', example: 'FIC-02' })
  @IsString({ message: 'El código de la zona debe ser texto' })
  @IsNotEmpty({ message: 'El código de la zona es obligatorio' })
  code!: string;
}

