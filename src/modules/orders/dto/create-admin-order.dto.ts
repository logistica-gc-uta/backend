import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { Equals, IsDefined, IsIn, IsISO8601, IsNotEmpty, IsNumber, IsObject, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { CreateOrderDto } from './create-order.dto.js';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
import { EXPLICIT_OFFSET } from '../order-delivery.util.js';

// Unknown discriminator values resolve to this base and fail closed.
export class AdminRecipientDto {
  @ApiProperty({ enum: ['REGISTERED_CLIENT', 'GUEST'] })
  @IsIn(['REGISTERED_CLIENT', 'GUEST'])
  type!: 'REGISTERED_CLIENT' | 'GUEST';
}

export class RegisteredClientRecipientDto extends AdminRecipientDto {
  @ApiProperty({ enum: ['REGISTERED_CLIENT'] })
  @Equals('REGISTERED_CLIENT')
  declare type: 'REGISTERED_CLIENT';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @ApiPropertyOptional({ maxLength: 40, description: 'Delivery contact, trimmed only; not an authentication identifier' })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  contactPhone?: string;
}

export class GuestRecipientDto extends AdminRecipientDto {
  @ApiProperty({ enum: ['GUEST'] })
  @Equals('GUEST')
  declare type: 'GUEST';

  @ApiProperty({ maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ maxLength: 40, description: 'Delivery contact, trimmed only; no account is created' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  contactPhone!: string;
}

@ApiExtraModels(RegisteredClientRecipientDto, GuestRecipientDto)
export class CreateAdminOrderDto extends OmitType(CreateOrderDto, ['scheduledDeliveryDate', 'deliveryLat', 'deliveryLng'] as const) {
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(RegisteredClientRecipientDto) },
      { $ref: getSchemaPath(GuestRecipientDto) },
    ],
    discriminator: { propertyName: 'type', mapping: {
      REGISTERED_CLIENT: getSchemaPath(RegisteredClientRecipientDto),
      GUEST: getSchemaPath(GuestRecipientDto),
    } },
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminRecipientDto, { discriminator: { property: 'type', subTypes: [
    { name: 'REGISTERED_CLIENT', value: RegisteredClientRecipientDto },
    { name: 'GUEST', value: GuestRecipientDto },
  ] }, keepDiscriminatorProperty: true })
  recipient!: RegisteredClientRecipientDto | GuestRecipientDto;

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
