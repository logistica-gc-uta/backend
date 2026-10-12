import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

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
}
