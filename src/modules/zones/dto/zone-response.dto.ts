import { ApiProperty } from '@nestjs/swagger';
import { GeoPointDto } from '../../orders/dto/geo-point.dto.js';

export class ZoneResponseDto {
  @ApiProperty({
    description: 'Identificador único de la zona (UUID)',
    example: 'cm123abc456-zone',
  })
  id: string;

  @ApiProperty({
    description: 'Nombre comercial o representativo de la zona de entrega',
    example: 'Zona Norte',
  })
  name: string;

  @ApiProperty({
    description: 'Código único identificador de la zona',
    example: 'ZN-01',
  })
  code: string;

  @ApiProperty({
    description: 'Latitud del depósito de la zona o null si no fue configurada',
    example: -1.241,
    nullable: true,
    type: Number,
  })
  depotLat: number | null;

  @ApiProperty({
    description: 'Longitud del depósito de la zona o null si no fue configurada',
    example: -78.619,
    nullable: true,
    type: Number,
  })
  depotLng: number | null;

  @ApiProperty({
    description: 'Fecha y hora de creación del registro en formato ISO 8601',
    example: '2026-10-09T12:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description:
      'Coordenadas geográficas estructuradas del depósito de la zona ({ lat, lng }) o null si no están configuradas',
    type: () => GeoPointDto,
    nullable: true,
    example: { lat: -1.241, lng: -78.619 },
  })
  depotLocation: GeoPointDto | null;
}
