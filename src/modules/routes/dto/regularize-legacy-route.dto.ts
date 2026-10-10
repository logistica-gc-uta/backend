import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

export class RegularizeLegacyRouteDto {
  @ApiProperty({
    maxLength: 500,
    pattern: '\\S',
    description: 'Required nonblank administrative reason',
  })
  @IsString()
  @Matches(/\S/)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({
    maxLength: 2000,
    pattern: '\\S',
    description: 'Required nonblank legacy audit evidence',
  })
  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  evidence!: string;
}
