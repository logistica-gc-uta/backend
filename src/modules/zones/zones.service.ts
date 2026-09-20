import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { CreateZoneDto } from './dto/create-zone.dto.js';

@Injectable()
export class ZonesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.zone.all();
  }

  async findOne(id: string) {
    const zone = await this.prisma.zone.where({ id }).first();
    if (!zone) {
      throw new NotFoundException(`Zona con ID '${id}' no encontrada`);
    }
    return zone;
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

    return this.prisma.zone.create({
      name: dto.name,
      code: dto.code,
    });
  }
}
