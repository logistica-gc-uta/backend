import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNotEmptyObject,
  IsNumber,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { EXPLICIT_OFFSET } from '../../../orders/order-delivery.util.js';

export class CheckoutItemDto {
  @ApiProperty({
    example: '11111111-1111-4111-8111-111111111111',
    description: 'Product UUID',
  })
  @IsUUID('all', { message: 'productId must be a valid UUID' })
  readonly productId!: string;

  @ApiProperty({
    example: 2,
    minimum: 1,
    maximum: 100,
    description: 'Requested quantity for this line (positive integer)',
  })
  @IsInt({ message: 'quantity must be an integer' })
  @Min(1, { message: 'quantity must be at least 1' })
  @Max(100, { message: 'quantity cannot exceed 100 per line' })
  readonly quantity!: number;
}

export class RecipientDto {
  @ApiProperty({
    example: 'Ana Regalo',
    minLength: 1,
    maxLength: 120,
    description: 'Full name of recipient',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'recipient name must be a string' })
  @IsNotEmpty({ message: 'recipient name cannot be empty' })
  @MinLength(1, { message: 'recipient name must have at least 1 character' })
  @MaxLength(120, { message: 'recipient name cannot exceed 120 characters' })
  readonly name!: string;

  @ApiProperty({
    example: '0991234567',
    minLength: 7,
    maxLength: 40,
    description: 'Contact phone number of recipient',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'recipient phone must be a string' })
  @IsNotEmpty({ message: 'recipient phone cannot be empty' })
  @MinLength(7, { message: 'recipient phone must have at least 7 characters' })
  @MaxLength(40, { message: 'recipient phone cannot exceed 40 characters' })
  readonly phone!: string;
}

export class GeoPointDto {
  @ApiProperty({
    example: -1.2425,
    minimum: -90,
    maximum: 90,
    description: 'Latitude coordinate',
  })
  @IsNumber({}, { message: 'lat must be a number' })
  @Min(-90, { message: 'lat must be >= -90' })
  @Max(90, { message: 'lat must be <= 90' })
  readonly lat!: number;

  @ApiProperty({
    example: -78.6188,
    minimum: -180,
    maximum: 180,
    description: 'Longitude coordinate',
  })
  @IsNumber({}, { message: 'lng must be a number' })
  @Min(-180, { message: 'lng must be >= -180' })
  @Max(180, { message: 'lng must be <= 180' })
  readonly lng!: number;
}

export class DeliveryDto {
  @ApiProperty({ type: RecipientDto })
  @IsObject({ message: 'recipient must be an object' })
  @IsNotEmptyObject({}, { message: 'recipient cannot be an empty object' })
  @ValidateNested()
  @Type(() => RecipientDto)
  readonly recipient!: RecipientDto;

  @ApiProperty({
    example: '55555555-5555-4555-8555-555555555555',
    description: 'Zone UUID',
  })
  @IsUUID('all', { message: 'zoneId must be a valid UUID' })
  readonly zoneId!: string;

  @ApiProperty({
    example: 'Av. Cevallos y Montalvo, Ambato',
    minLength: 5,
    maxLength: 250,
    description: 'Street address for delivery',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'deliveryAddress must be a string' })
  @MinLength(5, { message: 'deliveryAddress must have at least 5 characters' })
  @MaxLength(250, { message: 'deliveryAddress cannot exceed 250 characters' })
  readonly deliveryAddress!: string;

  @ApiProperty({ type: GeoPointDto })
  @IsObject({ message: 'deliveryLocation must be an object' })
  @IsNotEmptyObject({}, { message: 'deliveryLocation cannot be an empty object' })
  @ValidateNested()
  @Type(() => GeoPointDto)
  readonly deliveryLocation!: GeoPointDto;

  @ApiProperty({
    example: '2026-11-15T10:00:00-05:00',
    description: 'ISO-8601 timestamp with explicit timezone offset',
  })
  @IsString({ message: 'scheduledDeliveryDate must be a string' })
  @Matches(EXPLICIT_OFFSET, {
    message: 'scheduledDeliveryDate must be an ISO instant with explicit offset (Z or +/-HH:mm)',
  })
  readonly scheduledDeliveryDate!: string;

  @ApiPropertyOptional({
    example: 'Entregar en recepcion',
    maxLength: 500,
    description: 'Optional delivery notes',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_, val) => val !== undefined)
  @IsString({ message: 'deliveryNotes must be a string' })
  @MaxLength(500, { message: 'deliveryNotes cannot exceed 500 characters' })
  readonly deliveryNotes?: string;
}

export class QuoteRequestDto {
  @ApiProperty({
    type: [CheckoutItemDto],
    minItems: 1,
    maxItems: 50,
    description: 'Requested product lines (1 to 50)',
  })
  @IsArray({ message: 'items must be an array' })
  @ArrayMinSize(1, { message: 'items must contain at least 1 item' })
  @ArrayMaxSize(50, { message: 'items cannot contain more than 50 items' })
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  readonly items!: CheckoutItemDto[];

  @ApiProperty({ type: DeliveryDto })
  @IsObject({ message: 'delivery must be an object' })
  @IsNotEmptyObject({}, { message: 'delivery cannot be an empty object' })
  @ValidateNested()
  @Type(() => DeliveryDto)
  readonly delivery!: DeliveryDto;
}
