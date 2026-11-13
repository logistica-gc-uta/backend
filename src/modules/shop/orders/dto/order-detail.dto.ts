import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from './orders-query.dto.js';
import { ORDER_SOURCES, OrderPickupDto, type OrderSource } from './order-summary.dto.js';

export class BuyerDto {
  @ApiProperty({ format: 'uuid', description: 'ID del comprador' })
  id!: string;

  @ApiProperty({ description: 'Nombre del comprador' })
  name!: string;

  @ApiProperty({ format: 'email', description: 'Correo electrónico del comprador' })
  email!: string;
}

export class RecipientDto {
  @ApiProperty({ description: 'Nombre del destinatario' })
  name!: string;

  @ApiProperty({ description: 'Teléfono de contacto del destinatario' })
  phone!: string;
}

export class GeoPointDto {
  @ApiProperty({ description: 'Latitud' })
  lat!: number;

  @ApiProperty({ description: 'Longitud' })
  lng!: number;
}

export class DeliveryReadDto {
  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Legacy zone id, or null for store-coverage orders' })
  zoneId!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'Legacy zone name, or null for store-coverage orders' })
  zoneName!: string | null;

  @ApiProperty({ description: 'Dirección física de entrega' })
  address!: string;

  @ApiProperty({ type: GeoPointDto, nullable: true, description: 'Coordenadas geográficas; null en un pedido conservado sin coordenadas' })
  location!: GeoPointDto | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Fecha y hora programada; null solo en un pedido antiguo conservado sin comprobante ni fecha' })
  scheduledDeliveryDate!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Instrucciones o notas adicionales' })
  notes!: string | null;
}

export class SoldItemDto {
  @ApiProperty({ format: 'uuid', description: 'ID del producto' })
  productId!: string;

  @ApiProperty({ description: 'SKU del producto' })
  sku!: string;

  @ApiProperty({ description: 'Nombre comercial del producto al momento de compra' })
  name!: string;

  @ApiProperty({ minimum: 1, description: 'Cantidad comprada' })
  quantity!: number;

  @ApiProperty({ minimum: 1, description: 'Precio unitario congelado en centavos' })
  unitPriceCents!: number;

  @ApiProperty({ minimum: 1, description: 'Total de la línea congelado en centavos' })
  lineTotalCents!: number;

  @ApiProperty({ type: String, nullable: true, format: 'uri', description: 'URL de imagen histórica o null' })
  imageUrl!: string | null;
}

export class TimelineEntryDto {
  @ApiProperty({ description: 'Código del evento (ej. PENDING, ASSIGNED, IN_TRANSIT, DELIVERED, ATTEMPT_FAILED)' })
  code!: string;

  @ApiProperty({ description: 'Descripción legible del evento' })
  label!: string;

  @ApiProperty({ format: 'date-time', description: 'Marca de tiempo real registrada' })
  at!: string;
}

export class OrderDetailDto {
  @ApiProperty({ format: 'uuid', description: 'ID único del pedido' })
  id!: string;

  @ApiProperty({ enum: ORDER_SOURCES, description: 'Origen del pedido: `SHOP` (lo hizo el cliente) o `ADMIN` (lo registró un ADMIN a su nombre)' })
  source!: OrderSource;

  @ApiProperty({ type: OrderPickupDto, nullable: true, description: 'Retiro en tienda acordado, o null si el pedido no tiene uno' })
  pickup!: OrderPickupDto | null;

  @ApiProperty({ description: 'true si la entrega está pendiente de gestión de un ADMIN y todavía no hay un retiro acordado' })
  pendingManagement!: boolean;

  @ApiProperty({
    description:
      'Si existe un comprobante fiable. Si es false, el número, los importes, el pago y los ítems no están disponibles y no se reconstruyen con el catálogo actual; el seguimiento sí está.',
  })
  receiptAvailable!: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'Número comercial legible del pedido; null sin comprobante' })
  number!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Fecha de creación' })
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Fecha programada de entrega; null solo en un pedido antiguo conservado sin comprobante ni fecha' })
  scheduledDeliveryDate!: string | null;

  @ApiProperty({ enum: OrderStatus, description: 'Estado actual del pedido' })
  status!: OrderStatus;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'ID de ruta logística asignada o null' })
  routeId!: string | null;

  @ApiProperty({ enum: ['USD'], default: 'USD' })
  currency!: 'USD';

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: 'Total en centavos; null sin comprobante' })
  totalCents!: number | null;

  @ApiProperty({ type: String, enum: ['APPROVED'], nullable: true, default: 'APPROVED', description: 'null sin comprobante: no se infiere el pago' })
  paymentStatus!: 'APPROVED' | null;

  @ApiProperty({ type: BuyerDto, description: 'Datos del comprador congelados' })
  buyer!: BuyerDto;

  @ApiProperty({ type: RecipientDto, nullable: true, description: 'Datos del destinatario congelados; null si el pedido conservado no los tiene' })
  recipient!: RecipientDto | null;

  @ApiProperty({ type: DeliveryReadDto, description: 'Datos de entrega congelados' })
  delivery!: DeliveryReadDto;

  @ApiProperty({ type: [SoldItemDto], description: 'Ítems comprados con precios congelados; vacío sin comprobante' })
  items!: SoldItemDto[];

  @ApiProperty({ type: [TimelineEntryDto], description: 'Historial cronológico de eventos reales' })
  timeline!: TimelineEntryDto[];

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'ID del comprobante de compra; null sin comprobante' })
  receiptId!: string | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: 'Subtotal en centavos; null sin comprobante' })
  subtotalCents!: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: 'Monto de IVA simulado en centavos; null sin comprobante' })
  taxAmountCents!: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 10000, description: 'Tasa de IVA simulado en bps; null sin comprobante' })
  taxRateBps!: number | null;

  @ApiProperty({ type: Number, nullable: true, default: 0, description: 'Costo de envío en centavos (0); null sin comprobante' })
  shippingAmountCents!: number | null;

  @ApiProperty({ type: Boolean, nullable: true, description: 'Si el IVA simulado estaba activo al momento de compra; null sin comprobante' })
  taxEnabled!: boolean | null;
}
