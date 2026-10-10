import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class AssignDraftRouteDto {
  @ApiProperty()
  @IsString()
  @Matches(/\S/)
  driverId!: string;
}
