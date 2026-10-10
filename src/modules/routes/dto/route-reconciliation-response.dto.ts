import { ApiProperty } from '@nestjs/swagger';
import { DriverAvailabilityResponseDto } from './driver-availability-response.dto.js';

export class LegacyReconciliationAuditDto {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'uuid' }) routeId!: string;
  @ApiProperty() administratorId!: string;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({
    type: 'object',
    properties: { evidence: { type: 'string' } },
    required: ['evidence'],
  })
  evidence!: { evidence: string };
  @ApiProperty({ enum: [true] }) releaseDriverHold!: true;
}

export class RouteReconciliationResponseDto {
  @ApiProperty({ type: LegacyReconciliationAuditDto })
  audit!: LegacyReconciliationAuditDto;
  @ApiProperty({
    type: DriverAvailabilityResponseDto,
    nullable: true,
    description: 'Null when the historical route has no driver',
  })
  availability!: DriverAvailabilityResponseDto | null;
}
