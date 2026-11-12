import { DriversService } from './drivers.service.js';

/** Base de datos en memoria con la forma mínima del ORM y del constructor SQL que usa el alta/corrección (#43). */
function setup(options: { users?: any[]; drivers?: any[]; failDriverCreate?: boolean; failUserUpdate?: boolean; uniqueViolationOnUserCreate?: boolean } = {}) {
  const tables: Record<string, any[]> = {
    User: options.users ?? [],
    Driver: options.drivers ?? [],
  };
  const match = (filter: Record<string, unknown>) => (row: any) => Object.entries(filter).every(([key, value]) => row[key] === value);
  let counter = 0;
  const model = (name: string) => ({
    where: (filter: Record<string, unknown>) => ({
      first: async () => tables[name]!.find(match(filter)) ?? null,
      all: async () => tables[name]!.filter(match(filter)),
      include: () => ({ first: async () => withUser(tables[name]!.find(match(filter))) }),
      update: async (value: Record<string, unknown>) => {
        if (options.failUserUpdate && name === 'User') return null;
        const row = tables[name]!.find(match(filter));
        return row ? Object.assign(row, value) : null;
      },
    }),
    create: async (value: any) => {
      if (options.uniqueViolationOnUserCreate && name === 'User') throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'user_email_key' });
      if (options.failDriverCreate && name === 'Driver') throw new Error('fallo inyectado');
      const row = { id: `${name}-${++counter}`, createdAt: Temporal.Now.instant(), ...value };
      tables[name]!.push(row);
      return row;
    },
  });
  const withUser = (driver: any) => {
    if (!driver) return null;
    const user = tables.User!.find((u) => u.id === driver.userId);
    return { ...driver, user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt } };
  };
  const orm = { public: { User: model('User'), Driver: model('Driver') } };
  // `raw.sql` consulta si el correo ya existe (en minúsculas) fuera del usuario excluido.
  const raw = {
    sql: (_parts: TemplateStringsArray, email: string, exceptUserId: string) => ({
      returnsRow: () => ({ build: () => ({ email, exceptUserId }) }),
    }),
  };
  const snapshot = () => JSON.stringify(tables);
  const client = {
    orm,
    raw,
    transaction: jest.fn(async (fn: any) => {
      const before = snapshot();
      const tx = {
        orm,
        query: async (query: { email: string; exceptUserId: string }) =>
          tables.User!.filter((u) => u.email.toLowerCase() === query.email && u.id !== query.exceptUserId).map((u) => ({ id: u.id })),
      };
      try {
        return await fn(tx);
      } catch (error) {
        const restored = JSON.parse(before) as Record<string, any[]>;
        for (const key of Object.keys(tables)) tables[key]!.splice(0, tables[key]!.length, ...restored[key]!);
        throw error;
      }
    }),
  };
  const prisma: any = { client, driver: { where: (filter: any) => ({ include: () => ({ first: async () => withUser(tables.Driver!.find(match(filter))) }) }) } };
  const availability: any = { effective: jest.fn(async () => ({ isAvailable: true, blockingRouteIds: [] })) };
  return { tables, client, service: new DriversService(prisma, availability, {} as any) };
}

const existing = () => ({
  users: [
    { id: 'u-admin', name: 'Otro', email: 'ocupado@delivery.com', role: 'CLIENT', createdAt: Temporal.Now.instant() },
    { id: 'u-driver', name: 'Carlos', email: 'carlos@delivery.com', role: 'DRIVER', createdAt: Temporal.Now.instant() },
  ],
  drivers: [{ id: 'driver', userId: 'u-driver', vehicle: 'Moto', isAvailable: false, createdAt: Temporal.Now.instant() }],
});

