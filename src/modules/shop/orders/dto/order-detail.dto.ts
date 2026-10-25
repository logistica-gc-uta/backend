import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from './orders-query.dto.js';

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
  @ApiProperty({ format: 'uuid', description: 'ID de la zona de entrega' })
  zoneId!: string;

  @ApiProperty({ description: 'Nombre de la zona de entrega' })
  zoneName!: string;

  @ApiProperty({ description: 'Dirección física de entrega' })
  address!: string;

  @ApiProperty({ type: GeoPointDto, description: 'Coordenadas geográficas' })
  location!: GeoPointDto;

  @ApiProperty({ format: 'date-time', description: 'Fecha y hora programada' })
  scheduledDeliveryDate!: string;

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

  @ApiProperty({ description: 'Número comercial legible del pedido' })
  number!: string;

  @ApiProperty({ format: 'date-time', description: 'Fecha de creación' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', description: 'Fecha programada de entrega' })
  scheduledDeliveryDate!: string;

  @ApiProperty({ enum: OrderStatus, description: 'Estado actual del pedido' })
  status!: OrderStatus;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'ID de ruta logística asignada o null' })
  routeId!: string | null;

  @ApiProperty({ enum: ['USD'], default: 'USD' })
  currency!: 'USD';

  @ApiProperty({ minimum: 0, description: 'Total en centavos' })
  totalCents!: number;

  @ApiProperty({ enum: ['APPROVED'], default: 'APPROVED' })
  paymentStatus!: 'APPROVED';

  @ApiProperty({ type: BuyerDto, description: 'Datos del comprador congelados' })
  buyer!: BuyerDto;

  @ApiProperty({ type: RecipientDto, description: 'Datos del destinatario congelados' })
  recipient!: RecipientDto;

  @ApiProperty({ type: DeliveryReadDto, description: 'Datos de entrega congelados' })
  delivery!: DeliveryReadDto;

  @ApiProperty({ type: [SoldItemDto], description: 'Ítems comprados con precios congelados' })
  items!: SoldItemDto[];

  @ApiProperty({ type: [TimelineEntryDto], description: 'Historial cronológico de eventos reales' })
  timeline!: TimelineEntryDto[];

  @ApiProperty({ format: 'uuid', description: 'ID del comprobante de compra' })
  receiptId!: string;

  @ApiProperty({ minimum: 0, description: 'Subtotal en centavos' })
  subtotalCents!: number;

  @ApiProperty({ minimum: 0, description: 'Monto de IVA simulado en centavos' })
  taxAmountCents!: number;

  @ApiProperty({ minimum: 0, maximum: 10000, description: 'Tasa de IVA simulado en bps' })
  taxRateBps!: number;

  @ApiProperty({ default: 0, description: 'Costo de envío en centavos (0)' })
  shippingAmountCents!: number;

  @ApiProperty({ description: 'Si el IVA simulado estaba activo al momento de compra' })
  taxEnabled!: boolean;
}
