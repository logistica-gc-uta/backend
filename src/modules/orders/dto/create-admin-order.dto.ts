import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { Equals, IsDefined, IsIn, IsISO8601, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { CreateOrderDto } from './create-order.dto.js';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
import { EXPLICIT_OFFSET } from '../order-delivery.util.js';

export class AdminBuyerDto {
  @ApiProperty({ enum: ['REGISTERED_CLIENT', 'GUEST'] })
  @IsIn(['REGISTERED_CLIENT', 'GUEST'])
  type!: 'REGISTERED_CLIENT' | 'GUEST';
}

export class RegisteredClientBuyerDto extends AdminBuyerDto {
  @ApiProperty({ enum: ['REGISTERED_CLIENT'] })
  @Equals('REGISTERED_CLIENT')
  declare type: 'REGISTERED_CLIENT';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @ApiProperty({ maxLength: 40, description: 'Mandatory buyer phone; never read from User' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  contactPhone!: string;
}

export class GuestBuyerDto extends AdminBuyerDto {
  @ApiProperty({ enum: ['GUEST'] })
  @Equals('GUEST')
  declare type: 'GUEST';

  @ApiProperty({ maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ maxLength: 40, description: 'Mandatory guest buyer phone; does not create or link an account' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  contactPhone!: string;
}

export class GiftRecipientDto {
  @ApiProperty({ maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ maxLength: 40 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  contactPhone!: string;
}

export class AdminDeclaredPaymentDto {
  @ApiProperty({ enum: ['CASH', 'TRANSFER'] })
  @IsIn(['CASH', 'TRANSFER'])
  method!: 'CASH' | 'TRANSFER';

  @ApiPropertyOptional({ maxLength: 200, description: 'Optional note; not a bank reference' })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  note?: string;
}

@ApiExtraModels(RegisteredClientBuyerDto, GuestBuyerDto)
export class CreateAdminOrderDto extends OmitType(CreateOrderDto, ['scheduledDeliveryDate', 'deliveryLat', 'deliveryLng'] as const) {
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(RegisteredClientBuyerDto) },
      { $ref: getSchemaPath(GuestBuyerDto) },
    ],
    discriminator: { propertyName: 'type', mapping: {
      REGISTERED_CLIENT: getSchemaPath(RegisteredClientBuyerDto),
      GUEST: getSchemaPath(GuestBuyerDto),
    } },
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminBuyerDto, { discriminator: { property: 'type', subTypes: [
    { name: 'REGISTERED_CLIENT', value: RegisteredClientBuyerDto },
    { name: 'GUEST', value: GuestBuyerDto },
  ] }, keepDiscriminatorProperty: true })
  buyer!: RegisteredClientBuyerDto | GuestBuyerDto;

  @ApiPropertyOptional({ type: GiftRecipientDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => GiftRecipientDto)
  giftRecipient?: GiftRecipientDto;

  @ApiProperty({ type: AdminDeclaredPaymentDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminDeclaredPaymentDto)
  payment!: AdminDeclaredPaymentDto;

  @ApiProperty({ format: 'date-time', description: 'Scheduled instant with explicit UTC offset' })
  @IsISO8601({ strict: true })
  @Matches(EXPLICIT_OFFSET)
  scheduledDeliveryDate!: string;

  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  deliveryLat!: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  deliveryLng!: number;

  @ApiPropertyOptional({ format: 'date-time', description: 'Optional paired window, same Guayaquil day as schedule' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(EXPLICIT_OFFSET)
  deliveryWindowStart?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Optional paired window end, strictly after start' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(EXPLICIT_OFFSET)
  deliveryWindowEnd?: string;
}
