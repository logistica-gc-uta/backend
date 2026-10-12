import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ZoneResponseDto } from '../../zones/dto/zone-response.dto.js';
import { GeoPointDto, PlanningEligibilityDto } from './geo-point.dto.js';
import { OrderStatus } from './update-order-status.dto.js';

export class ProductSummaryDto {
  @ApiProperty({ description: 'ID único del producto (UUID)', example: 'cm789prod123' })
  id: string;

  @ApiProperty({ description: 'Nombre comercial del producto', example: 'Laptop HP Pavilion 15' })
  name: string;

  @ApiProperty({
    description: 'Descripción detallada del producto o null',
    example: 'Laptop 16GB RAM 512GB SSD',
    nullable: true,
  })
  description: string | null;

  @ApiProperty({ description: 'Precio unitario en USD', example: 750.0, type: Number })
  price: number;

  @ApiProperty({ description: 'Cantidad disponible en stock', example: 10, type: Number })
  stock: number;

  @ApiProperty({
    description: 'Fecha de creación del producto en formato ISO 8601',
    example: '2026-10-01T08:00:00.000Z',
  })
  createdAt: Date;
}

export class OrderItemResponseDto {
  @ApiProperty({ description: 'ID único del ítem del pedido (UUID)', example: 'cm456item123' })
  id: string;

  @ApiProperty({ description: 'ID del pedido al que pertenece el ítem', example: 'cm123order456' })
  orderId: string;

  @ApiProperty({ description: 'ID del producto asociado', example: 'cm789prod123' })
  productId: string;

  @ApiProperty({ description: 'Cantidad solicitada del producto', example: 2, type: Number })
  quantity: number;

  @ApiProperty({ description: 'Precio unitario congelado al crear el pedido en USD', example: 750.0, type: Number })
  price: number;

  @ApiPropertyOptional({ description: 'Included on read queries; creation returns frozen line values', type: () => ProductSummaryDto })
  product?: ProductSummaryDto;
}

export class UserSummaryDto {
  @ApiProperty({ description: 'ID único del usuario (UUID)', example: 'cm123user456' })
  id: string;

  @ApiProperty({ description: 'Nombre completo del usuario', example: 'Carlos Cliente' })
  name: string;

}

export class OrderCreatedResponseDto {
  @ApiProperty({ type: String, nullable: true, description: 'Verified creator or null for unverified history' })
  createdById: string | null;

  @ApiProperty({ type: String, enum: ['REGISTERED_CLIENT', 'GUEST'], nullable: true })
  recipientType: 'REGISTERED_CLIENT' | 'GUEST' | null;

  @ApiProperty({ type: String, nullable: true, description: 'Recipient snapshot; null for unverified history' })
  recipientName: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'ADMIN or authorized own-route DRIVER only; omitted for CLIENT' })
  recipientPhone?: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deliveryWindowStart: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deliveryWindowEnd: string | null;

  @ApiPropertyOptional({ type: () => [OrderItemResponseDto], description: 'Included on creation; status updates may omit lines' })
  items?: OrderItemResponseDto[];

  @ApiProperty({ description: 'Identificador único del pedido (UUID)', example: 'cm123order456' })
  id: string;

  @ApiProperty({
    description: 'ID del cliente propietario del pedido o null para invitado sin cuenta',
    example: 'cm123user456',
    type: String,
    nullable: true,
  })
  userId: string | null;

  @ApiProperty({ description: 'ID de la zona de entrega asignada', example: 'cm123zone456' })
  zoneId: string;

  @ApiProperty({ description: 'Dirección física de entrega', example: 'Av. Cevallos y Montalvo' })
  deliveryAddress: string;

  @ApiProperty({
    description: 'Latitud confirmada de entrega en grados decimales o null si fue omitida',
    example: -1.24908,
    nullable: true,
    type: Number,
  })
  deliveryLat: number | null;

  @ApiProperty({
    description: 'Longitud confirmada de entrega en grados decimales o null si fue omitida',
    example: -78.61675,
    nullable: true,
    type: Number,
  })
  deliveryLng: number | null;

  @ApiProperty({
    description: 'Fecha y hora programada de entrega o null',
    example: '2026-10-15T10:00:00.000Z',
    nullable: true,
  })
  scheduledDeliveryDate: Date | null;

  @ApiProperty({
    description: 'Estado actual del pedido en su ciclo de vida',
    enum: OrderStatus,
    example: OrderStatus.PENDING,
  })
  status: OrderStatus;

  @ApiProperty({ description: 'Monto total del pedido en USD', example: 1500.0, type: Number })
  total: number;

  @ApiProperty({
    description: 'ID de la ruta a la que está asignado el pedido o null si está pendiente de asignación',
    example: null,
    nullable: true,
  })
  routeId: string | null;

  @ApiProperty({
    description: 'Orden de entrega dentro de la ruta asignada o null',
    example: null,
    nullable: true,
    type: Number,
  })
  stopOrder: number | null;

  @ApiProperty({
    description: 'Fecha y hora de creación del pedido en formato ISO 8601',
    example: '2026-10-09T14:30:00.000Z',
  })
  createdAt: Date;
}

export class OrderResponseDto extends OrderCreatedResponseDto {
  @ApiProperty({
    description: 'Lista de ítems con sus productos asociados incluidos en el pedido',
    type: () => [OrderItemResponseDto],
  })
  declare items: OrderItemResponseDto[];

  @ApiProperty({
    description: 'Información de la zona de entrega con la ubicación estructurada de su depósito',
    type: () => ZoneResponseDto,
  })
  zone: ZoneResponseDto;

  @ApiProperty({
    description:
      'Coordenadas estructuradas de entrega ({ lat, lng }) o null si no fueron provistas o son incompletas',
    type: () => GeoPointDto,
    nullable: true,
    example: { lat: -1.24908, lng: -78.61675 },
  })
  deliveryLocation: GeoPointDto | null;

  @ApiProperty({
    description:
      'Evaluación de elegibilidad geográfica para planificación de rutas (Issue #7)',
    type: () => PlanningEligibilityDto,
  })
  planningEligibility: PlanningEligibilityDto;

  @ApiPropertyOptional({
    description: 'Datos del cliente propietario (incluido en listados administrativos); null para invitado',
    type: () => UserSummaryDto,
    nullable: true,
  })
  user?: UserSummaryDto | null;
}

export class AdminOrdersPageDto {
  @ApiProperty({ type: () => [OrderResponseDto] })
  items: OrderResponseDto[];

  @ApiProperty({ type: Number })
  total: number;

  @ApiProperty({ type: Number, minimum: 1, default: 1 })
  page: number;

  @ApiProperty({ type: Number, minimum: 1, maximum: 100, default: 20 })
  pageSize: number;
}
