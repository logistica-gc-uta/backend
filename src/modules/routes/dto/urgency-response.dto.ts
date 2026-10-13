import { ApiProperty } from '@nestjs/swagger';

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
  @ApiProperty() zoneId!: string;
  @ApiProperty({ nullable: true, type: String }) routeDate!: string | null;
  @ApiProperty({ type: [String] }) orderIds!: string[];
  @ApiProperty({ type: [UrgencyStopDto] }) stops!: UrgencyStopDto[];
  @ApiProperty({ type: [String] }) availableDriverIds!: string[];
  @ApiProperty({ type: [String] }) reasons!: string[];
  @ApiProperty() totalDistanceKm!: number;
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
export class UrgencyIncidentDto {
  @ApiProperty() orderId!: string;
  @ApiProperty({ type: String, nullable: true }) routeId!: string | null;
  @ApiProperty({ type: [UrgencyAttemptDto] }) attempts!: UrgencyAttemptDto[];
}
export class UrgencyInboxDto {
  @ApiProperty() date!: string;
  @ApiProperty() timeZone!: string;
  @ApiProperty({ type: [UrgencyProposalDto] }) urgencies!: UrgencyProposalDto[];
  @ApiProperty({ type: [UrgencyIncidentDto] }) incidents!: UrgencyIncidentDto[];
}
