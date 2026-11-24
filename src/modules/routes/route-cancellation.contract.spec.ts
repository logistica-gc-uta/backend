import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DispatchInterventionDto } from './dto/dispatch-intervention.dto.js';

const request = {
  action: 'CANCEL_ROUTE',
  requestId: '11111111-1111-4111-8111-111111111111',
  routeId: '22222222-2222-4222-8222-222222222222',
  reason: 'El vehículo no puede salir',
};

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: DispatchInterventionDto });

describe('Route cancellation intervention contract', () => {
  it('accepts an explicit cancellation request with an idempotency key and a reason', async () => {
    await expect(validate(request)).resolves.toMatchObject(request);
  });

  it('rejects a cancellation with a blank reason', async () => {
    await expect(validate({ ...request, reason: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
