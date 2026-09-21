import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

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
}
