import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy.js';
import type { PrismaService } from '../../database/prisma.service.js';

function strategy(options: { user?: Record<string, unknown> | null; driver?: Record<string, unknown> | null }) {
  const prisma = {
    user: { where: jest.fn(() => ({ first: jest.fn(async () => options.user ?? null) })) },
    client: { orm: { public: { Driver: { where: jest.fn(() => ({ first: jest.fn(async () => options.driver ?? null) })) } } } },
  } as unknown as PrismaService;
  return { strategy: new JwtStrategy(prisma), prisma };
}

describe('JwtStrategy (#82: la sesión previa a una baja deja de valer)', () => {
  const payload = { sub: 'u1', email: 'x@y.test', role: 'DRIVER' };

  it('un usuario inexistente es 401', async () => {
    await expect(strategy({ user: null }).strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('un repartidor activo conserva su sesión', async () => {
    const { strategy: s } = strategy({ user: { id: 'u1', email: 'x@y.test', role: 'DRIVER' }, driver: { id: 'd', isActive: true } });
    await expect(s.validate(payload)).resolves.toEqual({ userId: 'u1', email: 'x@y.test', role: 'DRIVER' });
  });

  it('un repartidor dado de baja recibe 401 DRIVER_INACTIVE aunque su token no haya vencido', async () => {
    const { strategy: s } = strategy({ user: { id: 'u1', email: 'x@y.test', role: 'DRIVER' }, driver: { id: 'd', isActive: false } });
    await expect(s.validate(payload)).rejects.toMatchObject({ status: 401, response: expect.objectContaining({ code: 'DRIVER_INACTIVE' }) });
  });

  it('ADMIN y CLIENT no consultan el estado de repartidor', async () => {
    for (const role of ['ADMIN', 'CLIENT']) {
      const { strategy: s, prisma } = strategy({ user: { id: 'u1', email: 'x@y.test', role }, driver: { isActive: false } });
      await expect(s.validate({ ...payload, role })).resolves.toMatchObject({ role });
      expect((prisma as any).client.orm.public.Driver.where).not.toHaveBeenCalled();
    }
  });
});
