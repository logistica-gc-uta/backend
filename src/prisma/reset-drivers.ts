import 'dotenv/config';
import { db } from './db.js';

// Cada asignación de ruta marca al repartidor como no disponible. Este script
// los libera para que la colección de Newman pueda ejecutarse repetidamente.
async function main() {
  const drivers = await db.orm.public.Driver.all();
  for (const driver of drivers) {
    if (!driver.isAvailable) {
      await db.orm.public.Driver.where({ id: driver.id }).update({ isAvailable: true });
    }
  }
  console.log(`Repartidores disponibles: ${drivers.length}`);
}

main()
  .catch((e) => {
    console.error('Error al reiniciar repartidores:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.close();
  });
