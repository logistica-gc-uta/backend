import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { RoutePlanningController } from './route-planning.controller.js';

describe('RoutePlanningController', () => {
  it('delega la consulta al servicio de planificación', async () => {
    const proposal = { date: '2030-02-14', proposals: [], excluded: [] };
    const planning: any = { propose: jest.fn().mockResolvedValue(proposal) };
    const controller = new RoutePlanningController(planning);
    const query = { date: '2030-02-14', zoneId: '2f782f43-6ec2-41ff-875f-c4c93d303fa4' };

    await expect(controller.propose(query)).resolves.toBe(proposal);

    expect(planning.propose).toHaveBeenCalledWith(query);
  });

  it('solo permite el rol ADMIN y exige JWT + rol (guards a nivel de clase)', () => {
    const handler = Object.getOwnPropertyDescriptor(RoutePlanningController.prototype, 'propose')?.value;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['ADMIN']);
    const guards: unknown[] = Reflect.getMetadata('__guards__', RoutePlanningController);
    expect(guards.map((guard: any) => guard.name)).toEqual(['JwtAuthGuard', 'RolesGuard']);
  });

  it('se publica en /route-proposals, fuera de /routes/:id', () => {
    expect(Reflect.getMetadata('path', RoutePlanningController)).toBe('route-proposals');
  });
});
