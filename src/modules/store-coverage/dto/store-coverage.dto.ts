import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsArray,
  IsDefined,
  IsNumber,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class GeoPointDto {
  @ApiProperty({ description: 'WGS84 latitude', example: -1.24908, minimum: -90, maximum: 90 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ description: 'WGS84 longitude', example: -78.61675, minimum: -180, maximum: 180 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng!: number;
}

export class CoveragePolygonDto {
  @ApiProperty({ enum: ['Polygon'] })
  @Equals('Polygon')
  type!: 'Polygon';

  @ApiProperty({
    description:
      'GeoJSON Polygon coordinates: one closed exterior ring of [longitude, latitude] positions. No holes.',
    example: [
      [
        [-78.63, -1.27],
        [-78.6, -1.27],
        [-78.6, -1.23],
        [-78.63, -1.23],
        [-78.63, -1.27],
      ],
    ],
  })
  @IsArray()
  coordinates!: unknown;
}

export class UpsertStoreCoverageDto {
  @ApiProperty({ type: GeoPointDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => GeoPointDto)
  location!: GeoPointDto;

  @ApiProperty({ type: CoveragePolygonDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => CoveragePolygonDto)
  coverage!: CoveragePolygonDto;
}

export class EvaluateCoverageDto extends GeoPointDto {}

export class StoreCoverageConfiguredDto {
  @ApiProperty({ enum: [true] })
  configured!: true;

  @ApiProperty({ type: GeoPointDto })
  location!: GeoPointDto;

  @ApiProperty({ type: CoveragePolygonDto })
  coverage!: CoveragePolygonDto;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  updatedById!: string | null;
}

export class StoreCoverageUnconfiguredDto {
  @ApiProperty({ enum: [false] })
  configured!: false;
}

export class EvaluateCoverageResponseDto {
  @ApiProperty()
  accepted!: boolean;

  @ApiProperty({ enum: ['INTERIOR', 'BOUNDARY', 'EXTERIOR'] })
  position!: 'INTERIOR' | 'BOUNDARY' | 'EXTERIOR';
}
