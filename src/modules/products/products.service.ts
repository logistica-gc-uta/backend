import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { legacyPriceCents } from '../../common/money-cents.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateStockDto } from './dto/update-stock.dto.js';
import { lockInventoryProduct, MAX_INVENTORY_QUANTITY } from '../orders/order-inventory.util.js';
import { deliveryClock } from '../orders/order-delivery.util.js';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  private legacyProduct(product: { id: string; name: string; description: string | null; price: number; stock: number; createdAt: Temporal.Instant }) {
    return { id: product.id, name: product.name, description: product.description, price: product.price, stock: product.stock, createdAt: product.createdAt };
  }

  async findAll() {
    const rows = await this.prisma.product.where((p) => p.stock.gt(0))
      .select('id', 'name', 'description', 'price', 'stock', 'createdAt').all();
    return rows.map(row => this.legacyProduct(row));
  }

  async findOne(id: string) {
    const product = await this.prisma.product.where({ id })
      .select('id', 'name', 'description', 'price', 'stock', 'createdAt').first();
    if (!product) {
      throw new NotFoundException(`Producto con ID '${id}' no encontrado`);
    }
    return this.legacyProduct(product);
  }

  async create(dto: CreateProductDto) {
    const id = randomUUID();
    const cents = legacyPriceCents(dto.price);
    if (!Number.isSafeInteger(dto.stock) || dto.stock < 0 || dto.stock > MAX_INVENTORY_QUANTITY) {
      throw new BadRequestException('Stock must be a nonnegative supported integer');
    }
    const product = await this.prisma.product.create({
      id, sku: `LEGACY-${id}`, name: dto.name,
      description: dto.description ?? null, price: dto.price, priceCents: cents,
      stock: dto.stock, isPublished: false,
    });
    return this.legacyProduct(product);
  }

  async updateStock(id: string, dto: UpdateStockDto) {
    if (!Number.isSafeInteger(dto.stock) || dto.stock < 0 || dto.stock > MAX_INVENTORY_QUANTITY) {
      throw new BadRequestException('Stock must be a nonnegative supported integer');
    }
    // Intentional absolute-set, not a delta. Share row-lock serialization with orders.
    return this.prisma.client.transaction(async (tx) => {
      await lockInventoryProduct(tx, this.prisma.client.raw, id);
      const updatedAt = await deliveryClock(tx, this.prisma.client.raw);
      const product = await tx.orm.public.Product.where({ id }).update({ stock: dto.stock, updatedAt });
      return product ? this.legacyProduct(product) : product;
    });
  }
}
