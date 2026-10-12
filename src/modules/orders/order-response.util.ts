import type { Scalars } from '@prisma/orm-postgres/family-contract/types';
import type { Models } from '../../prisma/contract.d.js';
import { enrichOrderWithGeography } from './order-geography.util.js';

type Product = Partial<Scalars<Models.public_Product>>;
type Item = Partial<Scalars<Models.public_OrderItem>> & { product?: Product };
type Source = Partial<Scalars<Models.public_Order>> & {
  items?: Item[];
  zone?: Partial<Scalars<Models.public_Zone>> | null;
  user?: { id: string; name: string } | null;
};

/** Explicit API allowlist. Call only AFTER authorization; phone permission is not authorization. */
export function projectOrder(order: Source, includeContact: boolean) {
  const result = {
    id: order.id,
    userId: order.userId ?? null,
    createdById: order.createdById ?? null,
    recipientType: order.recipientType ?? null,
    recipientName: order.recipientName ?? null,
    ...(includeContact ? { recipientPhone: order.recipientPhone ?? null } : {}),
    deliveryWindowStart: order.deliveryWindowStart ?? null,
    deliveryWindowEnd: order.deliveryWindowEnd ?? null,
    zoneId: order.zoneId,
    deliveryAddress: order.deliveryAddress,
    deliveryLat: order.deliveryLat ?? null,
    deliveryLng: order.deliveryLng ?? null,
    scheduledDeliveryDate: order.scheduledDeliveryDate ?? null,
    status: order.status,
    total: order.total,
    routeId: order.routeId ?? null,
    stopOrder: order.stopOrder ?? null,
    createdAt: order.createdAt,
    ...(order.user !== undefined ? { user: order.user ? { id: order.user.id, name: order.user.name } : null } : {}),
    ...(order.items !== undefined ? { items: order.items.map((item) => ({
      id: item.id, orderId: item.orderId, productId: item.productId,
      quantity: item.quantity, price: item.price,
      ...(item.product ? { product: {
        id: item.product.id, name: item.product.name,
        description: item.product.description ?? null, price: item.product.price,
        stock: item.product.stock, createdAt: item.product.createdAt,
      } } : {}),
    })) } : {}),
    ...(order.zone !== undefined ? { zone: order.zone ? {
      id: order.zone.id, name: order.zone.name, code: order.zone.code,
      depotLat: order.zone.depotLat ?? null, depotLng: order.zone.depotLng ?? null,
      createdAt: order.zone.createdAt,
    } : null } : {}),
  };
  return order.zone !== undefined ? enrichOrderWithGeography(result) : result;
}
