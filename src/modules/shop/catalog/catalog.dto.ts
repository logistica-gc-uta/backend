import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsString, IsUUID, Length, Matches, Max, Min, ValidateIf } from 'class-validator';

const optional = (_: unknown, value: unknown) => value !== undefined;
const optionalNullable = (_: unknown, value: unknown) => value !== undefined && value !== null;
const integerQuery = ({ value }: { value: unknown }) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
const trimmed = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const MAX_CENTS = Number.MAX_SAFE_INTEGER;

export class PublicCatalogQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @Transform(integerQuery) @IsInt() @Min(1) @Max(2147483647) page = 1;
  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 48 }) @Transform(integerQuery) @IsInt() @Min(1) @Max(48) pageSize = 12;
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 }) @ValidateIf(optional) @Transform(trimmed) @IsString() @Length(1, 100) search?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(optional) @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ minimum: 0 }) @ValidateIf(optional) @Transform(integerQuery) @IsInt() @Min(0) @Max(MAX_CENTS) minPriceCents?: number;
  @ApiPropertyOptional({ minimum: 0 }) @ValidateIf(optional) @Transform(integerQuery) @IsInt() @Min(0) @Max(MAX_CENTS) maxPriceCents?: number;
  @ApiPropertyOptional({ type: Boolean, default: false }) @ValidateIf(optional) @Matches(/^(true|false)$/) inStock?: string;
  @ApiPropertyOptional({ enum: ['featured', 'recent', 'price_asc', 'price_desc', 'best_selling'], default: 'featured' }) @ValidateIf(optional) @IsEnum(['featured', 'recent', 'price_asc', 'price_desc', 'best_selling']) sort?: string;
}

export class AdminCatalogQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @Transform(integerQuery) @IsInt() @Min(1) @Max(2147483647) page = 1;
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 }) @Transform(integerQuery) @IsInt() @Min(1) @Max(50) pageSize = 10;
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 }) @ValidateIf(optional) @Transform(trimmed) @IsString() @Length(1, 100) search?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(optional) @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ enum: ['all', 'published', 'unpublished', 'out_of_stock'], default: 'all' }) @ValidateIf(optional) @IsEnum(['all', 'published', 'unpublished', 'out_of_stock']) status?: string;
}

export class CreateCategoryDto {
  @ApiProperty({ minLength: 2, maxLength: 80 }) @IsString() @Length(2, 80) name!: string;
  @ApiProperty({ minLength: 2, maxLength: 100, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }) @IsString() @Length(2, 100) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300 }) @ValidateIf(optionalNullable) @IsString() @Length(0, 300) description?: string | null;
  @ApiPropertyOptional({ default: true }) @ValidateIf(optional) @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 9999 }) @ValidateIf(optional) @IsInt() @Min(0) @Max(9999) sortOrder?: number;
}
export class PatchCategoryDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 }) @ValidateIf(optional) @IsString() @Length(2, 80) name?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300 }) @ValidateIf(optionalNullable) @IsString() @Length(0, 300) description?: string | null;
  @ApiPropertyOptional() @ValidateIf(optional) @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ minimum: 0, maximum: 9999 }) @ValidateIf(optional) @IsInt() @Min(0) @Max(9999) sortOrder?: number;
}
export class CreateCatalogProductDto {
  @ApiProperty({ minLength: 3, maxLength: 50 }) @IsString() @Length(3, 50) sku!: string;
  @ApiProperty({ minLength: 3, maxLength: 160 }) @IsString() @Length(3, 160) name!: string;
  @ApiProperty({ minLength: 1, maxLength: 2000 }) @IsString() @Length(1, 2000) description!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() categoryId!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(MAX_CENTS) priceCents!: number;
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) stock!: number;
  @ApiPropertyOptional({ default: false }) @ValidateIf(optional) @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional({ default: false }) @ValidateIf(optional) @IsBoolean() isPublished?: boolean;
}
export class PatchCatalogProductDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 160 }) @ValidateIf(optional) @IsString() @Length(3, 160) name?: string;
  @ApiPropertyOptional({ minLength: 1, maxLength: 2000 }) @ValidateIf(optional) @IsString() @Length(1, 2000) description?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(optional) @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ minimum: 1 }) @ValidateIf(optional) @IsInt() @Min(1) @Max(MAX_CENTS) priceCents?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 2147483647 }) @ValidateIf(optional) @IsInt() @Min(0) @Max(2147483647) stock?: number;
  @ApiPropertyOptional() @ValidateIf(optional) @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional() @ValidateIf(optional) @IsBoolean() isPublished?: boolean;
}
export class PublicationDto {
  @ApiProperty() @IsBoolean() isPublished!: boolean;
}
