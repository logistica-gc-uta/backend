import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty } from 'class-validator';

export enum OrderStatus {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

export class UpdateOrderStatusDto {
  @ApiProperty({
    description: 'Nuevo estado del pedido',
    enum: OrderStatus,
    example: OrderStatus.IN_TRANSIT,
  })
  @IsNotEmpty({ message: 'El estado es obligatorio' })
  @IsEnum(OrderStatus, {
    message: 'El estado debe ser PENDING, ASSIGNED, IN_TRANSIT, DELIVERED o CANCELLED',
  })
  status!: OrderStatus;
}

