import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsNotEmpty, IsNumber, IsString, Max, Min, ValidateIf } from 'class-validator';

export class CreateZoneDto {
  @ApiProperty({ description: 'Nombre de la zona de entrega', example: 'Ficoa' })
  @IsString({ message: 'El nombre de la zona debe ser texto' })
  @IsNotEmpty({ message: 'El nombre de la zona es obligatorio' })
  name!: string;

  @ApiProperty({ description: 'Código único identificador de la zona', example: 'FIC-02' })
  @IsString({ message: 'El código de la zona debe ser texto' })
  @IsNotEmpty({ message: 'El código de la zona es obligatorio' })
  code!: string;

  @ApiPropertyOptional({
    description:
      'Latitud geográfica del depósito central [-90, 90]. Opcional; si se proporciona, requiere depotLng como par finito completo.',
    example: -1.24908,
  })
  @ValidateIf((o: CreateZoneDto) => o.depotLat !== undefined || o.depotLng !== undefined)
  @IsDefined({ message: 'La latitud del depósito es obligatoria si se proporciona longitud' })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'La latitud del depósito debe ser un número finito' })
  @Min(-90, { message: 'La latitud del depósito debe ser mayor o igual a -90' })
  @Max(90, { message: 'La latitud del depósito debe ser menor o igual a 90' })
  depotLat?: number;

  @ApiPropertyOptional({
    description:
      'Longitud geográfica del depósito central [-180, 180]. Opcional; si se proporciona, requiere depotLat como par finito completo.',
    example: -78.61675,
  })
  @ValidateIf((o: CreateZoneDto) => o.depotLat !== undefined || o.depotLng !== undefined)
  @IsDefined({ message: 'La longitud del depósito es obligatoria si se proporciona latitud' })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'La longitud del depósito debe ser un número finito' })
  @Min(-180, { message: 'La longitud del depósito debe ser mayor o igual a -180' })
  @Max(180, { message: 'La longitud del depósito debe ser menor o igual a 180' })
  depotLng?: number;
}

