import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Min } from 'class-validator';

export class CreateProductDto {
  @ApiProperty({ description: 'Nombre comercial del producto', example: 'Laptop HP Pavilion 15' })
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Descripción detallada del producto',
    example: 'Laptop para trabajo y estudio con 16GB RAM y SSD 512GB',
  })
  @IsOptional()
  @IsString({ message: 'La descripción debe ser una cadena de texto' })
  description?: string;

  @ApiProperty({ description: 'Precio unitario en USD', example: 750.0, minimum: 0.01 })
  @IsNumber({}, { message: 'El precio debe ser un número válido' })
  @IsPositive({ message: 'El precio debe ser mayor a 0' })
  price!: number;

  @ApiProperty({ description: 'Cantidad disponible en inventario', example: 15, minimum: 0 })
  @IsInt({ message: 'El stock debe ser un número entero' })
  @Min(0, { message: 'El stock no puede ser negativo' })
  stock!: number;
}

