import 'dotenv/config';
import { db } from './db.js';

// Pedidos DEMO/TEST con coordenadas para probar GET /route-proposals y, más
// adelante, las pruebas de volumen y carga. Es idempotente: cada pedido se
// identifica por una etiqueta única en deliveryAddress y nunca modifica ni
// borra registros existentes.
//
//   pnpm run seed:planning-demo [--orders 40] [--date 2030-02-14]
//
// --orders: pedidos por zona (por defecto 12).
// --date:   día de entrega; todos los pedidos usan las 10:00 de Guayaquil
//           (15:00Z) para que las propuestas sean confirmables.

const LABEL = 'DEMO/TEST planning';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

// Generador determinista: mismas coordenadas en cada ejecución.
function lcg(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

async function main() {
  const perZone = Number(arg('orders', '12'));
  const date = arg('date', '2030-02-14');
  if (!Number.isInteger(perZone) || perZone < 1 || perZone > 5000) {
    throw new Error('--orders debe ser un entero entre 1 y 5000');
  }
  const scheduled = Temporal.PlainDate.from(date, { overflow: 'reject' })
    .toZonedDateTime({ timeZone: 'America/Guayaquil', plainTime: '10:00' })
    .toInstant();

  const client = await db.orm.public.User.where({ email: 'client1@delivery.com' }).first();
  const product = await db.orm.public.Product.first();
  if (!client || !product) {
    throw new Error('Ejecute primero `pnpm run seed` (faltan cliente y productos base)');
  }

  const zones = await db.orm.public.Zone.all();
  let created = 0;
  let skipped = 0;
  for (const zone of zones) {
    if (zone.depotLat == null || zone.depotLng == null) {
      console.log(`Zona ${zone.code} sin depósito: se omite`);
      continue;
    }
    const rand = lcg(zone.code.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0));
    for (let n = 1; n <= perZone; n++) {
      // ~ ±1.1 km alrededor del depósito
      const lat = zone.depotLat + (rand() - 0.5) * 0.02;
      const lng = zone.depotLng + (rand() - 0.5) * 0.02;
      const address = `${LABEL} ${zone.code} ${date} #${String(n).padStart(4, '0')}`;
      if (await db.orm.public.Order.where({ deliveryAddress: address }).first()) {
        skipped++;
        continue;
      }
      const order = await db.orm.public.Order.create({
        userId: client.id,
        zoneId: zone.id,
        deliveryAddress: address,
        deliveryLat: Number(lat.toFixed(6)),
        deliveryLng: Number(lng.toFixed(6)),
        scheduledDeliveryDate: scheduled,
        status: 'PENDING',
        total: product.price,
      });
      await db.orm.public.OrderItem.create({
        orderId: order.id,
        productId: product.id,
        quantity: 1,
        price: product.price,
      });
      created++;
    }
  }
  console.log(
    `Pedidos demo para ${date} (${scheduled.toString()}): ${created} creados, ${skipped} ya existían.`,
  );
}

main()
  .catch((e) => {
    console.error('Error durante el seed de planificación:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.close();
  });
