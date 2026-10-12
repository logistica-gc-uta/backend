import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateStockDto } from './dto/update-stock.dto.js';
import { lockInventoryProduct, MAX_INVENTORY_QUANTITY } from '../orders/order-inventory.util.js';

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
    if (!Number.isSafeInteger(dto.stock) || dto.stock < 0 || dto.stock > MAX_INVENTORY_QUANTITY) {
      throw new BadRequestException('Stock must be a nonnegative supported integer');
    }
    // Intentional absolute-set, not a delta. Share row-lock serialization with orders.
    return this.prisma.client.transaction(async (tx) => {
      await lockInventoryProduct(tx, this.prisma.client.raw, id);
      return tx.orm.public.Product.where({ id }).update({ stock: dto.stock });
    });
  }
}
