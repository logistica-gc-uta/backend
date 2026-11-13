import { ApiProperty } from '@nestjs/swagger';

export class LossReplacementDto {
  @ApiProperty({ enum: ['PENDING', 'PREPARED'], description: 'PENDING: aún no hay existencia libre; PREPARED: ya se descontó una unidad' })
  state!: 'PENDING' | 'PREPARED';
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) preparedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) preparedById!: string | null;
}

export class LossOriginalDto {
  @ApiProperty({ enum: ['LOST', 'RECOVERED'] }) state!: 'LOST' | 'RECOVERED';
  @ApiProperty({ enum: ['SELLABLE', 'DAMAGED'], nullable: true }) condition!: 'SELLABLE' | 'DAMAGED' | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) recoveredAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) recoveredById!: string | null;
}

export class StockMovementDto {
  @ApiProperty({ enum: ['REPLACEMENT_OUT', 'RECOVERY_IN', 'REPLACEMENT_CANCEL_IN'] })
  kind!: 'REPLACEMENT_OUT' | 'RECOVERY_IN' | 'REPLACEMENT_CANCEL_IN';
  @ApiProperty({ description: '-1 reemplazo, +1 recuperación vendible o anulación de reemplazo preparado' }) delta!: number;
  @ApiProperty() stockAfter!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() createdById!: string;
}

export class OrderItemLossDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty() orderItemId!: string;
  @ApiProperty({ description: 'Unidad perdida dentro del ítem (1..cantidad)' }) unitNumber!: number;
  @ApiProperty() productId!: string;
  @ApiProperty({ type: String, nullable: true }) attemptId!: string | null;
  @ApiProperty({ format: 'date-time' }) declaredAt!: string;
  @ApiProperty() declaredById!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) cancelledAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) cancelledById!: string | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason!: string | null;
  @ApiProperty({ type: LossReplacementDto }) replacement!: LossReplacementDto;
  @ApiProperty({ type: LossOriginalDto }) original!: LossOriginalDto;
  @ApiProperty({ type: [StockMovementDto] }) movements!: StockMovementDto[];
}
