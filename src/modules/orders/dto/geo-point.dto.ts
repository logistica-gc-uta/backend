import { ApiProperty } from '@nestjs/swagger';
import { PlanningIneligibilityReason } from '../order-geography.util.js';

export class GeoPointDto {
  @ApiProperty({
    description: 'Latitud geográfica en grados decimales dentro del rango [-90, 90]',
    example: -1.24908,
    type: Number,
  })
  lat: number;

  @ApiProperty({
    description: 'Longitud geográfica en grados decimales dentro del rango [-180, 180]',
    example: -78.61675,
    type: Number,
  })
  lng: number;
}

export class PlanningEligibilityDto {
  @ApiProperty({
    description:
      'Indica si el pedido cumple con los requisitos geográficos mínimos para planificación (coordenadas de entrega y depósito de zona válidas)',
    example: true,
  })
  eligible: boolean;

  @ApiProperty({
    description:
      'Lista de razones que impiden la elegibilidad geográfica del pedido para planificación de rutas',
    enum: PlanningIneligibilityReason,
    isArray: true,
    example: [],
  })
  reasons: PlanningIneligibilityReason[];
}
