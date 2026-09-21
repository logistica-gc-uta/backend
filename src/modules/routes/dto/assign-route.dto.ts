import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class AssignRouteDto {
  @ApiProperty({ description: 'ID del chofer asignado', example: 'cm_driver_123' })
  @IsString({ message: 'El ID del chofer debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El ID del chofer es obligatorio' })
  driverId!: string;

  @ApiProperty({ description: 'ID de la zona de entrega', example: 'cm_zone_456' })
  @IsString({ message: 'El ID de la zona debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El ID de la zona es obligatorio' })
  zoneId!: string;

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

