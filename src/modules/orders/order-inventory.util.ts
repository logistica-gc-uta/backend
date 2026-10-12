import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];
// Product.stock and OrderItem.quantity are PostgreSQL int4 in the emitted contract.
export const MAX_INVENTORY_QUANTITY = 2147483647;

export function consolidateOrderItems(items: ReadonlyArray<{ productId: string; quantity: number }>) {
  if (!items.length) throw new BadRequestException('Order items are required');
  const quantities = new Map<string, number>();
  for (const { productId, quantity } of items) {
    if (typeof productId !== 'string' || !productId.trim() || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_INVENTORY_QUANTITY) {
      throw new BadRequestException('Invalid product quantity');
    }
    const aggregate = (quantities.get(productId) ?? 0) + quantity;
    if (!Number.isSafeInteger(aggregate) || aggregate > MAX_INVENTORY_QUANTITY) {
      throw new BadRequestException('Product quantity exceeds supported inventory range');
    }
    quantities.set(productId, aggregate);
  }
  // Codepoint ordering is stable across locales and all callers.
  return [...quantities].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([productId, quantity]) => ({ productId, quantity }));
}

export async function lockInventoryProduct(tx: Transaction, raw: Client['raw'], productId: string) {
  // raw constructs a parameterized plan only; tx.query executes on the callback's
  // pinned connection. The lock and current stock/price live until commit/rollback.
  const plan = raw.sql`SELECT id, name, price, stock FROM public.product WHERE id = ${productId} FOR UPDATE`
    .returnsRow({ id: 'pg/text@1', name: 'pg/text@1', price: 'pg/float8@1', stock: 'pg/int4@1' }).build();
  const [product] = await tx.query(plan);
  if (!product) throw new NotFoundException(`Producto con ID '${productId}' no encontrado`);
  return product;
}
