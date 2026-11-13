import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  Min,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
export const DISPATCH_ACTIONS = [
  'CONFIRM',
  'REJECT',
  'REORDER',
  'MOVE',
  'REASSIGN_DRIVER',
  'PRIORITIZE',
  'CONTACT',
  'RESCHEDULE',
  'PICKUP_AGREE',
  'PICKUP_DECLINE',
  'PICKUP_CONFIRM',
  'RELEASE_DRAFT',
  'LOSS_DECLARE',
  'REPLACEMENT_PREPARE',
  'ORIGINAL_RECOVER',
  'LOSS_CANCEL',
  'EMERGENCY_DECLARE',
  'UNIT_RECOVERY_CONFIRM',
  'EMERGENCY_CLOSE',
  'EMERGENCY_DRIVER_RELEASE',
  'EMERGENCY_REQUEUE',
] as const;
export const RECOVERY_CONDITIONS = ['SELLABLE', 'DAMAGED'] as const;
export class DispatchInterventionDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Global idempotency key; replay requires identical actor and body',
  })
  @IsUUID()
  requestId!: string;
  @ApiProperty({ enum: DISPATCH_ACTIONS })
  @IsIn(DISPATCH_ACTIONS)
  action!: (typeof DISPATCH_ACTIONS)[number];
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(500)
  reason!: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((o) => o.orderId !== undefined)
  @IsUUID()
  orderId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((o) => o.routeId !== undefined)
  @IsUUID()
  routeId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((o) => o.targetRouteId !== undefined)
  @IsUUID()
  targetRouteId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((o) => o.driverId !== undefined)
  @IsUUID()
  driverId?: string;
  @ApiPropertyOptional({
    description: 'Exact GET proposal fingerprint',
    pattern: '^[a-f0-9]{64}$',
  })
  @ValidateIf((o) => o.fingerprint !== undefined)
  @Matches(/^[a-f0-9]{64}$/)
  fingerprint?: string;
  @ApiPropertyOptional({ type: [String], minItems: 1, maxItems: 4 })
  @ValidateIf((o) => o.orderIds !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  orderIds?: string[];
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((o) => o.attemptId !== undefined)
  @IsUUID()
  attemptId?: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Persisted CONTACT decision with an explicit date/window agreement',
  })
  @ValidateIf((o) => o.agreementId !== undefined)
  @IsUUID()
  agreementId?: string;
  @ApiPropertyOptional()
  @ValidateIf((o) => o.agreementConfirmed !== undefined)
  @IsBoolean()
  agreementConfirmed?: boolean;
  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf((o) => o.scheduledDeliveryDate !== undefined)
  @IsString()
  scheduledDeliveryDate?: string;
  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf((o) => o.deliveryWindowStart !== undefined)
  @IsString()
  deliveryWindowStart?: string;
  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf((o) => o.deliveryWindowEnd !== undefined)
  @IsString()
  deliveryWindowEnd?: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Ítem del pedido al que pertenece la unidad perdida (#52)',
  })
  @ValidateIf((o) => o.orderItemId !== undefined)
  @IsUUID()
  orderItemId?: string;
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Unidad perdida dentro del ítem (1..cantidad); obligatoria si el ítem tiene más de una unidad (#52)',
  })
  @ValidateIf((o) => o.unitNumber !== undefined)
  @IsInt()
  @Min(1)
  unitNumber?: number;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Pérdida registrada de la que se prepara el reemplazo o se recupera el original (#52)',
  })
  @ValidateIf((o) => o.lossId !== undefined)
  @IsUUID()
  lossId?: string;
  @ApiPropertyOptional({
    enum: RECOVERY_CONDITIONS,
    description:
      'Estado comprobado del original recuperado: solo SELLABLE suma una unidad al stock disponible (#52)',
  })
  @ValidateIf((o) => o.recoveryCondition !== undefined)
  @IsIn(RECOVERY_CONDITIONS)
  recoveryCondition?: (typeof RECOVERY_CONDITIONS)[number];
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Unidad en custodia post-emergencia a confirmar como recuperada (#51)',
  })
  @ValidateIf((o) => o.recoveryId !== undefined)
  @IsUUID()
  recoveryId?: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Emergencia de ruta asociada al reencolado administrativo (#51)',
  })
  @ValidateIf((o) => o.emergencyId !== undefined)
  @IsUUID()
  emergencyId?: string;
}
export class DispatchAuditDto {
  @ApiProperty() id!: string;
  @ApiProperty() requestId!: string;
  @ApiProperty() actorId!: string;
  @ApiProperty({ type: String, nullable: true }) orderId!: string | null;
  @ApiProperty({ type: String, nullable: true }) routeId!: string | null;
  @ApiProperty() action!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ['APPLIED', 'REJECTED', 'FAILED'] }) outcome!: string;
  @ApiProperty() recordedAt!: string;
  @ApiProperty({
    type: Object,
    description:
      'Persisted operation result; contains resource identifiers, not recipient contact',
  })
  result!: unknown;
}
