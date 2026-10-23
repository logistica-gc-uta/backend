import { randomUUID } from 'node:crypto';
import { AdminOrdersDatabase } from './admin-guest-orders-migration.fixtures';

export const actors = {
  admin: 'b-admin', admin2: 'b-admin2', client: 'b-client',
  foreign: 'b-foreign', driver: 'b-driver', otherDriver: 'b-other-driver',
} as const;

export function seedAdminApi(database: AdminOrdersDatabase): void {
  for (const [key, id] of Object.entries(actors)) {
    const role = key.startsWith('admin') ? 'ADMIN' : key.toLowerCase().includes('driver') ? 'DRIVER' : 'CLIENT';
    database.sql('unit_b', `INSERT INTO public."user" (id,name,email,password,role) VALUES
      ('${id}','Profile ${key}','${id}@example.test','private-hash','${role}')`);
  }
  database.sql('unit_b', `
    INSERT INTO public.zone (id,name,code,"depotLat","depotLng") VALUES ('b-zone','B zone','BZ',-1.2,-78.6);
    INSERT INTO public.zone (id,name,code) VALUES ('b-no-depot','No depot','ND');
    INSERT INTO public.product (id,name,price,stock) VALUES ('b-product','Product',10,10000);
    INSERT INTO public.driver (id,"userId",vehicle) VALUES ('b-driver-profile','b-driver','van'),('b-other-profile','b-other-driver','van');
    INSERT INTO public.route (id,"driverId","zoneId") VALUES ('b-route','b-driver-profile','b-zone');
  `);
}

export function prepareOwnedApiDatabase(database: AdminOrdersDatabase): string {
  if (process.env.DATABASE_URL) throw new Error('Refusing inherited DATABASE_URL before app imports');
  database.start();
  database.create('unit_b');
  // Preserve the historical fixture origin, then exercise the current additive edge.
  database.prisma('unit_b', 'migrate', 'e357d1aa2fdc74464e729ec7cd8bb087b979a13b22e0f88aa005b60be4c16427');
  seedAdminApi(database);
  database.prisma('unit_b', 'migrate', 'b263aff9f248d0da2ead5a0700a5b035ab3653ec79e1f8c651ab5f936e21e1ea');
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DATABASE_URL = database.ownedUrl('unit_b');
  process.env.JWT_SECRET = randomUUID();
  return process.env.JWT_SECRET;
}

// A known calendar day in a future year keeps boundary tests stable as time advances.
export const fixtureYear = new Date().getUTCFullYear() + 2;
export const calendar = (iso: string) => iso.replace('2030', String(fixtureYear));

export function guestBody() {
  return {
    recipient: { type: 'GUEST', name: '  Guest Name  ', contactPhone: '  +593 99 123 4567  ' },
    zoneId: 'b-zone', deliveryAddress: 'Confirmed address',
    deliveryLat: -1.2, deliveryLng: -78.6,
    scheduledDeliveryDate: calendar('2030-02-14T15:00:00Z'),
    items: [{ productId: 'b-product', quantity: 1 }],
  };
}
