import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsISO8601,
  IsString,
  Matches,
} from 'class-validator';

export class ConfirmDraftRouteDto {
  @ApiProperty()
  @IsString()
  @Matches(/\S/)
  zoneId!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Explicit route instant; every order must be scheduled on the same America/Guayaquil calendar day (a proposal uses its earliest scheduled instant)',
  })
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  routeDate!: string;

  @ApiProperty({ type: [String], minItems: 1, maxItems: 4, uniqueItems: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/\S/, { each: true })
  orderIds!: string[];
}
