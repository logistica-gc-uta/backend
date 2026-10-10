import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  enrichZoneWithGeography,
  validateCoordinatePair,
} from '../orders/order-geography.util.js';
import { CreateZoneDto } from './dto/create-zone.dto.js';
import { UpdateZoneDto } from './dto/update-zone.dto.js';

@Injectable()
export class ZonesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const zones = await this.prisma.zone.all();
    return zones.map(enrichZoneWithGeography);
  }

  async findOne(id: string) {
    const zone = await this.prisma.zone.where({ id }).first();
    if (!zone) {
      throw new NotFoundException(`Zona con ID '${id}' no encontrada`);
    }
    return enrichZoneWithGeography(zone);
  }

  async create(dto: CreateZoneDto) {
    const existingCode = await this.prisma.zone.where({ code: dto.code }).first();
    if (existingCode) {
      throw new ConflictException(`Ya existe una zona registrada con el código '${dto.code}'`);
    }

    const existingName = await this.prisma.zone.where({ name: dto.name }).first();
    if (existingName) {
      throw new ConflictException(`Ya existe una zona registrada con el nombre '${dto.name}'`);
    }

    const coords = validateCoordinatePair(dto.depotLat, dto.depotLng, 'depot');

    const created = await this.prisma.zone.create({
      name: dto.name,
      code: dto.code,
      depotLat: coords.lat,
      depotLng: coords.lng,
    });

    return enrichZoneWithGeography(created);
  }

  async update(id: string, dto: UpdateZoneDto) {
    const zone = await this.findOne(id);

    if (dto.code && dto.code !== zone.code) {
      const existingCode = await this.prisma.zone.where({ code: dto.code }).first();
      if (existingCode && existingCode.id !== id) {
        throw new ConflictException(`Ya existe una zona registrada con el código '${dto.code}'`);
      }
    }

    if (dto.name && dto.name !== zone.name) {
      const existingName = await this.prisma.zone.where({ name: dto.name }).first();
      if (existingName && existingName.id !== id) {
        throw new ConflictException(`Ya existe una zona registrada con el nombre '${dto.name}'`);
      }
    }

    const hasCoords = dto.depotLat !== undefined || dto.depotLng !== undefined;
    let coordUpdate = {};
    if (hasCoords) {
      const coords = validateCoordinatePair(dto.depotLat, dto.depotLng, 'depot');
      coordUpdate = { depotLat: coords.lat, depotLng: coords.lng };
    }

    const updated = await this.prisma.zone.where({ id }).update({
      ...(dto.name ? { name: dto.name } : {}),
      ...(dto.code ? { code: dto.code } : {}),
      ...coordUpdate,
    });

    if (!updated) {
      throw new NotFoundException(`Zona con ID '${id}' no encontrada`);
    }

    return enrichZoneWithGeography(updated);
  }

  async remove(id: string) {
    await this.findOne(id);

    const associatedOrders = await this.prisma.order.where({ zoneId: id }).first();
    if (associatedOrders) {
      throw new ConflictException('No se puede eliminar la zona porque tiene pedidos asociados');
    }

    const associatedRoutes = await this.prisma.route.where({ zoneId: id }).first();
    if (associatedRoutes) {
      throw new ConflictException('No se puede eliminar la zona porque tiene rutas asociadas');
    }

    return this.prisma.zone.where({ id }).delete();
  }
}

