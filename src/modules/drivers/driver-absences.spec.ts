import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { DriverAbsencesController } from './driver-absences.controller.js';
import { DriverAbsencesService } from './driver-absences.service.js';
import {
  CancelDriverAbsenceDto,
  CreateDriverAbsenceDto,
  DriverAvailabilityQueryDto,
  ListDriverAbsencesQueryDto,
} from './dto/driver-absence.dto.js';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const check = <T>(type: new () => T, value: unknown) => pipe.transform(value, { type: 'body', metatype: type });
const todayPlus = (days: number) => Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate().add({ days }).toString();

describe('Ausencias (#44): DTO', () => {
  it('acepta un rango y recorta el motivo', async () => {
    expect(await check(CreateDriverAbsenceDto, { startDate: '2030-02-14', endDate: '2030-02-15', reason: '  Cita  ' })).toMatchObject({ reason: 'Cita' });
  });

  it.each([
    ['sin endDate', { startDate: '2030-02-14' }],
    ['fecha con formato distinto', { startDate: '14/02/2030', endDate: '2030-02-15' }],
    ['motivo vacío', { startDate: '2030-02-14', endDate: '2030-02-15', reason: '   ' }],
    ['motivo de 301 caracteres', { startDate: '2030-02-14', endDate: '2030-02-15', reason: 'x'.repeat(301) }],
    ['campo no permitido (cancelledAt)', { startDate: '2030-02-14', endDate: '2030-02-15', cancelledAt: 'x' }],
    ['campo no permitido (driverId)', { startDate: '2030-02-14', endDate: '2030-02-15', driverId: 'x' }],
  ])('rechaza %s', async (_label, body) => {
    await expect(check(CreateDriverAbsenceDto, body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('la anulación y las consultas solo admiten sus campos', async () => {
    await expect(check(CancelDriverAbsenceDto, { reason: 'ok' })).resolves.toMatchObject({ reason: 'ok' });
    await expect(check(CancelDriverAbsenceDto, { cancelledById: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check(ListDriverAbsencesQueryDto, { includeCancelled: 'true', from: '2030-01-01' })).resolves.toMatchObject({ includeCancelled: true });
    await expect(check(ListDriverAbsencesQueryDto, { includeCancelled: 'quizás' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check(DriverAvailabilityQueryDto, { date: 'mañana' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Ausencias (#44): reglas de fecha del servicio (se rechazan antes de tocar la base de datos)', () => {
  const prisma: any = { client: { transaction: jest.fn() }, driver: { where: jest.fn() } };
  const service = new DriverAbsencesService(prisma, {} as any);
  const rejects = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toMatchObject({ response: { code } });
    expect(prisma.client.transaction).not.toHaveBeenCalled();
  };

  it('una fecha de calendario inexistente se rechaza (INVALID_DATE)', async () => {
    await rejects(service.create('d', { startDate: '2030-02-30', endDate: '2030-03-01' }, 'admin'), 'INVALID_DATE');
  });

  it('una ausencia que empieza antes de hoy se rechaza (ABSENCE_DATE_IN_PAST); hoy y el futuro sí se aceptan', async () => {
    await rejects(service.create('d', { startDate: todayPlus(-1), endDate: todayPlus(1) }, 'admin'), 'ABSENCE_DATE_IN_PAST');
    prisma.client.transaction.mockRejectedValueOnce(new Error('llegó a la base de datos'));
    await expect(service.create('d', { startDate: todayPlus(0), endDate: todayPlus(0) }, 'admin')).rejects.toThrow('llegó a la base de datos');
  });

  it('un rango invertido se rechaza (ABSENCE_RANGE_INVALID)', async () => {
    prisma.client.transaction.mockClear();
    await rejects(service.create('d', { startDate: todayPlus(3), endDate: todayPlus(2) }, 'admin'), 'ABSENCE_RANGE_INVALID');
  });

  it('la disponibilidad de una fecha pasada se rechaza (AVAILABILITY_DATE_IN_PAST)', async () => {
    prisma.client.transaction.mockClear();
    await rejects(service.availabilityOn('d', todayPlus(-1)), 'AVAILABILITY_DATE_IN_PAST');
  });
});

describe('Ausencias (#44): controlador', () => {
  it('todas las operaciones exigen el rol ADMIN (a nivel de clase) y delegan en el servicio con el actor del JWT', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, DriverAbsencesController)).toEqual([Role.ADMIN]);
    const service: any = {
      create: jest.fn().mockResolvedValue({ id: 'a1' }),
      list: jest.fn().mockResolvedValue([]),
      cancel: jest.fn().mockResolvedValue({ id: 'a1' }),
      availabilityOn: jest.fn().mockResolvedValue({ isAvailable: true }),
    };
    const controller = new DriverAbsencesController(service);
    const driverId = '11111111-1111-4111-8111-111111111111';
    const absenceId = '22222222-2222-4222-8222-222222222222';
    const dto = { startDate: '2030-02-14', endDate: '2030-02-15' };

    await controller.create(driverId, dto as CreateDriverAbsenceDto, 'admin-1');
    await controller.cancel(driverId, absenceId, { reason: 'x' }, 'admin-1');
    await controller.list(driverId, {});
    await controller.availabilityOn(driverId, { date: '2030-02-14' });

    expect(service.create).toHaveBeenCalledWith(driverId, dto, 'admin-1');
    expect(service.cancel).toHaveBeenCalledWith(driverId, absenceId, { reason: 'x' }, 'admin-1');
    expect(service.availabilityOn).toHaveBeenCalledWith(driverId, '2030-02-14');
  });
});
