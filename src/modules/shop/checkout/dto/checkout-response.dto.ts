import { ApiProperty } from '@nestjs/swagger';

export class OrderConfirmationDto {
  @ApiProperty({
    example: '77777777-7777-4777-8777-777777777777',
    description: 'Internal Order UUID',
  })
  readonly id!: string;

  @ApiProperty({
    example: 'RG-2026-0125',
    description: 'Unique human-readable commercial order number',
  })
  readonly number!: string;

  @ApiProperty({
    example: 'PENDING',
    enum: ['PENDING'],
    description: 'Initial order lifecycle status for delivery planning',
  })
  readonly status!: 'PENDING';

  @ApiProperty({
    example: 8395,
    description: 'Total amount in integer cents (subtotalCents + taxAmountCents)',
  })
  readonly totalCents!: number;

  @ApiProperty({
    example: 'USD',
    enum: ['USD'],
    description: 'Currency code',
  })
  readonly currency!: 'USD';

  @ApiProperty({
    example: '2026-11-15T15:00:00.000Z',
    description: 'Authoritative scheduled delivery instant in ISO UTC',
  })
  readonly scheduledDeliveryDate!: string;

  @ApiProperty({
    example: 7300,
    description: 'Subtotal in integer cents',
  })
  readonly subtotalCents!: number;

  @ApiProperty({
    example: 1095,
    description: 'Simulated tax amount in integer cents',
  })
  readonly taxAmountCents!: number;

  @ApiProperty({
    example: 1500,
    description: 'Simulated tax rate in basis points (1500 = 15%)',
  })
  readonly taxRateBps!: number;

  @ApiProperty({
    example: 0,
    description: 'Free included shipping amount in cents',
  })
  readonly shippingAmountCents!: 0;

  @ApiProperty({
    example: true,
    description: 'Immutable snapshot flag indicating if simulated tax was enabled at purchase time',
  })
  readonly taxEnabled!: boolean;
}

export class PaymentConfirmationDto {
  @ApiProperty({
    example: 'APPROVED',
    enum: ['APPROVED'],
    description: 'Simulated transaction approval status',
  })
  readonly status!: 'APPROVED';

  @ApiProperty({
    example: 8395,
    description: 'Total charged amount in cents',
  })
  readonly amountCents!: number;

  @ApiProperty({
    example: '0001',
    description: 'Last 4 digits of simulated card',
  })
  readonly cardLast4!: string;

  @ApiProperty({
    example: 'PAY-DEMO-000125',
    description: 'Unique simulated payment reference',
  })
  readonly reference!: string;
}

export class ReceiptReferenceDto {
  @ApiProperty({
    example: '88888888-8888-4888-8888-888888888888',
    description: 'Unique PurchaseReceipt UUID',
  })
  readonly id!: string;

  @ApiProperty({
    example: 'CMP-RG-2026-0125',
    description: 'Unique human-readable receipt commercial number',
  })
  readonly number!: string;
}

export class CheckoutSuccessDto {
  @ApiProperty({
    example: '66666666-6666-4666-8666-666666666666',
    description: 'Unique checkout attempt UUID tracking idempotency',
  })
  readonly checkoutAttemptId!: string;

  @ApiProperty({
    example: 'SUCCEEDED',
    enum: ['SUCCEEDED'],
    description: 'Purchase status',
  })
  readonly status!: 'SUCCEEDED';

  @ApiProperty({ type: OrderConfirmationDto })
  readonly order!: OrderConfirmationDto;

  @ApiProperty({ type: PaymentConfirmationDto })
  readonly payment!: PaymentConfirmationDto;

  @ApiProperty({ type: ReceiptReferenceDto })
  readonly receipt!: ReceiptReferenceDto;
}
