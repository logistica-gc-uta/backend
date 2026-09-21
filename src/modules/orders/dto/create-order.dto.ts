import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsISO8601, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class OrderItemDto {
  @ApiProperty({ description: 'ID del producto a ordenar', example: 'cm789xyz123' })
  @IsString({ message: 'El ID del producto debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El ID del producto es obligatorio' })
  productId!: string;

  @ApiProperty({ description: 'Cantidad del producto solicitada', example: 2, minimum: 1 })
  @IsInt({ message: 'La cantidad debe ser un número entero' })
  @Min(1, { message: 'La cantidad mínima es 1' })
  quantity!: number;
}

export class CreateOrderDto {
  @ApiProperty({ description: 'ID de la zona de entrega', example: 'cm123abc456' })
  @IsString({ message: 'El ID de la zona debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El ID de la zona es obligatorio' })
  zoneId!: string;

  @ApiProperty({
    description: 'Dirección física detallada de entrega',
    example: 'Av. Los Chasquis y Río Guayllabamba, Ambato',
  })
  @IsString({ message: 'La dirección de entrega debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'La dirección de entrega es obligatoria' })
  deliveryAddress!: string;

  @ApiPropertyOptional({
    description: 'Fecha y hora programada para la entrega en formato ISO 8601',
    example: '2026-09-25T14:30:00.000Z',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'La fecha programada debe tener un formato ISO 8601 válido' })
  scheduledDeliveryDate?: string;

  @ApiProperty({ description: 'Lista de productos del pedido', type: () => [OrderItemDto] })
  @IsArray({ message: 'Los items deben ser un arreglo' })
  @ArrayMinSize(1, { message: 'El pedido debe contener al menos un producto' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}