describe('DriversService (#43): alta y corrección con una base de datos en memoria', () => {
  describe('create', () => {
    it('crea la identidad DRIVER y el perfil, y devuelve la contraseña temporal solo una vez', async () => {
      const { service, tables } = setup();
      const result = await service.create({ name: ' Ana Chofer ', email: 'Ana@Delivery.com', vehicle: ' Camioneta ' });
      expect(result).toMatchObject({ vehicle: 'Camioneta', isAvailable: true, user: { name: 'Ana Chofer', email: 'ana@delivery.com', role: 'DRIVER' } });
      expect(result.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(tables.User![0]!.password).not.toContain(result.temporaryPassword);
      expect(tables.User![0]!.password).toMatch(/^bcrypt-sha256:v1:/);
      expect(tables.Driver).toHaveLength(1);
    });

    it('un correo ya registrado (sin distinguir mayúsculas) da EMAIL_ALREADY_EXISTS sin crear nada', async () => {
      const { service, tables } = setup(existing());
      await expect(service.create({ name: 'Ana', email: 'OCUPADO@delivery.com', vehicle: 'Moto' })).rejects.toMatchObject({ response: { code: 'EMAIL_ALREADY_EXISTS' } });
      expect(tables.User).toHaveLength(2);
      expect(tables.Driver).toHaveLength(1);
    });

    it('una violación de unicidad concurrente también se traduce a EMAIL_ALREADY_EXISTS', async () => {
      const { service } = setup({ uniqueViolationOnUserCreate: true });
      await expect(service.create({ name: 'Ana', email: 'nueva@delivery.com', vehicle: 'Moto' })).rejects.toMatchObject({ response: { code: 'EMAIL_ALREADY_EXISTS' } });
    });

    it('si falla la creación del perfil se revierte la identidad y el error se propaga', async () => {
      const { service, tables } = setup({ failDriverCreate: true });
      await expect(service.create({ name: 'Ana', email: 'nueva@delivery.com', vehicle: 'Moto' })).rejects.toThrow('fallo inyectado');
      expect(tables.User).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('corrige nombre, correo y vehículo sin tocar isAvailable ni el rol', async () => {
      const { service, tables } = setup(existing());
      const result = await service.update('driver', { name: ' Carlos Corregido ', email: 'Nuevo@Delivery.com', vehicle: ' Furgoneta ' });
      expect(result).toMatchObject({ vehicle: 'Furgoneta', isAvailable: false, user: { name: 'Carlos Corregido', email: 'nuevo@delivery.com', role: 'DRIVER' } });
      expect(tables.Driver![0]!.isAvailable).toBe(false);
    });

    it('acepta una corrección parcial: solo el vehículo, solo el nombre o solo el correo', async () => {
      const { service } = setup(existing());
      expect(await service.update('driver', { vehicle: 'Camión' })).toMatchObject({ vehicle: 'Camión', user: { name: 'Carlos' } });
      expect(await service.update('driver', { name: 'Solo Nombre' })).toMatchObject({ vehicle: 'Camión', user: { name: 'Solo Nombre' } });
      expect(await service.update('driver', { email: 'solo@delivery.com' })).toMatchObject({ user: { email: 'solo@delivery.com' } });
    });

    it('conservar el mismo correo no es un conflicto', async () => {
      const { service } = setup(existing());
      await expect(service.update('driver', { email: 'CARLOS@delivery.com' })).resolves.toMatchObject({ user: { email: 'carlos@delivery.com' } });
    });

    it('un correo de otro usuario da EMAIL_ALREADY_EXISTS y no cambia ningún otro campo', async () => {
      const { service, tables } = setup(existing());
      await expect(service.update('driver', { name: 'No debe guardarse', vehicle: 'Tampoco', email: 'ocupado@delivery.com' })).rejects.toMatchObject({ response: { code: 'EMAIL_ALREADY_EXISTS' } });
      expect(tables.User!.find((u) => u.id === 'u-driver')!.name).toBe('Carlos');
      expect(tables.Driver![0]!.vehicle).toBe('Moto');
    });

    it('un repartidor inexistente da 404', async () => {
      const { service } = setup(existing());
      await expect(service.update('nadie', { name: 'Ana' })).rejects.toMatchObject({ status: 404 });
    });

    it('si la identidad no se puede actualizar da 404 y la corrección del vehículo no se aplica', async () => {
      const { service, tables } = setup({ ...existing(), failUserUpdate: true });
      await expect(service.update('driver', { name: 'Ana', vehicle: 'Otro' })).rejects.toMatchObject({ status: 404 });
      expect(tables.Driver![0]!.vehicle).toBe('Moto');
    });

    it('una violación de unicidad concurrente al corregir se traduce a EMAIL_ALREADY_EXISTS', async () => {
      const { service, client } = setup(existing());
      client.transaction.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505', constraint: 'user_email_key' }));
      await expect(service.update('driver', { email: 'otro@delivery.com' })).rejects.toMatchObject({ response: { code: 'EMAIL_ALREADY_EXISTS' } });
    });
  });
});
