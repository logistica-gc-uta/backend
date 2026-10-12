import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { OrderStatus } from './update-order-status.dto.js';

const integerQuery = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export class ListAdminOrdersDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 1000000 })
  @Transform(integerQuery)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(integerQuery)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @ApiPropertyOptional({ format: 'date', description: 'Scheduled delivery business day in America/Guayaquil (not createdAt)' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  zoneId?: string;

  @ApiPropertyOptional({ enum: OrderStatus })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}
