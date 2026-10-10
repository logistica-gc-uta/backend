import { ApiProperty } from '@nestjs/swagger';
import { RouteStatus } from '../route-lifecycle.policy.js';

export class RouteStartResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: [RouteStatus.IN_PROGRESS] })
  status!: RouteStatus.IN_PROGRESS;

  @ApiProperty({ type: String, format: 'date-time' })
  startedAt!: string;
}
