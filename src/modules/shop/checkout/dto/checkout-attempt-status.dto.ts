import { ApiProperty } from '@nestjs/swagger';

export type CheckoutAttemptStatusType =
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'REJECTED'
  | 'FAILED';

export class CheckoutAttemptStatusDto {
  @ApiProperty({
    enum: ['PROCESSING', 'SUCCEEDED', 'REJECTED', 'FAILED'],
    description: 'Estado del intento de checkout',
    example: 'PROCESSING',
  })
  status!: CheckoutAttemptStatusType;

  @ApiProperty({
    format: 'uuid',
    description: 'ID único del intento de checkout',
    example: '66666666-6666-4666-8666-666666666666',
  })
  checkoutAttemptId!: string;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'ID de la orden si el intento fue exitoso',
    example: null,
  })
  orderId!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'ID del comprobante de compra si el intento fue exitoso',
    example: null,
  })
  receiptId!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Código de error si el intento fue rechazado o fallido',
    example: null,
  })
  errorCode!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description: 'Fecha y hora de última actualización del intento',
    example: '2026-10-22T12:00:00.000Z',
  })
  updatedAt!: string;
}
