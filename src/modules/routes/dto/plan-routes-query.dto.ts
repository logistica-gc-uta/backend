import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class PlanRoutesQueryDto {
  @ApiProperty({
    description:
      'Calendar day to plan (America/Guayaquil): proposes routes for the PENDING orders scheduled that day',
    example: '2030-02-14',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @ApiPropertyOptional({
    description: 'Restrict the proposal to a single zone',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @ApiPropertyOptional({
    description:
      'Include the road trace of every proposal for the map. Only meaningful when the road engine is active; it asks the engine once per proposal',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  includeGeometry?: boolean;
}
