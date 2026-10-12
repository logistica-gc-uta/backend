import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PlanRoutesQueryDto } from './plan-routes-query.dto.js';

const check = (input: Record<string, unknown>) =>
  validate(plainToInstance(PlanRoutesQueryDto, input), { whitelist: true, forbidNonWhitelisted: true });

describe('PlanRoutesQueryDto', () => {
  it('acepta solo la fecha', async () => {
    expect(await check({ date: '2030-02-14' })).toHaveLength(0);
  });

  it('acepta fecha y zona UUID', async () => {
    expect(await check({ date: '2030-02-14', zoneId: '2f782f43-6ec2-41ff-875f-c4c93d303fa4' })).toHaveLength(0);
  });

  it('exige la fecha', async () => {
    expect(await check({})).not.toHaveLength(0);
  });

  it.each(['14/02/2030', '2030-2-14', '20300214', '2030-02-14T10:00:00Z'])('rechaza el formato de fecha %p', async (date) => {
    expect(await check({ date })).not.toHaveLength(0);
  });

  it('rechaza una zona que no es UUID', async () => {
    expect(await check({ date: '2030-02-14', zoneId: 'centro' })).not.toHaveLength(0);
  });

  it('rechaza parámetros desconocidos', async () => {
    expect(await check({ date: '2030-02-14', driverId: 'x' })).not.toHaveLength(0);
  });
});
