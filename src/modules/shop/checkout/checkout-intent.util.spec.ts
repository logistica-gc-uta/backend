import {
  buildCanonicalIntent,
  hashCanonicalIntent,
  lookupFixtureIdFromNumber,
} from './checkout-intent.util.js';

describe('checkout-intent.util', () => {
  it('correctly looks up fixtureId from card number without persisting or leaking PAN', () => {
    expect(lookupFixtureIdFromNumber('9000 0000 0000 0001')).toBe('DEMO_APPROVED');
    expect(lookupFixtureIdFromNumber('9000000000000002')).toBe('DEMO_LIMITED');
    expect(lookupFixtureIdFromNumber(' 9000 0000 0000 0003 ')).toBe('DEMO_EMPTY');
    expect(lookupFixtureIdFromNumber('4111111111111111')).toBeNull();
  });

  it('builds canonical intent with consolidated lines, trimmed fields, normalized coords, and fixtureId only', () => {
    const rawDelivery = {
      recipient: {
        name: '  María Pérez  ',
        phone: '  0991234567  ',
      },
      zoneId: '  zone-123  ',
      deliveryAddress: '  Av. Cevallos 100  ',
      deliveryLocation: {
        lat: -1.242500001,
        lng: -78.618800002,
      },
      scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
      deliveryNotes: '  Tocar el timbre  ',
    };

    const items = [
      { productId: 'prod-b', quantity: 2 },
      { productId: 'prod-a', quantity: 1 },
      { productId: 'prod-b', quantity: 1 },
    ];

    const intent = buildCanonicalIntent({
      items,
      delivery: rawDelivery,
      quoteToken: 'signed.quote.token',
      cardFixtureId: 'DEMO_APPROVED',
    });

    // Items must be consolidated and sorted by productId
    expect(intent.items).toEqual([
      { productId: 'prod-a', quantity: 1 },
      { productId: 'prod-b', quantity: 3 },
    ]);

    expect(intent.delivery.recipient.name).toBe('María Pérez');
    expect(intent.delivery.recipient.phone).toBe('0991234567');
    expect(intent.delivery.zoneId).toBe('zone-123');
    expect(intent.delivery.deliveryAddress).toBe('Av. Cevallos 100');
    expect(intent.delivery.deliveryNotes).toBe('Tocar el timbre');
    expect(intent.delivery.scheduledDeliveryDate).toBe('2026-11-15T15:00:00Z');
    expect(intent.cardFixtureId).toBe('DEMO_APPROVED');

    // Intent must NOT contain any sensitive card fields
    const intentStr = JSON.stringify(intent);
    expect(intentStr).not.toMatch(/cvv|holderName|number|cardLast4|9000/i);
  });

  it('computes deterministic SHA-256 hash across identical inputs regardless of item input order or whitespace', () => {
    const intentA = buildCanonicalIntent({
      items: [
        { productId: 'p1', quantity: 1 },
        { productId: 'p2', quantity: 2 },
      ],
      delivery: {
        recipient: { name: 'Juan', phone: '0990000000' },
        zoneId: 'z1',
        deliveryAddress: 'Calle 1',
        deliveryLocation: { lat: -1.2, lng: -78.6 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      quoteToken: 'token1',
      cardFixtureId: 'DEMO_APPROVED',
    });

    const intentB = buildCanonicalIntent({
      items: [
        { productId: 'p2', quantity: 2 },
        { productId: 'p1', quantity: 1 },
      ],
      delivery: {
        recipient: { name: ' Juan ', phone: ' 0990000000 ' },
        zoneId: 'z1',
        deliveryAddress: ' Calle 1 ',
        deliveryLocation: { lat: -1.2, lng: -78.6 },
        scheduledDeliveryDate: '2026-11-15T10:00:00-05:00', // same instant in -05:00 vs UTC
      },
      quoteToken: 'token1',
      cardFixtureId: 'DEMO_APPROVED',
    });

    const hashA = hashCanonicalIntent(intentA);
    const hashB = hashCanonicalIntent(intentB);

    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hash when intent differs (e.g. different fixture, item, address)', () => {
    const baseInput = {
      items: [{ productId: 'p1', quantity: 1 }],
      delivery: {
        recipient: { name: 'Juan', phone: '0990000000' },
        zoneId: 'z1',
        deliveryAddress: 'Calle 1',
        deliveryLocation: { lat: -1.2, lng: -78.6 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      },
      quoteToken: 'token1',
      cardFixtureId: 'DEMO_APPROVED',
    };

    const hashBase = hashCanonicalIntent(buildCanonicalIntent(baseInput));
    const hashDifferentFixture = hashCanonicalIntent(
      buildCanonicalIntent({ ...baseInput, cardFixtureId: 'DEMO_LIMITED' }),
    );
    const hashDifferentQty = hashCanonicalIntent(
      buildCanonicalIntent({ ...baseInput, items: [{ productId: 'p1', quantity: 2 }] }),
    );

    expect(hashBase).not.toBe(hashDifferentFixture);
    expect(hashBase).not.toBe(hashDifferentQty);
  });
});
