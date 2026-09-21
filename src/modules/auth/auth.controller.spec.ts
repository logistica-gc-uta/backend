import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { Role } from './dto/register.dto.js';

describe('AuthController', () => {
  let controller: AuthController;
  let authServiceMock: any;

  beforeEach(async () => {
    authServiceMock = {
      register: jest.fn(),
      login: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: authServiceMock,
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('debe registrar un usuario llamando al servicio', async () => {
    const dto = {
      name: 'Test',
      email: 'test@example.com',
      password: 'password',
      role: Role.CLIENT,
    };
    const expected = { id: '1', ...dto };
    authServiceMock.register.mockResolvedValue(expected);

    const result = await controller.register(dto);
    expect(authServiceMock.register).toHaveBeenCalledWith(dto);
    expect(result).toEqual(expected);
  });

  it('debe hacer login llamando al servicio', async () => {
    const dto = { email: 'test@example.com', password: 'password' };
    const expected = { access_token: 'jwt-token', user: { id: '1', email: dto.email } };
    authServiceMock.login.mockResolvedValue(expected);

    const result = await controller.login(dto);
    expect(authServiceMock.login).toHaveBeenCalledWith(dto);
    expect(result).toEqual(expected);
  });
});
