import {
  AdminOrdersDatabase,
  ADMIN_ORDERS_ORIGIN,
} from './admin-guest-orders-migration.fixtures.js';
import {
  LEGACY_ROUTE_FIXTURE,
  ROUTE_BASELINE_HASH,
} from './route-lifecycle-migration.fixtures.js';

const metadata = [
  'createdById', 'recipientType', 'recipientName', 'recipientPhone',
  'deliveryWindowStart', 'deliveryWindowEnd',
];

describe('Admin guest orders persistence migration', () => {
  const db = new AdminOrdersDatabase();
  const legacy = 'unit_a_legacy';
  const fresh = 'unit_a_fresh';

  beforeAll(() => {
    db.start();
    db.create(legacy);
    db.prisma(legacy, 'migrate', ROUTE_BASELINE_HASH);
    db.sql(legacy, LEGACY_ROUTE_FIXTURE);
    db.sql(legacy, `UPDATE public."order" SET "scheduledDeliveryDate" = '2000-01-01T00:00:00Z'
      WHERE id = 'order-one';`);
    db.prisma(legacy, 'migrate', ADMIN_ORDERS_ORIGIN);
    db.sql(legacy, `INSERT INTO public."orderClaim" (id, "routeId", "orderId")
      VALUES ('preserved-claim', 'legacy-a', 'order-one');`);
    db.prisma(legacy, 'migrate');
    db.create(fresh);
    db.prisma(fresh, 'migrate');
    db.sql(fresh, `INSERT INTO public."user" (id, name, email, password, role)
      VALUES ('client', 'Client', 'client@fixture.invalid', 'fixture', 'CLIENT'),
      ('admin', 'Admin', 'admin@fixture.invalid', 'fixture', 'ADMIN');
      INSERT INTO public.zone (id, name, code) VALUES ('zone', 'Fresh', 'FRESH');`);
  }, 120000);

  afterAll(() => db.stop(), 30000);

  it('adds nullable owner and metadata columns on the real database', () => {
    const columns = db.sql(legacy, `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order' AND is_nullable = 'YES';`);
    expect(columns.split('\n')).toEqual(expect.arrayContaining(['userId', ...metadata]));
  });

  it('preserves owners, history and NULL metadata without fabricating users', () => {
    expect(db.sql(legacy, `SELECT COUNT(*) FROM public."order"
      WHERE "userId" = 'client' AND ${metadata.map((c) => `"${c}" IS NULL`).join(' AND ')};`)).toBe('4');
    expect(db.sql(legacy, `SELECT COUNT(*) FROM public."user";`)).toBe('3');
    expect(db.sql(legacy, `SELECT ("scheduledDeliveryDate" = '2000-01-01T00:00:00Z')::text
      FROM public."order" WHERE id = 'order-one';`)).toBe('true');
    expect(db.sql(legacy, `SELECT string_agg(id || ':' || status, ',' ORDER BY id)
      FROM public."order";`)).toBe(
      'order-duplicate:DELIVERED,order-invalid:CANCELLED,order-null:PENDING,order-one:ASSIGNED',
    );
    expect(db.sql(legacy, `SELECT COUNT(*) FROM public."routeStop" s
      JOIN public."order" o ON o.id = s."orderId" AND o."routeId" = s."routeId"
      WHERE s.sequence IS NOT DISTINCT FROM o."stopOrder" AND s."isLegacy";`)).toBe('4');
    expect(db.sql(legacy, `SELECT "orderId" || '|' || "routeId" FROM public."orderClaim"
      WHERE id = 'preserved-claim' AND "releasedAt" IS NULL;`)).toBe('order-one|legacy-a');
    expect(() => db.sql(legacy, `INSERT INTO public."orderClaim" (id, "routeId", "orderId")
      VALUES ('collision', 'legacy-b', 'order-one');`)).toThrow(/unique/i);
    expect(() => db.sql(legacy, `INSERT INTO public."routeStop" (id, "routeId", "orderId")
      VALUES ('collision', 'legacy-a', 'order-one');`)).toThrow(/legacy stop history/i);
  });

  function insert(id: string, overrides: Record<string, string> = {}): void {
    const values: Record<string, string> = {
      id: `'${id}'`, userId: 'NULL', zoneId: "'zone'", deliveryAddress: "'Fixture'",
      createdById: "'admin'", recipientType: "'GUEST'", recipientName: "'Guest'",
      recipientPhone: "'+593999999999'", ...overrides,
    };
    db.sql(fresh, `INSERT INTO public."order" (${Object.keys(values).map((c) => `"${c}"`).join(', ')})
      VALUES (${Object.values(values).join(', ')});`);
  }

  it('persists ADMIN-created registered and guest recipients without new accounts', () => {
    insert('guest');
    insert('registered', { userId: "'client'", recipientType: "'REGISTERED_CLIENT'", recipientPhone: 'NULL' });
    expect(db.sql(fresh, `SELECT id || '|' || COALESCE("userId", 'NULL') || '|' || "createdById"
      || '|' || "recipientType" || '|' || "recipientName" || '|' || COALESCE("recipientPhone", 'NULL')
      FROM public."order" ORDER BY id;`)).toBe(
      'guest|NULL|admin|GUEST|Guest|+593999999999\nregistered|client|admin|REGISTERED_CLIENT|Guest|NULL',
    );
    expect(db.sql(fresh, `SELECT COUNT(*) FROM public."user";`)).toBe('2');
  });

  it.each([
    ['guest-owned', { userId: "'client'" }],
    ['registered-ownerless', { recipientType: "'REGISTERED_CLIENT'" }],
    ['missing-creator', { createdById: 'NULL' }],
    ['missing-name', { recipientName: 'NULL' }],
    ['blank-name', { recipientName: "'   '" }],
    ['whitespace-name', { recipientName: "E'\\t\\n'" }],
    ['missing-phone', { recipientPhone: 'NULL' }],
    ['blank-phone', { recipientPhone: "'   '" }],
    ['whitespace-phone', { recipientPhone: "E'\\t\\n'" }],
    ['unclassified-ownerless', { recipientType: 'NULL' }],
    ['invalid-type', { recipientType: "'OTHER'" }],
    ['registered-blank-name', { userId: "'client'", recipientType: "'REGISTERED_CLIENT'", recipientName: "' '" }],
  ])('rejects invalid classified recipient %s', (id, values) => {
    expect(() => insert(id, values)).toThrow(/check/i);
  });

  it.each([
    ['invalid-creator', { createdById: "'missing'" }],
    ['invalid-owner', { userId: "'missing'", recipientType: "'REGISTERED_CLIENT'" }],
  ])('retains foreign key enforcement for %s', (id, values) => {
    expect(() => insert(id, values)).toThrow(/foreign key/i);
  });

  const window = {
    scheduledDeliveryDate: "'2030-02-14T15:00:00Z'",
    deliveryWindowStart: "'2030-02-14T14:00:00Z'",
    deliveryWindowEnd: "'2030-02-14T17:00:00Z'",
  };

  it('accepts optional windows and consistent instants across UTC midnight', () => {
    insert('window-valid', window);
    insert('window-at-start', { ...window, scheduledDeliveryDate: window.deliveryWindowStart });
    insert('window-at-end', { ...window, scheduledDeliveryDate: window.deliveryWindowEnd });
    insert('window-local-day', {
      scheduledDeliveryDate: "'2030-02-15T01:00:00Z'",
      deliveryWindowStart: "'2030-02-14T23:00:00Z'",
      deliveryWindowEnd: "'2030-02-15T02:00:00Z'",
    });
  });

  it.each([
    ['start-only', { deliveryWindowEnd: 'NULL' }],
    ['end-only', { deliveryWindowStart: 'NULL' }],
    ['reversed', { deliveryWindowEnd: "'2030-02-14T13:00:00Z'" }],
    ['equal', { deliveryWindowEnd: window.deliveryWindowStart }],
    ['no-scheduled', { scheduledDeliveryDate: 'NULL' }],
    ['scheduled-outside', { scheduledDeliveryDate: "'2030-02-14T18:00:00Z'" }],
    ['different-local-day', { deliveryWindowStart: "'2030-02-14T04:00:00Z'" }],
  ])('rejects invalid delivery window %s', (id, values) => {
    expect(() => insert(id, { ...window, ...values })).toThrow(/check/i);
  });

  it('retains verified RouteStop pair and sequence uniqueness', () => {
    insert('stop-order-a');
    insert('stop-order-b');
    db.sql(fresh, `INSERT INTO public.route (id, "zoneId", status) VALUES ('draft', 'zone', 'DRAFT');
      INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome)
      VALUES ('stop-a', 'draft', 'stop-order-a', 1, 'PENDING');
      INSERT INTO public."orderClaim" (id, "routeId", "orderId", "claimedAt")
      VALUES ('draft-claim', 'draft', 'stop-order-a', NOW());`);
    expect(() => db.sql(fresh, `INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome)
      VALUES ('pair-collision', 'draft', 'stop-order-a', 2, 'PENDING');`)).toThrow(/unique/i);
    expect(() => db.sql(fresh, `INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome)
      VALUES ('sequence-collision', 'draft', 'stop-order-b', 1, 'PENDING');`)).toThrow(/unique/i);
  });

  it('keeps existing unclassified CLIENT creation compatible', () => {
    insert('client-compatible', {
      userId: "'client'", createdById: 'NULL', recipientType: 'NULL',
      recipientName: 'NULL', recipientPhone: 'NULL',
      scheduledDeliveryDate: "'2000-01-01T00:00:00Z'",
    });
    expect(db.sql(fresh, `SELECT "userId" FROM public."order" WHERE id = 'client-compatible';`)).toBe('client');
  });

  it('verifies both actual migrated databases against the emitted contract', () => {
    expect(() => db.prisma(legacy, 'verify')).not.toThrow();
    expect(() => db.prisma(fresh, 'verify')).not.toThrow();
  }, 60000);
});
