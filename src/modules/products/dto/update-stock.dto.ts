import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class UpdateStockDto {
  @ApiProperty({ description: 'Nueva cantidad total de stock disponible', example: 25, minimum: 0 })
  @IsInt({ message: 'El stock debe ser un número entero' })
  @Min(0, { message: 'El stock no puede ser negativo' })
  @Max(2147483647, { message: 'El stock excede el rango soportado' })
  stock!: number;
}

