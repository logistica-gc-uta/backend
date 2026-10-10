import { ApiProperty } from '@nestjs/swagger';

export class RouteAssignmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['DRAFT', 'ASSIGNED'] })
  status!: 'DRAFT' | 'ASSIGNED';

  @ApiProperty({ type: String, nullable: true })
  driverId!: string | null;

  @ApiProperty()
  zoneId!: string;

  @ApiProperty({ format: 'date-time' })
  date!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
