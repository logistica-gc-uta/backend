import { ApiProperty } from '@nestjs/swagger';

export type RouteEmergencyUnitStatus =
  | 'PENDING'
  | 'RECOVERED'
  | 'LOST_PENDING'
  | 'LOST_PREPARED';

export class RouteEmergencyUnitDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  emergencyId!: string;

  @ApiProperty({ format: 'uuid' })
  routeId!: string;

  @ApiProperty({ format: 'uuid' })
  stopId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  orderItemId!: string;

  @ApiProperty({ minimum: 1 })
  unitNumber!: number;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ enum: ['PENDING', 'RECOVERED', 'LOST_PENDING', 'LOST_PREPARED'] })
  status!: RouteEmergencyUnitStatus;

  @ApiProperty()
  resolved!: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  recoveredAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  recoveredById!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  lossId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  replacementPreparedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lossRecoveredAt!: string | null;
}

export class RouteEmergencyCountsDto {
  @ApiProperty()
  totalUnits!: number;

  @ApiProperty()
  recoveredUnits!: number;

  @ApiProperty()
  lostPreparedUnits!: number;

  @ApiProperty()
  lostPendingUnits!: number;

  @ApiProperty()
  pendingUnits!: number;
}

export class RouteEmergencySummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  routeId!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ format: 'date-time' })
  declaredAt!: string;

  @ApiProperty({ format: 'uuid' })
  declaredById!: string;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  closedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  closedById!: string | null;

  @ApiProperty({ type: String, nullable: true })
  closeReason!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  driverId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  returnedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  returnedById!: string | null;

  @ApiProperty({ type: RouteEmergencyCountsDto })
  counts!: RouteEmergencyCountsDto;

  @ApiProperty({ type: [RouteEmergencyUnitDto] })
  pendingUnits!: RouteEmergencyUnitDto[];
}

export class RouteEmergencyDetailDto extends RouteEmergencySummaryDto {
  @ApiProperty({ type: [RouteEmergencyUnitDto] })
  units!: RouteEmergencyUnitDto[];
}
