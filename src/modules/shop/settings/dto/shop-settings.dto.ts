import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmptyObject,
  IsObject,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class ShippingDto {
  @ApiProperty({ enum: ['FREE_INCLUDED'], example: 'FREE_INCLUDED' })
  readonly status = 'FREE_INCLUDED' as const;

  @ApiProperty({ example: 0, default: 0 })
  readonly amountCents: number = 0;

  @ApiProperty({ example: true, default: true })
  readonly includedInPrices: boolean = true;
}

export class ShopSettingsTaxDto {
  @ApiProperty({ example: 'SIMULATED', default: 'SIMULATED' })
  readonly mode = 'SIMULATED' as const;

  @ApiProperty({ example: true })
  readonly enabled!: boolean;

  @ApiProperty({ example: 1500, minimum: 0, maximum: 10000 })
  readonly rateBps!: number;

  @ApiProperty({ example: 15, minimum: 0, maximum: 100 })
  readonly ratePercent!: number;
}

export class ShopLimitsDto {
  @ApiProperty({ example: 10, minimum: 1, maximum: 100 })
  readonly maxUnitsPerSkuPerOrder!: number;
}

export class DeliveryScheduleDto {
  @ApiProperty({ example: 'America/Guayaquil', default: 'America/Guayaquil' })
  readonly timeZone = 'America/Guayaquil' as const;

  @ApiProperty({ example: '07:00' })
  readonly startTime!: string;

  @ApiProperty({ example: '17:00' })
  readonly endTime!: string;

  @ApiProperty({ example: true, default: true })
  readonly boundariesInclusive: boolean = true;
}

export class ShopSettingsPublicDto {
  @ApiProperty({ example: 1, minimum: 1 })
  readonly version!: number;

  @ApiProperty({ example: 'USD', default: 'USD' })
  readonly currency = 'USD' as const;

  @ApiProperty({ type: ShippingDto })
  readonly shipping!: ShippingDto;

  @ApiProperty({ type: ShopSettingsTaxDto })
  readonly tax!: ShopSettingsTaxDto;

  @ApiProperty({ type: ShopLimitsDto })
  readonly limits!: ShopLimitsDto;

  @ApiProperty({ type: DeliveryScheduleDto })
  readonly deliverySchedule!: DeliveryScheduleDto;

  @ApiProperty({ example: '2026-10-23T12:00:00.000Z' })
  readonly updatedAt!: string;
}

export class ShopSettingsAdminDto extends ShopSettingsPublicDto {
  @ApiProperty({
    example: 'a0000000-0000-4000-8000-000000000001',
    nullable: true,
    type: 'string',
  })
  readonly updatedById!: string | null;

  @ApiProperty({ example: '2026-10-23T12:00:00.000Z' })
  readonly createdAt!: string;
}

export class ShopSettingsTaxPatchDto {
  @ApiPropertyOptional({ example: true })
  @ValidateIf((_, val) => val !== undefined)
  @IsBoolean()
  readonly enabled?: boolean;

  @ApiPropertyOptional({ example: 1500, minimum: 0, maximum: 10000 })
  @ValidateIf((_, val) => val !== undefined)
  @IsInt()
  @Min(0)
  @Max(10000)
  readonly rateBps?: number;
}

export class ShopLimitsPatchDto {
  @ApiProperty({ example: 10, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  readonly maxUnitsPerSkuPerOrder!: number;
}

export class DeliverySchedulePatchDto {
  @ApiPropertyOptional({ example: '07:00', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' })
  @ValidateIf((_, val) => val !== undefined)
  @IsString()
  @Matches(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
  readonly startTime?: string;

  @ApiPropertyOptional({ example: '17:00', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' })
  @ValidateIf((_, val) => val !== undefined)
  @IsString()
  @Matches(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
  readonly endTime?: string;
}

export class ShopSettingsPatchDto {
  @ApiProperty({ example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  readonly expectedVersion!: number;

  @ApiPropertyOptional({ type: ShopSettingsTaxPatchDto })
  @ValidateIf((_, val) => val !== undefined)
  @IsObject()
  @ValidateNested()
  @IsNotEmptyObject()
  @Type(() => ShopSettingsTaxPatchDto)
  readonly tax?: ShopSettingsTaxPatchDto;

  @ApiPropertyOptional({ type: ShopLimitsPatchDto })
  @ValidateIf((_, val) => val !== undefined)
  @IsObject()
  @ValidateNested()
  @IsNotEmptyObject()
  @Type(() => ShopLimitsPatchDto)
  readonly limits?: ShopLimitsPatchDto;

  @ApiPropertyOptional({ type: DeliverySchedulePatchDto })
  @ValidateIf((_, val) => val !== undefined)
  @IsObject()
  @ValidateNested()
  @IsNotEmptyObject()
  @Type(() => DeliverySchedulePatchDto)
  readonly deliverySchedule?: DeliverySchedulePatchDto;
}
