import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';

export class AssignRouteDto {
  @ApiProperty({ description: 'ID del chofer asignado', example: 'cm_driver_123' })
  @IsString({ message: 'El ID del chofer debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El ID del chofer es obligatorio' })
  driverId!: string;

  @ApiPropertyOptional({
    description: 'Optional delivery zone ID (null for store-coverage routes without zones)',
    format: 'uuid',
    nullable: true,
    example: 'cm_zone_456',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: 'El ID de la zona debe ser una cadena de texto' })
  @Matches(/\S/, { message: 'El ID de la zona debe ser una cadena no vacía' })
  zoneId?: string | null;

  @ApiProperty({
    description: 'Lista de IDs de pedidos asignados (máximo 4 pedidos)',
    example: ['cm_order_1', 'cm_order_2'],
    type: [String],
  })
  @IsArray({ message: 'La lista de pedidos debe ser un arreglo' })
  @ArrayMinSize(1, { message: 'Debe incluir al menos un pedido' })
  @ArrayMaxSize(4, { message: 'No se pueden asignar más de 4 pedidos a una ruta' })
  @IsString({ each: true, message: 'Cada ID de pedido debe ser una cadena de texto' })
  orderIds!: string[];
}

