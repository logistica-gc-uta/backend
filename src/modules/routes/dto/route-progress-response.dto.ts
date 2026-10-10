import { ApiProperty } from '@nestjs/swagger';
import { FailedVisitReason } from './record-failed-visit.dto.js';

export class VisitAttemptResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) stopId: string;
  @ApiProperty() driverId: string;
  @ApiProperty({ format: 'date-time' }) recordedAt: string;
  @ApiProperty({ enum: ['FAILED'] }) outcome: 'FAILED';
  @ApiProperty({ enum: FailedVisitReason }) failureReason: FailedVisitReason;
  @ApiProperty({ type: String }) context: string;
  @ApiProperty({ format: 'uuid' }) requestId: string;
}

export class RouteCompletionResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ['COMPLETED'] }) status: 'COMPLETED';
  @ApiProperty({ format: 'date-time' }) completedAt: string;
}
