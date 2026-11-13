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
      'buyerName', 'buyerPhone', 'contactRevision',
      'zoneId', 'deliveryAddress', 'deliveryLat', 'deliveryLng', 'scheduledDeliveryDate',
      'deliveryWindowStart', 'deliveryWindowEnd', 'status', 'total', 'routeId', 'stopOrder',
      'createdAt', 'user', 'items', 'zone', 'deliveryLocation', 'planningEligibility',
    ].sort());
    expect(JSON.stringify(response)).not.toMatch(/secret|private|password|email|internal/);
    expect(response.items![0]).not.toHaveProperty('internal');
    expect(response.items![0].product).not.toHaveProperty('private');
  });

  it('never exposes additive cent or catalog columns through nested legacy orders', () => {
    const response = projectOrder({ ...source, subtotalCents: 1000n,
      items: [{ ...source.items[0], unitPriceCents: 1000n,
        product: { ...source.items[0].product, priceCents: 1000n, sku: 'REG-001', isPublished: true } }],
    } as Parameters<typeof projectOrder>[0], true);
    expect(Object.keys(response.items![0].product!).sort()).toEqual(['id', 'name', 'description', 'price', 'stock', 'createdAt'].sort());
    expect(response).not.toHaveProperty('subtotalCents');
    expect(response.items![0]).not.toHaveProperty('unitPriceCents');
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

  it('projects pickup state cleanly when included and strips internal actor or request fields', () => {
    expect(projectOrder(source, true)).not.toHaveProperty('pickup');
    expect(projectOrder({ ...source, pickup: null }, true).pickup).toBeNull();

    const agreedAt = Temporal.Instant.from('2026-11-13T15:00:00Z');
    const confirmedAt = Temporal.Instant.from('2026-11-13T16:30:00Z');

    const pending = projectOrder(
      {
        ...source,
        pickup: {
          id: 'pickup-1',
          orderId: 'order',
          agreedAt,
          agreedById: 'secret-admin-1',
          agreementRequestId: 'secret-req-1',
          confirmedAt: null,
          confirmedById: null,
          confirmationRequestId: null,
        },
      } as Parameters<typeof projectOrder>[0],
      true,
    );
    expect(pending.pickup).toEqual({
      state: 'PENDING_PICKUP',
      agreedAt: '2026-11-13T15:00:00Z',
      pickedUpAt: null,
    });
    expect(JSON.stringify(pending.pickup)).not.toMatch(/secret|agreedById|confirmedById|RequestId/);

    const pickedUp = projectOrder(
      {
        ...source,
        pickup: {
          id: 'pickup-1',
          orderId: 'order',
          agreedAt,
          agreedById: 'secret-admin-1',
          agreementRequestId: 'secret-req-1',
          confirmedAt,
          confirmedById: 'secret-admin-2',
          confirmationRequestId: 'secret-req-2',
        },
      } as Parameters<typeof projectOrder>[0],
      false,
    );
    expect(pickedUp.pickup).toEqual({
      state: 'PICKED_UP',
      agreedAt: '2026-11-13T15:00:00Z',
      pickedUpAt: '2026-11-13T16:30:00Z',
    });
  });
});
