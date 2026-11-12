import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { emailAlreadyExists, isEmailUniqueViolation, normalizedEmail } from '../auth/email-identity.util.js';
import { DriversController } from './drivers.controller.js';
import { DriversService } from './drivers.service.js';
import { CreateDriverDto } from './dto/create-driver.dto.js';
import { UpdateDriverDto } from './dto/update-driver.dto.js';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const check = <T>(type: new () => T, value: unknown) => pipe.transform(value, { type: 'body', metatype: type });

describe('Gestión ADMIN de repartidores (#43): DTO de alta', () => {
  const valid = { name: '  Carlos Chofer ', email: '  CARLOS@Delivery.COM ', vehicle: ' Camioneta ' };

  it('recorta el nombre y el vehículo y normaliza el correo a minúsculas', async () => {
    expect(await check(CreateDriverDto, valid)).toMatchObject({ name: 'Carlos Chofer', email: 'carlos@delivery.com', vehicle: 'Camioneta' });
  });

  it.each([
    ['role', { role: 'ADMIN' }],
    ['isAvailable', { isAvailable: false }],
    ['userId', { userId: 'x' }],
    ['password', { password: 'claveElegida123' }],
  ])('rechaza el campo no permitido «%s» (el servidor decide rol, disponibilidad y credenciales)', async (_field, extra) => {
    await expect(check(CreateDriverDto, { ...valid, ...extra })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['nombre de un carácter', { name: 'A' }],
    ['nombre de 121 caracteres', { name: 'x'.repeat(121) }],
    ['correo inválido', { email: 'sin-arroba' }],
    ['vehículo vacío', { vehicle: '   ' }],
    ['vehículo de 121 caracteres', { vehicle: 'v'.repeat(121) }],
    ['nombre no textual', { name: 12345 }],
  ])('rechaza %s', async (_label, bad) => {
    await expect(check(CreateDriverDto, { ...valid, ...bad })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exige los tres campos', async () => {
    for (const field of ['name', 'email', 'vehicle'] as const) {
      const { [field]: _omitted, ...rest } = valid;
      await expect(check(CreateDriverDto, rest)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('Gestión ADMIN de repartidores (#43): DTO de corrección', () => {
  it('todos los campos son opcionales y se normalizan cuando llegan', async () => {
    expect(await check(UpdateDriverDto, { vehicle: '  Moto  ' })).toMatchObject({ vehicle: 'Moto' });
    expect(await check(UpdateDriverDto, { email: ' A@B.CO ' })).toMatchObject({ email: 'a@b.co' });
  });

  it.each([{ role: 'ADMIN' }, { isAvailable: true }, { userId: 'x' }, { name: 'A' }, { email: 'no' }, { vehicle: ' ' }])(
    'rechaza %j',
    async (bad) => {
      await expect(check(UpdateDriverDto, bad)).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});

describe('Gestión ADMIN de repartidores (#43): servicio y controlador', () => {
  it('una corrección sin ningún campo se rechaza antes de tocar la base de datos', async () => {
    const prisma: any = { client: { transaction: jest.fn() } };
    const service = new DriversService(prisma, {} as any, {} as any);
    await expect(service.update('id', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.client.transaction).not.toHaveBeenCalled();
  });

  it('el alta y la corrección delegan en el servicio y exigen el rol ADMIN', async () => {
    const service: any = { create: jest.fn().mockResolvedValue({ id: 'd1' }), update: jest.fn().mockResolvedValue({ id: 'd1' }) };
    const controller = new DriversController(service);
    const dto = { name: 'Carlos', email: 'c@d.co', vehicle: 'Moto' };

    expect(await controller.create(dto as CreateDriverDto)).toEqual({ id: 'd1' });
    expect(await controller.update('11111111-1111-4111-8111-111111111111', { vehicle: 'Camión' })).toEqual({ id: 'd1' });
    expect(service.create).toHaveBeenCalledWith(dto);
    expect(service.update).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', { vehicle: 'Camión' });

    for (const handler of [DriversController.prototype.create, DriversController.prototype.update]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.ADMIN]);
    }
  });
});

describe('Identidad por correo compartida con el registro público', () => {
  it('normaliza recortando y pasando a minúsculas', () => {
    expect(normalizedEmail('  Ana@Correo.COM ')).toBe('ana@correo.com');
  });

  it('el 409 conserva el código EMAIL_ALREADY_EXISTS', () => {
    expect(emailAlreadyExists().getResponse()).toMatchObject({ statusCode: 409, code: 'EMAIL_ALREADY_EXISTS' });
  });

  it('reconoce la violación de unicidad del correo, incluso anidada en `cause`, y no otras', () => {
    expect(isEmailUniqueViolation({ code: '23505', constraint: 'user_email_key' })).toBe(true);
    expect(isEmailUniqueViolation({ cause: { code: 'P2002', meta: { target: ['email'] } } })).toBe(true);
    expect(isEmailUniqueViolation({ code: '23505', constraint: 'driver_userId_key' })).toBe(false);
    expect(isEmailUniqueViolation(new Error('otra cosa'))).toBe(false);
    expect(isEmailUniqueViolation(undefined)).toBe(false);
  });
});
