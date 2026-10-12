import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
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
] as const;
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
