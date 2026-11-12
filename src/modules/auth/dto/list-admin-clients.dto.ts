import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Max, Min, ValidateIf } from 'class-validator';

const integerQuery = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ListAdminClientsDto {
  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    maximum: 1000000,
    description: '1-based page number',
  })
  @Transform(integerQuery)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page: number = 1;

  @ApiPropertyOptional({
    default: 20,
    minimum: 1,
    maximum: 50,
    description: 'Maximum number of client records per page',
  })
  @Transform(integerQuery)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize: number = 20;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    description:
      'Optional case-insensitive partial match against client name or email (minimum 2 trimmed characters)',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimmed)
  @IsString()
  @Length(2, 100)
  search?: string;
}
