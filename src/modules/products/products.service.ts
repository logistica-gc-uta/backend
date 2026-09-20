import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateStockDto } from './dto/update-stock.dto.js';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.product.where((p) => p.stock.gt(0)).all();
  }

  async findOne(id: string) {
    const product = await this.prisma.product.where({ id }).first();
    if (!product) {
      throw new NotFoundException(`Producto con ID '${id}' no encontrado`);
    }
    return product;
  }

  async create(dto: CreateProductDto) {
    return this.prisma.product.create({
      name: dto.name,
      description: dto.description ?? null,
      price: dto.price,
      stock: dto.stock,
    });
  }

  async updateStock(id: string, dto: UpdateStockDto) {
    await this.findOne(id);

    const updated = await this.prisma.product
      .where({ id })
      .update({ stock: dto.stock });

    return updated;
  }
}
