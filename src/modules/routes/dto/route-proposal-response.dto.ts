import { ApiProperty } from '@nestjs/swagger';

export class GeoPointDto {
  @ApiProperty({ example: -1.24908 })
  lat!: number;

  @ApiProperty({ example: -78.61675 })
  lng!: number;
}

export class RouteProposalStopDto {
  @ApiProperty({ description: 'Visit position, starting at 1', example: 1 })
  sequence!: number;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ type: GeoPointDto })
  location!: GeoPointDto;

  @ApiProperty({
    format: 'date-time',
    description: 'Exact scheduled delivery instant of the order',
  })
  scheduledDeliveryDate!: string;
}

export class RouteProposalDto {
  @ApiProperty({ format: 'uuid' })
  zoneId!: string;

  @ApiProperty({ example: 'CEN-01' })
  zoneCode!: string;

  @ApiProperty({ type: GeoPointDto, description: 'Depot where the route starts and ends' })
  depot!: GeoPointDto;

  @ApiProperty({
    type: [String],
    maxItems: 4,
    description: 'Order ids in visiting order (1 to 4)',
  })
  orderIds!: string[];

  @ApiProperty({ type: [RouteProposalStopDto] })
  stops!: RouteProposalStopDto[];

  @ApiProperty({
    description:
      'Round trip depot -> stops -> depot in kilometres, rounded to 3 decimals',
    example: 4.213,
  })
  totalDistanceKm!: number;

  @ApiProperty({
    type: [String],
    description:
      'Distinct scheduled instants among the orders of this proposal, in chronological order',
  })
  scheduledInstants!: string[];

  @ApiProperty({
    format: 'date-time',
    description:
      'Earliest scheduled instant of the proposal. Send it as routeDate to POST /routes: any instant of the same America/Guayaquil business day as all its orders is accepted',
  })
  routeDate!: string;
}

export class ExcludedOrderDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  zoneId!: string;

  @ApiProperty({
    type: [String],
    description:
      'Why the order was not planned: geographic readiness reasons, ACTIVE_ROUTE_CLAIM or ADMINISTRATIVE_REVIEW_REQUIRED',
    example: ['MISSING_DELIVERY_COORDINATES'],
  })
  reasons!: string[];
}

export class RouteProposalSummaryDto {
  @ApiProperty() candidateOrders!: number;
  @ApiProperty() plannedOrders!: number;
  @ApiProperty() excludedOrders!: number;
  @ApiProperty() routes!: number;
}

export class RouteProposalResponseDto {
  @ApiProperty({ example: '2030-02-14' })
  date!: string;

  @ApiProperty({ example: 'America/Guayaquil' })
  timeZone!: string;

  @ApiProperty({ example: 4 })
  capacity!: number;

  @ApiProperty({
    example: 'HAVERSINE_STRAIGHT_LINE',
    description:
      'Distances are straight-line (Haversine), not road distance; traffic, closures and travel time are not modelled',
  })
  distanceMethod!: string;

  @ApiProperty({ type: [RouteProposalDto] })
  proposals!: RouteProposalDto[];

  @ApiProperty({ type: [ExcludedOrderDto] })
  excluded!: ExcludedOrderDto[];

  @ApiProperty({ type: RouteProposalSummaryDto })
  summary!: RouteProposalSummaryDto;
}
