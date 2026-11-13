import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from './orders-query.dto.js';

/** Quién creó el pedido propio: el cliente por sí mismo (Shop) o un ADMIN en su nombre. */
export const ORDER_SOURCES = ['SHOP', 'ADMIN'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const PICKUP_STATES = ['PENDING_PICKUP', 'PICKED_UP'] as const;

/** Retiro en tienda acordado con el cliente (#50): el acuerdo y el retiro físico son dos eventos distintos. */
export class OrderPickupDto {
  @ApiProperty({
    enum: PICKUP_STATES,
    description: '`PENDING_PICKUP`: el cliente acordó retirar y aún no lo ha hecho. `PICKED_UP`: un ADMIN confirmó el retiro físico (el pedido figura entregado por retiro)',
  })
  state!: (typeof PICKUP_STATES)[number];

  @ApiProperty({ format: 'date-time', description: 'Momento en que un ADMIN registró el acuerdo explícito de retiro' })
  agreedAt!: string;

  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Momento en que un ADMIN confirmó el retiro físico; null mientras esté pendiente' })
  pickedUpAt!: string | null;
}

export class OrderSummaryDto {
  @ApiProperty({ format: 'uuid', description: 'ID único del pedido' })
  id!: string;

  @ApiProperty({ enum: ORDER_SOURCES, description: 'Origen del pedido: `SHOP` (lo hizo el cliente) o `ADMIN` (lo registró un ADMIN a su nombre)' })
  source!: OrderSource;

  @ApiProperty({
    type: OrderPickupDto,
    nullable: true,
    description: 'Retiro en tienda acordado, o null si el pedido no tiene uno. Sin retiro y con `pendingManagement` el pedido espera una gestión de ADMIN',
  })
  pickup!: OrderPickupDto | null;

  @ApiProperty({
    description:
      'true si la entrega está pendiente de gestión de un ADMIN (por ejemplo tras una entrega fallida) y todavía no hay un retiro acordado',
  })
  pendingManagement!: boolean;

  @ApiProperty({
    description:
      'Si existe un comprobante fiable. Si es false (pedido conservado sin comprobante) el número, los importes y el resumen de ítems son null: nunca se reconstruyen con el catálogo actual.',
  })
  receiptAvailable!: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'Número comercial legible del pedido (ej. RG-2026-...); null sin comprobante' })
  number!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Fecha de creación' })
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Fecha programada de entrega; null solo en un pedido antiguo conservado sin comprobante ni fecha' })
  scheduledDeliveryDate!: string | null;

  @ApiProperty({ enum: OrderStatus, description: 'Estado actual del pedido' })
  status!: OrderStatus;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: 'Total en centavos (subtotal + tax + shipping); null sin comprobante' })
  totalCents!: number | null;

  @ApiProperty({ enum: ['USD'], default: 'USD' })
  currency!: 'USD';

  @ApiProperty({ type: String, enum: ['APPROVED'], nullable: true, default: 'APPROVED', description: 'null sin comprobante: no se infiere el pago' })
  paymentStatus!: 'APPROVED' | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'ID del comprobante emitido; null sin comprobante' })
  receiptId!: string | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 1, description: 'Cantidad total de ítems; null sin comprobante' })
  itemsCount!: number | null;

  @ApiProperty({ type: String, nullable: true, format: 'uri', description: 'URL de imagen principal o null' })
  primaryImageUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Producto de la miniatura; sirve para mostrar la foto del catálogo si el comprobante no congeló imageUrl',
  })
  primaryProductId!: string | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: 'Subtotal en centavos; null sin comprobante' })
  subtotalCents!: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: 'Monto de IVA simulado en centavos; null sin comprobante' })
  taxAmountCents!: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 10000, description: 'Tasa de IVA simulado en bps (1500 = 15%); null sin comprobante' })
  taxRateBps!: number | null;

  @ApiProperty({ type: Number, nullable: true, default: 0, description: 'Costo de envío en centavos (siempre 0); null sin comprobante' })
  shippingAmountCents!: number | null;

  @ApiProperty({ type: Boolean, nullable: true, description: 'Si el IVA simulado estaba activo al momento de compra; null sin comprobante' })
  taxEnabled!: boolean | null;
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
