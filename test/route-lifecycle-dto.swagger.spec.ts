import { Controller, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ApiExtraModels,
  DocumentBuilder,
  SwaggerModule,
} from '@nestjs/swagger';
import {
  FailedVisitReason,
  RecordFailedVisitDto,
} from '../src/modules/routes/dto/record-failed-visit.dto.js';
import { RegularizeLegacyRouteDto } from '../src/modules/routes/dto/regularize-legacy-route.dto.js';

@ApiExtraModels(RecordFailedVisitDto, RegularizeLegacyRouteDto)
@Controller()
class ContractHost {}

@Module({ controllers: [ContractHost] })
class ContractModule {}

describe('Route lifecycle request schemas', () => {
  it('publishes required constrained components without fabricated endpoint paths', async () => {
    const module = await Test.createTestingModule({
      imports: [ContractModule],
    }).compile();
    const app = module.createNestApplication();
    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      expect(document.paths).toEqual({});
      expect(document.components?.schemas?.RecordFailedVisitDto).toMatchObject({
        required: ['reason', 'context', 'requestId'],
        properties: {
          reason: { enum: Object.values(FailedVisitReason) },
          context: { type: 'string', maxLength: 500, pattern: '\\S' },
          requestId: { type: 'string', format: 'uuid' },
        },
      });
      expect(
        document.components?.schemas?.RegularizeLegacyRouteDto,
      ).toMatchObject({
        required: ['reason', 'evidence'],
        properties: {
          reason: { type: 'string', maxLength: 500, pattern: '\\S' },
          evidence: { type: 'string', maxLength: 2000, pattern: '\\S' },
        },
      });
      for (const schema of Object.values(document.components?.schemas ?? {})) {
        if ('properties' in schema) {
          expect(Object.keys(schema.properties ?? {})).not.toEqual(
            expect.arrayContaining(['actor']),
          );
          expect(Object.keys(schema.properties ?? {})).not.toEqual(
            expect.arrayContaining(['driverId']),
          );
        }
      }
    } finally {
      await app.close();
    }
  });
});
