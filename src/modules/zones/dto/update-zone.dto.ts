import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsNumber, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';

export class UpdateZoneDto {
  @ApiPropertyOptional({
    description: 'Nombre de la zona de entrega',
    example: 'Centro Histórico',
  })
  @IsOptional()
  @IsString({ message: 'El nombre de la zona debe ser texto' })
  name?: string;

  @ApiPropertyOptional({
    description: 'Código único de la zona',
    example: 'CEN-01',
  })
  @IsOptional()
  @IsString({ message: 'El código de la zona debe ser texto' })
  code?: string;

  @ApiPropertyOptional({
    description:
      'Latitud geográfica del depósito central [-90, 90]. Omitir preserva coordenadas existentes; si se envía, requiere depotLng para reemplazo atómico.',
    example: -1.24908,
  })
  @ValidateIf((o: UpdateZoneDto) => o.depotLat !== undefined || o.depotLng !== undefined)
  @IsDefined({ message: 'La latitud del depósito es obligatoria si se proporciona longitud' })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'La latitud del depósito debe ser un número finito' })
  @Min(-90, { message: 'La latitud del depósito debe ser mayor o igual a -90' })
  @Max(90, { message: 'La latitud del depósito debe ser menor o igual a 90' })
  depotLat?: number;

  @ApiPropertyOptional({
    description:
      'Longitud geográfica del depósito central [-180, 180]. Omitir preserva coordenadas existentes; si se envía, requiere depotLat para reemplazo atómico.',
    example: -78.61675,
  })
  @ValidateIf((o: UpdateZoneDto) => o.depotLat !== undefined || o.depotLng !== undefined)
  @IsDefined({ message: 'La longitud del depósito es obligatoria si se proporciona latitud' })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'La longitud del depósito debe ser un número finito' })
  @Min(-180, { message: 'La longitud del depósito debe ser mayor o igual a -180' })
  @Max(180, { message: 'La longitud del depósito debe ser menor o igual a 180' })
  depotLng?: number;
}
