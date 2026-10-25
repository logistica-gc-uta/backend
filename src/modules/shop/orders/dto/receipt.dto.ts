import { ApiProperty } from '@nestjs/swagger';

export class ReceiptBuyerDto {
  @ApiProperty({ description: 'Nombre del comprador' })
  name!: string;

  @ApiProperty({ format: 'email', description: 'Correo del comprador' })
  email!: string;
}

export class ReceiptRecipientDto {
  @ApiProperty({ description: 'Nombre del destinatario' })
  name!: string;
}

export class ReceiptItemDto {
  @ApiProperty({ description: 'SKU del producto' })
  sku!: string;

  @ApiProperty({ description: 'Nombre del producto congelado' })
  name!: string;

  @ApiProperty({ minimum: 1, description: 'Cantidad comprada' })
  quantity!: number;

  @ApiProperty({ minimum: 1, description: 'Precio unitario en centavos' })
  unitPriceCents!: number;

  @ApiProperty({ minimum: 1, description: 'Total de la línea en centavos' })
  lineTotalCents!: number;
}

export class ReceiptPaymentDto {
  @ApiProperty({ enum: ['APPROVED'], default: 'APPROVED' })
  status!: 'APPROVED';

  @ApiProperty({ description: 'Referencia de la transacción de pago simulado' })
  reference!: string;

  @ApiProperty({ description: 'Últimos 4 dígitos de la tarjeta utilizada' })
  cardLast4!: string;
}

export class SimulatedTaxQuoteDto {
  @ApiProperty({ enum: ['SIMULATED'], default: 'SIMULATED' })
  mode!: 'SIMULATED';

  @ApiProperty({ description: 'Si el IVA simulado estaba habilitado' })
  enabled!: boolean;

  @ApiProperty({ minimum: 0, maximum: 10000, description: 'Tasa en puntos básicos (1500 = 15%)' })
  rateBps!: number;

  @ApiProperty({ minimum: 0, maximum: 100, description: 'Tasa porcentual (15 = 15%)' })
  ratePercent!: number;

  @ApiProperty({ minimum: 0, description: 'Monto simulado en centavos' })
  amountCents!: number;
}

export class ShippingDto {
  @ApiProperty({ enum: ['FREE_INCLUDED'], default: 'FREE_INCLUDED' })
  status!: 'FREE_INCLUDED';

  @ApiProperty({ default: 0, description: 'Costo de envío para CLIENT siempre es 0' })
  amountCents!: number;

  @ApiProperty({ default: true, description: 'Costo logístico incluido en los precios' })
  includedInPrices!: boolean;
}

export class ReceiptDto {
  @ApiProperty({ format: 'uuid', description: 'ID único del comprobante' })
  id!: string;

  @ApiProperty({ description: 'Número único de comprobante (ej. CMP-RG-2026-...)' })
  number!: string;

  @ApiProperty({ format: 'uuid', description: 'ID del pedido asociado' })
  orderId!: string;

  @ApiProperty({ format: 'date-time', description: 'Fecha de emisión del comprobante' })
  issuedAt!: string;

  @ApiProperty({ default: 'REGALÍA', description: 'Nombre comercial del emisor' })
  merchantName!: string;

  @ApiProperty({ type: ReceiptBuyerDto, description: 'Datos del comprador' })
  buyer!: ReceiptBuyerDto;

  @ApiProperty({ type: ReceiptRecipientDto, description: 'Datos del destinatario' })
  recipient!: ReceiptRecipientDto;

  @ApiProperty({ type: [ReceiptItemDto], description: 'Ítems adquiridos' })
  items!: ReceiptItemDto[];

  @ApiProperty({ enum: ['USD'], default: 'USD' })
  currency!: 'USD';

  @ApiProperty({ minimum: 0, description: 'Subtotal en centavos' })
  subtotalCents!: number;

  @ApiProperty({ minimum: 0, description: 'Total en centavos con impuesto de demostración' })
  totalCents!: number;

  @ApiProperty({ type: ReceiptPaymentDto, description: 'Comprobante de pago simulado' })
  payment!: ReceiptPaymentDto;

  @ApiProperty({
    enum: ['COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA'],
    default: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA',
  })
  disclaimer!: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA';

  @ApiProperty({ type: SimulatedTaxQuoteDto, description: 'Detalle de impuesto simulado' })
  tax!: SimulatedTaxQuoteDto;

  @ApiProperty({ type: ShippingDto, description: 'Detalle de envío incluido' })
  shipping!: ShippingDto;
}
