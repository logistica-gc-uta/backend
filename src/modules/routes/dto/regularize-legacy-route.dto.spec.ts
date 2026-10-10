import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RegularizeLegacyRouteDto } from './regularize-legacy-route.dto.js';

describe('RegularizeLegacyRouteDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const valid = {
    reason: 'Legacy route missing history',
    evidence: 'Signed depot record',
  };
  const transform = (value: unknown) =>
    pipe.transform(value, { type: 'body', metatype: RegularizeLegacyRouteDto });

  it('accepts valid input and transforms to the DTO', async () => {
    await expect(transform(valid)).resolves.toBeInstanceOf(
      RegularizeLegacyRouteDto,
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
    'rejects invalid reason: %p',
    async (value) => {
      await expect(
        transform({ ...valid, reason: value }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it('accepts the reason length boundary', async () => {
    await expect(
      transform({ ...valid, reason: 'x'.repeat(500) }),
    ).resolves.toBeInstanceOf(RegularizeLegacyRouteDto);
  });
  it.each(['', ' \t\n', null, 42, {}, [], 'x'.repeat(2001)])(
    'rejects invalid evidence: %p',
    async (value) => {
      await expect(
        transform({ ...valid, evidence: value }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it('accepts the evidence length boundary', async () => {
    await expect(
      transform({ ...valid, evidence: 'x'.repeat(2000) }),
    ).resolves.toBeInstanceOf(RegularizeLegacyRouteDto);
  });
});
