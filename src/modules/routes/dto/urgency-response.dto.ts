import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  INCIDENT_ACTION_REASON_CODES,
  INCIDENT_OWNERSHIPS,
  INCIDENT_STATUSES,
  type IncidentActionReasonCode,
  type IncidentOwnership,
  type IncidentStatus,
} from '../incident-inbox-projection.js';

export class UrgencyStopDto {
  @ApiProperty() orderId!: string;
  @ApiProperty({ minimum: 1 }) sequence!: number;
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
export class IncidentReadinessDto {
  @ApiProperty({ format: 'uuid', description: 'Applied CONFIRM_INCIDENT_READY audit identifier' })
  auditId!: string;
  @ApiProperty({ format: 'uuid', description: 'Canonical failed DeliveryAttempt attested as available at store' })
  attemptId!: string;
  @ApiProperty({ format: 'date-time', description: 'When the ADMIN recorded store readiness confirmation' })
  confirmedAt!: string;
  @ApiProperty({ format: 'uuid', description: 'ADMIN actor identifier who confirmed store readiness' })
  confirmedById!: string;
}

export class IncidentEmergencyContextDto {
  @ApiProperty({ format: 'uuid', description: 'Active RouteEmergency identifier owning custody of this order' })
  emergencyId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Interrupted route identifier for the active emergency' })
  routeId!: string | null;
  @ApiProperty({ description: 'Whether every RouteUnitRecovery for this order in the selected emergency is recovered or has a prepared replacement' })
  recoveryResolved!: boolean;
  @ApiProperty({ minimum: 0 })
  pendingUnitsCount!: number;
  @ApiProperty({ minimum: 0 })
  totalUnitsCount!: number;
}

export class IncidentActionEligibilityDto {
  @ApiProperty({ description: 'Read-only snapshot of whether the action is currently permitted; write endpoints still revalidate atomically' })
  allowed!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: Object.values(INCIDENT_ACTION_REASON_CODES),
    description: 'Stable machine reason code when disabled; null when allowed',
  })
  reasonCode!: IncidentActionReasonCode | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Concise operator explanation when disabled; null when allowed',
  })
  reason!: string | null;
}

export class IncidentAllowedActionsDto {
  @ApiProperty({ type: IncidentActionEligibilityDto })
  CONTACT!: IncidentActionEligibilityDto;
  @ApiProperty({ type: IncidentActionEligibilityDto })
  CONFIRM_INCIDENT_READY!: IncidentActionEligibilityDto;
  @ApiProperty({ type: IncidentActionEligibilityDto })
  RESCHEDULE!: IncidentActionEligibilityDto;
  @ApiProperty({ type: IncidentActionEligibilityDto })
  PICKUP_AGREE!: IncidentActionEligibilityDto;
  @ApiProperty({ type: IncidentActionEligibilityDto })
  PICKUP_DECLINE!: IncidentActionEligibilityDto;
  @ApiProperty({ type: IncidentActionEligibilityDto })
  PICKUP_CONFIRM!: IncidentActionEligibilityDto;
}

export class UrgencyIncidentDto {
  @ApiProperty() orderId!: string;
  @ApiProperty({ type: String, nullable: true }) routeId!: string | null;
  @ApiProperty({ type: UrgencyPickupDto, nullable: true, description: 'Retiro en tienda acordado para este pedido (#50), o null' })
  pickup!: UrgencyPickupDto | null;
  @ApiProperty({ type: [UrgencyAttemptDto] }) attempts!: UrgencyAttemptDto[];
  @ApiProperty({
    enum: INCIDENT_STATUSES,
    description: 'Current administrative incident status snapshot',
  })
  status!: IncidentStatus;
  @ApiProperty({
    enum: INCIDENT_OWNERSHIPS,
    description: 'Distinguishes ordinary failed-delivery resolution from active emergency custody or unverified review',
  })
  ownership!: IncidentOwnership;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Canonical latest failed DeliveryAttempt identifier, or null when no canonical failed attempt exists',
  })
  latestFailedAttemptId!: string | null;
  @ApiProperty({
    type: IncidentReadinessDto,
    nullable: true,
    description: 'Recorded store readiness attestation for the exact latest canonical failed attempt, or null',
  })
  readiness!: IncidentReadinessDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Active RouteEmergency identifier when owned by emergency custody, otherwise null',
  })
  emergencyId!: string | null;
  @ApiProperty({
    type: IncidentEmergencyContextDto,
    nullable: true,
    description: 'Emergency custody context when owned by emergency custody, otherwise null',
  })
  emergency!: IncidentEmergencyContextDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Latest unconsumed future confirmed CONTACT agreement identifier for the latest canonical failed attempt, or null',
  })
  activeAgreementId!: string | null;
  @ApiProperty({
    type: IncidentAllowedActionsDto,
    description: 'Read-only action eligibility snapshot; atomic write gates remain authoritative',
  })
  allowedActions!: IncidentAllowedActionsDto;
}

export class InterruptedRouteInboxDto {
  @ApiProperty() routeId!: string;
  @ApiProperty({ type: String, nullable: true }) emergencyId!: string | null;
  @ApiProperty({ type: String, nullable: true }) declaredAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) closedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) driverId!: string | null;
  @ApiProperty({ type: String, nullable: true }) returnedAt!: string | null;
  @ApiProperty() pendingUnitsCount!: number;
  @ApiProperty() totalUnitsCount!: number;
}

export class PendingRecoveryInboxDto {
  @ApiProperty() recoveryId!: string;
  @ApiProperty() emergencyId!: string;
  @ApiProperty() routeId!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty() orderItemId!: string;
  @ApiProperty() unitNumber!: number;
  @ApiProperty() productId!: string;
  @ApiProperty({ type: String, nullable: true }) lossId!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['PENDING', 'PREPARED'] })
  replacementState!: 'PENDING' | 'PREPARED' | null;
}

export class UrgencyInboxDto {
  @ApiProperty() date!: string;
  @ApiProperty() timeZone!: string;
  @ApiProperty({ type: [UrgencyProposalDto] }) urgencies!: UrgencyProposalDto[];
  @ApiProperty({ type: [UrgencyIncidentDto] }) incidents!: UrgencyIncidentDto[];
  @ApiProperty({ type: [InterruptedRouteInboxDto] })
  interruptedRoutes!: InterruptedRouteInboxDto[];
  @ApiProperty({ type: [PendingRecoveryInboxDto] })
  pendingRecoveries!: PendingRecoveryInboxDto[];
}
