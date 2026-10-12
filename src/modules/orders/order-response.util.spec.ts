import { projectOrder } from './order-response.util.js';

const source = {
  id: 'order', userId: 'client', createdById: 'admin',
  recipientType: 'REGISTERED_CLIENT' as const, recipientName: 'Snapshot', recipientPhone: '+593',
  zoneId: 'zone', deliveryAddress: 'Address', deliveryLat: -1, deliveryLng: -78,
  status: 'PENDING' as const, total: 10, requiresAdministrativeReview: true,
  user: { id: 'client', name: 'Current profile', password: 'secret', email: 'private@test', role: 'CLIENT' },
  createdBy: { password: 'actor-secret' },
  route: { private: 'not authorized' },
  items: [{ id: 'line', orderId: 'order', productId: 'product', quantity: 1, price: 10,
    internal: 'hidden', product: { id: 'product', name: 'Product', stock: 1, price: 10, private: 'hidden' } }],
  zone: { id: 'zone', name: 'Zone', code: 'Z', depotLat: -1, depotLng: -78, private: 'hidden' },
};

describe('order response allowlist', () => {
  it('allows only documented scalar/related shapes even if query adds sensitive relations', () => {
    const response = projectOrder(source, true);
    expect(response.user).toEqual({ id: 'client', name: 'Current profile' });
    expect(response.recipientPhone).toBe('+593');
    expect(Object.keys(response).sort()).toEqual([
      'id', 'userId', 'createdById', 'recipientType', 'recipientName', 'recipientPhone',
      'zoneId', 'deliveryAddress', 'deliveryLat', 'deliveryLng', 'scheduledDeliveryDate',
      'deliveryWindowStart', 'deliveryWindowEnd', 'status', 'total', 'routeId', 'stopOrder',
      'createdAt', 'user', 'items', 'zone', 'deliveryLocation', 'planningEligibility',
    ].sort());
    expect(JSON.stringify(response)).not.toMatch(/secret|private|password|email|internal/);
    expect(response.items![0]).not.toHaveProperty('internal');
    expect(response.items![0].product).not.toHaveProperty('private');
  });

  it('omits contact for CLIENT rather than implying that a stored contact is absent', () => {
    expect(projectOrder(source, false)).not.toHaveProperty('recipientPhone');
  });

  it('preserves truthful null historical metadata and guest owner instead of inferring identities', () => {
    const response = projectOrder({ id: 'history', userId: 'client' }, true);
    expect(response).toMatchObject({
      userId: 'client', createdById: null, recipientType: null, recipientName: null,
      recipientPhone: null, deliveryWindowStart: null, deliveryWindowEnd: null,
    });
    expect(projectOrder({ id: 'guest', userId: null, user: null }, true).user).toBeNull();
  });
});
