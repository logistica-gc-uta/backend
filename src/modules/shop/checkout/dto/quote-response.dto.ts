import { ApiProperty } from '@nestjs/swagger';

export class QuotedLineDto {
  @ApiProperty({
    example: '11111111-1111-4111-8111-111111111111',
    description: 'Product UUID',
  })
  readonly productId!: string;

  @ApiProperty({
    example: 'Caja sorpresa navideña',
    description: 'Product commercial name',
  })
  readonly name!: string;

  @ApiProperty({
    example: 2,
    minimum: 1,
    description: 'Requested consolidated quantity for this SKU',
  })
  readonly quantity!: number;

  @ApiProperty({
    example: 3650,
    minimum: 1,
    description: 'Authoritative server price in USD cents',
  })
  readonly unitPriceCents!: number;

  @ApiProperty({
    example: 7300,
    minimum: 1,
    description: 'Line total in cents (unitPriceCents * quantity)',
  })
  readonly lineTotalCents!: number;

  @ApiProperty({
    example: 8,
    minimum: 0,
    description: 'Current real-time stock quantity in catalog',
  })
  readonly availableStock!: number;

  @ApiProperty({
    example: true,
    description: 'Whether availableStock is sufficient for requested quantity',
  })
  readonly available!: boolean;
}

export class ShippingQuoteDto {
  @ApiProperty({ enum: ['FREE_INCLUDED'], example: 'FREE_INCLUDED' })
  readonly status = 'FREE_INCLUDED' as const;

  @ApiProperty({ example: 0, default: 0 })
  readonly amountCents: number = 0;

  @ApiProperty({ example: true, default: true })
  readonly includedInPrices: boolean = true;
}

export class SimulatedTaxQuoteDto {
  @ApiProperty({ example: 'SIMULATED', default: 'SIMULATED' })
  readonly mode = 'SIMULATED' as const;

  @ApiProperty({ example: true, description: 'Whether simulated tax is active' })
  readonly enabled!: boolean;

  @ApiProperty({
    example: 1500,
    minimum: 0,
    maximum: 10000,
    description: 'Tax rate in basis points (1500 = 15%)',
  })
  readonly rateBps!: number;

  @ApiProperty({
    example: 15,
    minimum: 0,
    maximum: 100,
    description: 'Tax rate percentage (rateBps / 100)',
  })
  readonly ratePercent!: number;

  @ApiProperty({
    example: 1095,
    minimum: 0,
    description: 'Calculated simulated IVA amount in cents, rounded HALF_UP on subtotal',
  })
  readonly amountCents!: number;
}

export class QuoteResponseDto {
  @ApiProperty({ enum: ['USD'], example: 'USD' })
  readonly currency = 'USD' as const;

  @ApiProperty({ type: [QuotedLineDto], description: 'Quoted product lines' })
  readonly items!: QuotedLineDto[];

  @ApiProperty({
    example: 7300,
    minimum: 0,
    description: 'Sum of line totals in USD cents',
  })
  readonly subtotalCents!: number;

  @ApiProperty({ type: ShippingQuoteDto })
  readonly shipping!: ShippingQuoteDto;

  @ApiProperty({ type: SimulatedTaxQuoteDto })
  readonly tax!: SimulatedTaxQuoteDto;

  @ApiProperty({
    example: 8395,
    minimum: 0,
    description: 'Total payable amount in USD cents (subtotal + tax + shipping)',
  })
  readonly totalCents!: number;

  @ApiProperty({
    example: 1,
    minimum: 1,
    description: 'Persisted ShopSettings version bound to this quote',
  })
  readonly settingsVersion!: number;

  @ApiProperty({
    example: '2026-10-23T12:15:00.000Z',
    description: 'Validity expiration instant (15 minutes from quote)',
  })
  readonly validUntil!: string;

  @ApiProperty({
    example: 'qtk_v1.eyJidXllclVzZXJJZCI6IjExM...c8df',
    minLength: 10,
    description: 'Opaque HMAC-signed quote token binding buyer, delivery, lines, prices and settings',
  })
  readonly quoteToken!: string;
}
