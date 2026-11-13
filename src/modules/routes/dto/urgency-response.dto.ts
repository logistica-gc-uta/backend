import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UrgencyStopDto {
  @ApiProperty() orderId!: string;
  @ApiProperty({ minimum: 1, maximum: 4 }) sequence!: number;
}
export class UrgencyProposalDto {
  @ApiProperty() orderId!: string;
  @ApiProperty() date!: string;
  @ApiProperty({ example: 'America/Guayaquil' }) timeZone!: string;
  @ApiProperty({ enum: ['INSERT', 'NEW_ROUTE', 'BLOCKED'] }) kind!:
    'INSERT' | 'NEW_ROUTE' | 'BLOCKED';
  @ApiProperty({ nullable: true, type: String }) routeId!: string | null;
  @ApiProperty({ nullable: true, type: String }) zoneId!: string | null;
  @ApiProperty({ nullable: true, type: String }) routeDate!: string | null;
  @ApiProperty({ type: [String] }) orderIds!: string[];
  @ApiProperty({ type: [UrgencyStopDto] }) stops!: UrgencyStopDto[];
  @ApiProperty({ type: [String] }) availableDriverIds!: string[];
  @ApiProperty({ type: [String] }) reasons!: string[];
  @ApiProperty() totalDistanceKm!: number;
  @ApiPropertyOptional({
    enum: ['HAVERSINE_STRAIGHT_LINE', 'OSRM_ROAD_NETWORK'],
    description: 'How totalDistanceKm was measured. With the road engine it is the road distance; neither models live traffic',
  })
  distanceMethod?: string;
  @ApiProperty({
    description:
      'Read-only snapshot hash; confirmation must revalidate atomically',
  })
  fingerprint!: string;
}
export class UrgencyAttemptDto {
  @ApiProperty() id!: string;
  @ApiProperty() stopId!: string;
  @ApiProperty() outcome!: string;
  @ApiProperty({ type: String, nullable: true }) failureReason!: string | null;
  @ApiProperty() recordedAt!: string;
}
export class UrgencyPickupDto {
  @ApiProperty({ enum: ['PENDING_PICKUP', 'PICKED_UP'] }) state!: 'PENDING_PICKUP' | 'PICKED_UP';
  @ApiProperty({ description: 'Cuándo un ADMIN registró el acuerdo explícito de retiro en tienda' }) agreedAt!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Cuándo un ADMIN confirmó el retiro físico; null mientras esté pendiente' }) pickedUpAt!: string | null;
}
export class UrgencyIncidentDto {
  @ApiProperty() orderId!: string;
  @ApiProperty({ type: String, nullable: true }) routeId!: string | null;
  @ApiProperty({ type: UrgencyPickupDto, nullable: true, description: 'Retiro en tienda acordado para este pedido (#50), o null' })
  pickup!: UrgencyPickupDto | null;
  @ApiProperty({ type: [UrgencyAttemptDto] }) attempts!: UrgencyAttemptDto[];
}
export class UrgencyInboxDto {
  @ApiProperty() date!: string;
  @ApiProperty() timeZone!: string;
  @ApiProperty({ type: [UrgencyProposalDto] }) urgencies!: UrgencyProposalDto[];
  @ApiProperty({ type: [UrgencyIncidentDto] }) incidents!: UrgencyIncidentDto[];
}
