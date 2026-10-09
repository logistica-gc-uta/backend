import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, ValidateIf } from 'class-validator';

export class ListDriverRoutesQueryDto {
  @ApiPropertyOptional({
    description:
      'Route calendar day in America/Guayaquil (not the order scheduled date)',
    example: '2024-02-29',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}
