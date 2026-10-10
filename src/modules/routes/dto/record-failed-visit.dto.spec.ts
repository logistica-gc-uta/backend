import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RecordFailedVisitDto } from './record-failed-visit.dto.js';

describe('RecordFailedVisitDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const valid = {
    reason: 'RECIPIENT_ABSENT',
    context: 'No recipient at address',
    requestId: 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb7c',
  };
  const transform = (value: unknown) =>
    pipe.transform(value, { type: 'body', metatype: RecordFailedVisitDto });

  it('accepts valid input and transforms to the DTO', async () => {
    await expect(transform(valid)).resolves.toBeInstanceOf(
      RecordFailedVisitDto,
    );
  });
  it.each(Object.keys(valid))('requires %s', async (key) => {
    const value = { ...valid };
    delete value[key as keyof typeof value];
    await expect(transform(value)).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each(['actor', 'driverId', 'unknown'])(
    'rejects untrusted %s',
    async (key) => {
      await expect(
        transform({ ...valid, [key]: 'spoofed' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it.each(['', ' \t\n', null, 42, {}, [], 'x'.repeat(501)])(
    'rejects invalid context: %p',
    async (value) => {
      await expect(
        transform({ ...valid, context: value }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it('accepts the context length boundary', async () => {
    await expect(
      transform({ ...valid, context: 'x'.repeat(500) }),
    ).resolves.toBeInstanceOf(RecordFailedVisitDto);
  });
  it.each(['RECIPIENT_ABSENT', 'RECIPIENT_REFUSED'])(
    'accepts reason %s',
    async (reason) => {
      await expect(transform({ ...valid, reason })).resolves.toBeInstanceOf(
        RecordFailedVisitDto,
      );
    },
  );
  it.each(['CANCELLED', '', null, 42])(
    'rejects invalid reason: %p',
    async (reason) => {
      await expect(transform({ ...valid, reason })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
  it.each(['not-a-uuid', '', null, 42])(
    'rejects invalid request identity: %p',
    async (requestId) => {
      await expect(transform({ ...valid, requestId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
});
