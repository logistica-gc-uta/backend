import { ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class AssignRouteDto {
  @IsString({ message: 'El ID del chofer debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El ID del chofer es obligatorio' })
  driverId!: string;

  @IsString({ message: 'El ID de la zona debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El ID de la zona es obligatorio' })
  zoneId!: string;

  @IsArray({ message: 'La lista de pedidos debe ser un arreglo' })
  @ArrayMinSize(1, { message: 'Debe incluir al menos un pedido' })
  @IsString({ each: true, message: 'Cada ID de pedido debe ser una cadena de texto' })
  orderIds!: string[];
}
