import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PLANNING_EXCLUSION_REASONS, type PlanningExclusionReason } from '../planning-exclusion-reason.js';

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
    description:
      'Delivery address of the order, so the stop can be shown without requesting each order separately (ADMIN only)',
    example: 'Av. Los Chasquis y Río Guayllabamba, Ambato',
  })
  deliveryAddress!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Exact scheduled delivery instant of the order',
  })
  scheduledDeliveryDate!: string;

  @ApiPropertyOptional({
    description: 'Road distance in km from the previous point (the depot for the first stop). Only with the road engine (#47)',
    example: 1.482,
  })
  legDistanceKm?: number;

  @ApiPropertyOptional({
    description: 'Estimated travel time in seconds from the previous point (the depot for the first stop). Only with the road engine; no live traffic, not an ETA',
    example: 214,
  })
  legDurationSeconds?: number;
}

/** Trazado vial de una propuesta para dibujarlo en el mapa (solo con el motor vial y `includeGeometry=true`). */
export class RoadGeometryDto {
  @ApiProperty({ enum: ['LineString'] })
  type!: 'LineString';

  @ApiProperty({ description: 'GeoJSON coordinates [lng, lat] in visiting order: depot -> stops -> depot', type: 'array', items: { type: 'array', items: { type: 'number' } } })
  coordinates!: [number, number][];
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
      'Round trip depot -> stops -> depot in kilometres, rounded to 3 decimals. With the road engine it is the road distance, measured in the real direction of each leg; otherwise a straight line',
    example: 4.213,
  })
  totalDistanceKm!: number;

  @ApiPropertyOptional({
    description: 'Straight-line (Haversine) kilometres of the same visiting order, to contrast with the road distance. Only with the road engine (#47)',
    example: 3.01,
  })
  straightLineKm?: number;

  @ApiPropertyOptional({
    description: 'Estimated round-trip travel time in seconds. Only with the road engine; an estimate with no live traffic, not a promised arrival time',
    example: 812,
  })
  totalDurationSeconds?: number;

  @ApiPropertyOptional({ description: 'Road distance in km of the last leg back to the depot. Only with the road engine', example: 1.9 })
  returnLegDistanceKm?: number;

  @ApiPropertyOptional({ description: 'Estimated seconds of the last leg back to the depot. Only with the road engine', example: 260 })
  returnLegDurationSeconds?: number;

  @ApiPropertyOptional({ type: RoadGeometryDto, description: 'Road trace for the map. Only when requested with includeGeometry=true and the road engine is active' })
  geometry?: RoadGeometryDto;

  @ApiProperty({
    description:
      'Kilometres without optimizing: one independent depot -> order -> depot round trip per order of this proposal, in a straight line, with 3 decimals',
    example: 18.52,
  })
  baselineKm!: number;

  @ApiProperty({
    description:
      'baselineKm minus totalDistanceKm, computed from the displayed values so the subtraction holds exactly',
    example: 14.307,
  })
  savingsKm!: number;

  @ApiProperty({
    description:
      'Savings over the baseline in percent with 2 decimals; 0 when the baseline is 0 (never divides by zero)',
    example: 77.25,
  })
  savingsPercent!: number;

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

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  zoneId!: string | null;

  @ApiProperty({
    enum: [...PLANNING_EXCLUSION_REASONS],
    enumName: 'PlanningExclusionReason',
    isArray: true,
    description:
      'Why the order was not planned. MISSING_/INVALID_DELIVERY_COORDINATES: destination without or with malformed coordinates. MISSING_ZONE: no zone. MISSING_/INVALID_ZONE_DEPOT_COORDINATES: the zone has no valid depot. ACTIVE_ROUTE_CLAIM: already reserved by a confirmed proposal (DRAFT route). ADMINISTRATIVE_REVIEW_REQUIRED: an ADMIN must review it by hand (a failed delivery is not replanned until an ADMIN intervenes)',
    example: ['MISSING_DELIVERY_COORDINATES'],
  })
  reasons!: PlanningExclusionReason[];
}

export class RouteProposalSummaryDto {
  @ApiProperty() candidateOrders!: number;
  @ApiProperty() plannedOrders!: number;
  @ApiProperty() excludedOrders!: number;
  @ApiProperty() routes!: number;

  @ApiProperty({
    description:
      'Sum of the baselineKm of every proposal of the day (excluded orders are not counted)',
  })
  baselineKm!: number;

  @ApiProperty({
    description: 'Sum of the totalDistanceKm of every proposal of the day',
  })
  plannedKm!: number;

  @ApiProperty({ description: 'baselineKm minus plannedKm' })
  savingsKm!: number;

  @ApiProperty({
    description: 'Daily savings over the baseline in percent; 0 when the baseline is 0',
  })
  savingsPercent!: number;
}

/** Procedencia de las métricas viales: qué son, en qué unidades y qué NO garantizan. */
export class RoadMetricsInfoDto {
  @ApiProperty({ enum: ['OSRM'] }) provider!: 'OSRM';
  @ApiProperty({ example: 'car' }) profile!: string;
  @ApiProperty({ enum: ['km'] }) distanceUnit!: 'km';
  @ApiProperty({ enum: ['s'] }) durationUnit!: 's';
  @ApiProperty({ description: 'Distances are not assumed symmetric: each leg uses its own direction of travel' }) directional!: boolean;
  @ApiProperty({ description: 'Always false: no live traffic is modelled' }) trafficAware!: boolean;
  @ApiProperty({ description: 'Always true: durations are estimates, not a guaranteed arrival time' }) estimate!: boolean;
  @ApiProperty({ description: 'Largest distance in metres a point had to be snapped to the road network' }) maxSnapDistanceM!: number;
}

export class RouteProposalResponseDto {
  @ApiProperty({ example: '2030-02-14' })
  date!: string;

  @ApiProperty({ example: 'America/Guayaquil' })
  timeZone!: string;

  @ApiProperty({
    example: true,
    description:
      'True when date matches the current operational day in America/Guayaquil; non-today dates are read-only previews',
  })
  isToday!: boolean;

  @ApiProperty({
    example: true,
    description:
      'True only when isToday is true so proposals for date can be confirmed with POST /routes and assigned',
  })
  canConfirm!: boolean;

  @ApiProperty({ example: 4 })
  capacity!: number;

  @ApiProperty({
    example: 30,
    description:
      'Maximum allowed spread in minutes (inclusive, max - min <= timeWindowMarginMinutes) between scheduled delivery instants within a single proposed route',
  })
  timeWindowMarginMinutes!: number;

  @ApiProperty({
    example: 'HAVERSINE_STRAIGHT_LINE',
    enum: ['HAVERSINE_STRAIGHT_LINE', 'OSRM_ROAD_NETWORK'],
    description:
      'HAVERSINE_STRAIGHT_LINE: straight-line distances, not road distance. OSRM_ROAD_NETWORK: distances and estimated durations over the road network (see roadMetrics). Neither models live traffic',
  })
  distanceMethod!: string;

  @ApiPropertyOptional({ type: RoadMetricsInfoDto, description: 'Provenance of the road metrics; present only when distanceMethod is OSRM_ROAD_NETWORK' })
  roadMetrics?: RoadMetricsInfoDto;

  @ApiProperty({ type: [RouteProposalDto] })
  proposals!: RouteProposalDto[];

  @ApiProperty({ type: [ExcludedOrderDto] })
  excluded!: ExcludedOrderDto[];

  @ApiProperty({ type: RouteProposalSummaryDto })
  summary!: RouteProposalSummaryDto;
}
