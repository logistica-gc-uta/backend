import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db } from './db.js';

async function main() {
  console.log('Iniciando seed de datos...');

  // 1. Zonas de entrega
  const zonesData = [
    { name: 'Centro', code: 'CEN-01' },
    { name: 'Ficoa', code: 'FIC-02' },
    { name: 'Huachi', code: 'HUA-03' },
  ];

  for (const z of zonesData) {
    const existing = await db.orm.public.Zone.where({ code: z.code }).first();
    if (!existing) {
      await db.orm.public.Zone.create(z);
      console.log(`Zona creada: ${z.name}`);
    }
  }

  // 2. Productos
  const productsData = [
    { name: 'Laptop HP Pavilion 15', description: 'Laptop para trabajo y estudio', price: 750.0, stock: 15 },
    { name: 'Mouse Inalámbrico Logitech', description: 'Mouse ergonómico silencioso', price: 25.5, stock: 50 },
    { name: 'Teclado Mecánico RGB', description: 'Teclado gamer switches azules', price: 60.0, stock: 30 },
    { name: 'Monitor LG 24 Pulgadas FHD', description: 'Monitor 75Hz panel IPS', price: 140.0, stock: 20 },
    { name: 'Auriculares Sony Bluetooth', description: 'Cancelación de ruido activa', price: 85.0, stock: 25 },
  ];

  for (const p of productsData) {
    const existing = await db.orm.public.Product.where({ name: p.name }).first();
    if (!existing) {
      await db.orm.public.Product.create(p);
      console.log(`Producto creado: ${p.name}`);
    }
  }

  // 3. Contraseñas hasheadas
  const adminPassword = await bcrypt.hash('admin123', 10);
  const driverPassword = await bcrypt.hash('driver123', 10);
  const clientPassword = await bcrypt.hash('client123', 10);

  // Usuario ADMIN
  const existingAdmin = await db.orm.public.User.where({ email: 'admin@delivery.com' }).first();
  if (!existingAdmin) {
    await db.orm.public.User.create({
      name: 'Administrador General',
      email: 'admin@delivery.com',
      password: adminPassword,
      role: 'ADMIN',
    });
    console.log('Usuario ADMIN creado (admin@delivery.com / admin123)');
  }

  // Usuario DRIVER 1 y registro Driver
  const existingDriver1User = await db.orm.public.User.where({ email: 'driver1@delivery.com' }).first();
  let driver1UserId = existingDriver1User?.id;
  if (!existingDriver1User) {
    const user = await db.orm.public.User.create({
      name: 'Carlos Chofer',
      email: 'driver1@delivery.com',
      password: driverPassword,
      role: 'DRIVER',
    });
    driver1UserId = user.id;
    console.log('Usuario DRIVER 1 creado (driver1@delivery.com / driver123)');
  }

  if (driver1UserId) {
    const existingDriver1 = await db.orm.public.Driver.where({ userId: driver1UserId }).first();
    if (!existingDriver1) {
      await db.orm.public.Driver.create({
        userId: driver1UserId,
        vehicle: 'Camión Isuzu ABC-123',
        isAvailable: true,
      });
      console.log('Registro de Chofer 1 creado (Camión Isuzu ABC-123)');
    }
  }

  // Usuario DRIVER 2 y registro Driver
  const existingDriver2User = await db.orm.public.User.where({ email: 'driver2@delivery.com' }).first();
  let driver2UserId = existingDriver2User?.id;
  if (!existingDriver2User) {
    const user = await db.orm.public.User.create({
      name: 'Luis Transportista',
      email: 'driver2@delivery.com',
      password: driverPassword,
      role: 'DRIVER',
    });
    driver2UserId = user.id;
    console.log('Usuario DRIVER 2 creado (driver2@delivery.com / driver123)');
  }

  if (driver2UserId) {
    const existingDriver2 = await db.orm.public.Driver.where({ userId: driver2UserId }).first();
    if (!existingDriver2) {
      await db.orm.public.Driver.create({
        userId: driver2UserId,
        vehicle: 'Furgoneta Renault XYZ-789',
        isAvailable: true,
      });
      console.log('Registro de Chofer 2 creado (Furgoneta Renault XYZ-789)');
    }
  }

  // Usuarios CLIENT
  const clientsData = [
    { name: 'Ana Cliente', email: 'client1@delivery.com', password: clientPassword, role: 'CLIENT' as const },
    { name: 'Pedro Comprador', email: 'client2@delivery.com', password: clientPassword, role: 'CLIENT' as const },
  ];

  for (const c of clientsData) {
    const existingClient = await db.orm.public.User.where({ email: c.email }).first();
    if (!existingClient) {
      await db.orm.public.User.create(c);
      console.log(`Usuario CLIENT creado: ${c.email} (password: client123)`);
    }
  }

  console.log('Seed completado exitosamente.');
}

main()
  .catch((e) => {
    console.error('Error durante el seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.close();
  });
