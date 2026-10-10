import { ApiProperty } from '@nestjs/swagger';

export class RouteHistoryOrderDto {
  @ApiProperty() id!: string;
  @ApiProperty({
    description: 'Current commercial address; not a historical snapshot',
  })
  deliveryAddress!: string;
  @ApiProperty({
    description: 'Current commercial status; independent of visit outcome',
  })
  status!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Current commercial schedule, not the historical route date',
  })
  scheduledDeliveryDate!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Stable RouteStop.sequence alias; raw legacy positions are preserved',
  })
  stopOrder!: number | null;
}

export class RouteHistoryAttemptDto {
  @ApiProperty() id!: string;
  @ApiProperty() stopId!: string;
  @ApiProperty({ description: 'Persisted driver actor identity' })
  driverId!: string;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
  @ApiProperty({ enum: ['SUCCESSFUL', 'FAILED'] }) outcome!: string;
  @ApiProperty({ type: String, nullable: true }) failureReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) context!: string | null;
}

export class RouteHistoryStopDto {
  @ApiProperty() id!: string;
  @ApiProperty() routeId!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ type: Number, nullable: true }) sequence!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Persisted visit outcome; NULL remains unverified',
  })
  outcome!: string | null;
  @ApiProperty() isLegacy!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  createdAt!: string | null;
  @ApiProperty({ type: [RouteHistoryAttemptDto] })
  attempts!: RouteHistoryAttemptDto[];
}

export class RouteHistoryEventDto {
  @ApiProperty({ enum: ['STARTED', 'COMPLETED', 'RETURNED'] }) kind!: string;
  @ApiProperty() actorId!: string;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
}

export class RouteHistoryZoneDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
}

/** Restricted DRIVER history shape; ADMIN extends the retained relation fields below. */
export class RouteHistoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'date-time' }) date!: string;
  @ApiProperty({ type: RouteHistoryZoneDto }) zone!: RouteHistoryZoneDto;
  @ApiProperty({
    enum: ['UNVERIFIED', 'DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'],
    description: 'UNVERIFIED projects NULL; it is not a persisted enum value',
  })
  status!: string;
  @ApiProperty({
    type: [RouteHistoryOrderDto],
    description:
      'Stable historical order association with CURRENT commercial attributes',
  })
  orders!: RouteHistoryOrderDto[];
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  startedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) startedById!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  completedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) completedById!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  returnedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) returnedById!: string | null;
  @ApiProperty({ type: [RouteHistoryStopDto] }) stops!: RouteHistoryStopDto[];
  @ApiProperty({ type: [RouteHistoryEventDto] })
  events!: RouteHistoryEventDto[];
}

/** ADMIN-only full commercial fields already returned by the existing route service. */
export class AdminRouteHistoryOrderDto extends RouteHistoryOrderDto {
  @ApiProperty() userId!: string;
  @ApiProperty() zoneId!: string;
  @ApiProperty({ type: String, nullable: true }) routeId!: string | null;
  @ApiProperty() total!: number;
  @ApiProperty({ type: Number, nullable: true }) deliveryLat!: number | null;
  @ApiProperty({ type: Number, nullable: true }) deliveryLng!: number | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() requiresAdministrativeReview!: boolean;
}

export class AdminRouteHistoryUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({
    description: 'Existing ADMIN relation field; not exposed in DRIVER history',
  })
  password!: string;
  @ApiProperty({ enum: ['ADMIN', 'CLIENT', 'DRIVER'] }) role!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AdminRouteHistoryDriverDto {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() vehicle!: string;
  @ApiProperty() isAvailable!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: AdminRouteHistoryUserDto })
  user!: AdminRouteHistoryUserDto;
}

export class AdminRouteHistoryZoneDto extends RouteHistoryZoneDto {
  @ApiProperty({ type: Number, nullable: true }) depotLat!: number | null;
  @ApiProperty({ type: Number, nullable: true }) depotLng!: number | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AdminRouteHistoryResponseDto extends RouteHistoryResponseDto {
  @ApiProperty({ type: AdminRouteHistoryZoneDto })
  declare zone: AdminRouteHistoryZoneDto;
  @ApiProperty({
    type: [AdminRouteHistoryOrderDto],
    description:
      'Stable associations with full CURRENT commercial attributes; ADMIN only',
  })
  declare orders: AdminRouteHistoryOrderDto[];
  @ApiProperty({ type: String, nullable: true }) driverId!: string | null;
  @ApiProperty() zoneId!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: AdminRouteHistoryDriverDto, nullable: true })
  driver!: AdminRouteHistoryDriverDto | null;
}
