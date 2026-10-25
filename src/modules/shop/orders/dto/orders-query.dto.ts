import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum OrderStatus {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

const integerQuery = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export class ShopOrdersQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Número de página (1-based)' })
  @Transform(integerQuery)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  page = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50, description: 'Elementos por página (máx. 50)' })
  @Transform(integerQuery)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize = 10;

  @ApiPropertyOptional({ enum: OrderStatus, description: 'Filtro por estado de pedido' })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}
