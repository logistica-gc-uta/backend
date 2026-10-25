import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from './orders-query.dto.js';

export class OrderSummaryDto {
  @ApiProperty({ format: 'uuid', description: 'ID único del pedido' })
  id!: string;

  @ApiProperty({ description: 'Número comercial legible del pedido (ej. RG-2026-...)' })
  number!: string;

  @ApiProperty({ format: 'date-time', description: 'Fecha de creación' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', description: 'Fecha programada de entrega' })
  scheduledDeliveryDate!: string;

  @ApiProperty({ enum: OrderStatus, description: 'Estado actual del pedido' })
  status!: OrderStatus;

  @ApiProperty({ minimum: 0, description: 'Total en centavos (subtotal + tax + shipping)' })
  totalCents!: number;

  @ApiProperty({ enum: ['USD'], default: 'USD' })
  currency!: 'USD';

  @ApiProperty({ enum: ['APPROVED'], default: 'APPROVED' })
  paymentStatus!: 'APPROVED';

  @ApiProperty({ format: 'uuid', description: 'ID del comprobante emitido' })
  receiptId!: string;

  @ApiProperty({ minimum: 1, description: 'Cantidad total de ítems' })
  itemsCount!: number;

  @ApiProperty({ type: String, nullable: true, format: 'uri', description: 'URL de imagen principal o null' })
  primaryImageUrl!: string | null;

  @ApiProperty({ minimum: 0, description: 'Subtotal en centavos' })
  subtotalCents!: number;

  @ApiProperty({ minimum: 0, description: 'Monto de IVA simulado en centavos' })
  taxAmountCents!: number;

  @ApiProperty({ minimum: 0, maximum: 10000, description: 'Tasa de IVA simulado en bps (1500 = 15%)' })
  taxRateBps!: number;

  @ApiProperty({ default: 0, description: 'Costo de envío en centavos (siempre 0)' })
  shippingAmountCents!: number;

  @ApiProperty({ description: 'Si el IVA simulado estaba activo al momento de compra' })
  taxEnabled!: boolean;
}

export class OrderListDto {
  @ApiProperty({ type: [OrderSummaryDto], description: 'Lista de pedidos en la página' })
  items!: OrderSummaryDto[];

  @ApiProperty({ minimum: 0, description: 'Total de pedidos encontrados' })
  total!: number;

  @ApiProperty({ minimum: 1, description: 'Página actual' })
  page!: number;

  @ApiProperty({ minimum: 1, description: 'Tamaño de página solicitado' })
  pageSize!: number;

  @ApiProperty({ minimum: 0, description: 'Total de páginas disponibles' })
  totalPages!: number;
}
