import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

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

  @ApiPropertyOptional({
    description:
      'Latitud geográfica de entrega [-90, 90] seleccionada por el usuario. Opcional; si se proporciona, requiere deliveryLng como par finito completo.',
    example: -1.24908,
  })
  @ValidateIf((o: CreateOrderDto) => o.deliveryLat !== undefined || o.deliveryLng !== undefined)
  @IsDefined({ message: 'La latitud de entrega es obligatoria si se proporciona longitud' })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'La latitud de entrega debe ser un número finito' })
  @Min(-90, { message: 'La latitud de entrega debe ser mayor o igual a -90' })
  @Max(90, { message: 'La latitud de entrega debe ser menor o igual a 90' })
  deliveryLat?: number;

  @ApiPropertyOptional({
    description:
      'Longitud geográfica de entrega [-180, 180] seleccionada por el usuario. Opcional; si se proporciona, requiere deliveryLat como par finito completo.',
    example: -78.61675,
  })
  @ValidateIf((o: CreateOrderDto) => o.deliveryLat !== undefined || o.deliveryLng !== undefined)
  @IsDefined({ message: 'La longitud de entrega es obligatoria si se proporciona latitud' })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'La longitud de entrega debe ser un número finito' })
  @Min(-180, { message: 'La longitud de entrega debe ser mayor o igual a -180' })
  @Max(180, { message: 'La longitud de entrega debe ser menor o igual a 180' })
  deliveryLng?: number;

  @ApiProperty({ description: 'Lista de productos del pedido', type: () => [OrderItemDto] })
  @IsArray({ message: 'Los items deben ser un arreglo' })
  @ArrayMinSize(1, { message: 'El pedido debe contener al menos un producto' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}
