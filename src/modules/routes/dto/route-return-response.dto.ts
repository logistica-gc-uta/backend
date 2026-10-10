import { DriverAvailabilityResponseDto } from './driver-availability-response.dto.js';
import { ApiProperty } from '@nestjs/swagger';

export class RouteReturnResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['COMPLETED'] })
  status!: 'COMPLETED';

  @ApiProperty({ type: DriverAvailabilityResponseDto })
  availability!: DriverAvailabilityResponseDto;

  @ApiProperty({ type: String, format: 'date-time' })
  returnedAt!: string;
}
