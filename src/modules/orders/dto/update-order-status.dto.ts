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
    description:
      'Nuevo estado del pedido según el grafo de ciclo de vida (ADMIN solo CANCELLED; DRIVER sujeto a ruta activa)',
    enum: OrderStatus,
    example: OrderStatus.CANCELLED,
  })
  @IsNotEmpty({ message: 'El estado es obligatorio' })
  @IsEnum(OrderStatus, {
    message: 'El estado debe ser PENDING, ASSIGNED, IN_TRANSIT, DELIVERED o CANCELLED',
  })
  status!: OrderStatus;
}
