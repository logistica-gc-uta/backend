import { ApiProperty } from '@nestjs/swagger';

export class RouteAssignmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['DRAFT', 'ASSIGNED'] })
  status!: 'DRAFT' | 'ASSIGNED';

  @ApiProperty({ type: String, nullable: true })
  driverId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  zoneId!: string | null;

  @ApiProperty({ format: 'date-time' })
  date!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
