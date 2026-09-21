import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../dto/register.dto.js';
import { RolesGuard } from './roles.guard.js';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  function createMockExecutionContext(user?: any): ExecutionContext {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue({ user }),
      }),
    } as unknown as ExecutionContext;
  }

  it('debe permitir el acceso si no hay roles requeridos definidos', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const context = createMockExecutionContext({ role: Role.CLIENT });

    const result = guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('debe permitir el acceso si el arreglo de roles requeridos está vacío', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);
    const context = createMockExecutionContext({ role: Role.CLIENT });

    const result = guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('debe permitir el acceso si el rol del usuario coincide con los roles requeridos', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.ADMIN]);
    const context = createMockExecutionContext({ role: Role.ADMIN });

    const result = guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('debe lanzar ForbiddenException si no hay usuario o no tiene rol', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.ADMIN]);
    const contextWithoutUser = createMockExecutionContext(undefined);

    expect(() => guard.canActivate(contextWithoutUser)).toThrow(
      new ForbiddenException('Acceso no autorizado: rol no identificado'),
    );

    const contextWithEmptyUser = createMockExecutionContext({});
    expect(() => guard.canActivate(contextWithEmptyUser)).toThrow(
      new ForbiddenException('Acceso no autorizado: rol no identificado'),
    );
  });

  it('debe lanzar ForbiddenException si el rol del usuario no coincide con los requeridos', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.ADMIN]);
    const context = createMockExecutionContext({ role: Role.CLIENT });

    expect(() => guard.canActivate(context)).toThrow(
      new ForbiddenException('Acceso denegado: se requiere uno de los siguientes roles [ADMIN]'),
    );
  });
});
