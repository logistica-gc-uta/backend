import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNotEmptyObject,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CheckoutItemDto, DeliveryDto } from './quote-request.dto.js';

export class CardInputDto {
  @ApiProperty({
    example: '9000 0000 0000 0001',
    description: '16-to-19 character simulated card number with digits and spaces (academic demo)',
  })
  @IsString({ message: 'card number must be a string' })
  @IsNotEmpty({ message: 'card number cannot be empty' })
  @Matches(/^[0-9 ]{16,19}$/, {
    message: 'card number must match OpenAPI pattern ^[0-9 ]{16,19}$',
  })
  readonly number!: string;

  @ApiProperty({
    example: 'PRUEBA APROBADA',
    description: 'Name of cardholder',
    minLength: 2,
    maxLength: 100,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'holderName must be a string' })
  @MinLength(2, { message: 'holderName must be at least 2 characters' })
  @MaxLength(100, { message: 'holderName cannot exceed 100 characters' })
  readonly holderName!: string;

  @ApiProperty({
    example: 12,
    minimum: 1,
    maximum: 12,
    description: 'Expiry month (1-12)',
  })
  @IsInt({ message: 'expiresMonth must be an integer' })
  @Min(1, { message: 'expiresMonth must be between 1 and 12' })
  @Max(12, { message: 'expiresMonth must be between 1 and 12' })
  readonly expiresMonth!: number;

  @ApiProperty({
    example: 2030,
    minimum: 2026,
    description: 'Expiry year (>= 2026)',
  })
  @IsInt({ message: 'expiresYear must be an integer' })
  @Min(2026, { message: 'expiresYear must be at least 2026' })
  readonly expiresYear!: number;

  @ApiProperty({
    example: '111',
    description: '3-digit simulated CVV',
  })
  @IsString({ message: 'cvv must be a string' })
  @Matches(/^[0-9]{3}$/, { message: 'cvv must be exactly 3 digits matching ^[0-9]{3}$' })
  readonly cvv!: string;
}

export class CheckoutRequestDto {
  @ApiProperty({
    type: [CheckoutItemDto],
    minItems: 1,
    maxItems: 50,
    description: 'List of product line items with requested quantities (1 to 50)',
  })
  @IsArray({ message: 'items must be an array' })
  @ArrayMinSize(1, { message: 'items must contain at least 1 item' })
  @ArrayMaxSize(50, { message: 'items cannot contain more than 50 items' })
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  readonly items!: CheckoutItemDto[];

  @ApiProperty({
    type: DeliveryDto,
    description: 'Delivery destination, recipient, location and schedule',
  })
  @IsObject({ message: 'delivery must be an object' })
  @IsNotEmptyObject({}, { message: 'delivery cannot be an empty object' })
  @ValidateNested()
  @Type(() => DeliveryDto)
  readonly delivery!: DeliveryDto;

  @ApiProperty({
    type: CardInputDto,
    description: 'Simulated payment card data for demo checkout',
  })
  @IsObject({ message: 'paymentCard must be an object' })
  @IsNotEmptyObject({}, { message: 'paymentCard cannot be an empty object' })
  @ValidateNested()
  @Type(() => CardInputDto)
  readonly paymentCard!: CardInputDto;

  @ApiProperty({
    example: 'eyJhbGciOi...',
    minLength: 10,
    description: 'Cryptographically signed quote token obtained from POST /shop/checkout/quote',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'quoteToken must be a string' })
  @MinLength(10, { message: 'quoteToken must have at least 10 characters' })
  readonly quoteToken!: string;
}
