import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { ExclusionReason, PLANNING_EXCLUSION_REASONS } from './planning-exclusion-reason.js';
import { RoutePlanningController } from './route-planning.controller.js';
import { RoutePlanningService } from './route-planning.service.js';

// Lista fijada a propósito: es el contrato con la interfaz web, que traduce estos códigos.
// Si se agrega o cambia un código, esta prueba falla: actualice la lista y AVISE a quien consume la API.
const PINNED_CODES = [
  'MISSING_DELIVERY_COORDINATES',
  'INVALID_DELIVERY_COORDINATES',
  'MISSING_ZONE',
  'MISSING_ZONE_DEPOT_COORDINATES',
  'INVALID_ZONE_DEPOT_COORDINATES',
  'ACTIVE_ROUTE_CLAIM',
  'ADMINISTRATIVE_REVIEW_REQUIRED',
];

describe('códigos de exclusión de las propuestas', () => {
  it('son exactamente los 7 códigos acordados con la interfaz, sin repetidos', () => {
    expect([...PLANNING_EXCLUSION_REASONS]).toEqual(PINNED_CODES);
    expect(new Set(PLANNING_EXCLUSION_REASONS).size).toBe(PLANNING_EXCLUSION_REASONS.length);
  });

  it('incluyen los dos motivos no geográficos', () => {
    expect(PLANNING_EXCLUSION_REASONS).toEqual(expect.arrayContaining(Object.values(ExclusionReason)));
  });

  it('Swagger publica reasons como un arreglo de ese enum con los 7 códigos', async () => {
    const module = await Test.createTestingModule({
      controllers: [RoutePlanningController],
      providers: [{ provide: RoutePlanningService, useValue: {} }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({})
      .overrideGuard(RolesGuard)
      .useValue({})
      .compile();
    const app = module.createNestApplication();
    await app.init();
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('test').build());
    await app.close();

    const schemas = (document.components?.schemas ?? {}) as Record<string, any>;
    const reasons = schemas['ExcludedOrderDto'].properties.reasons;
    expect(reasons.type).toBe('array');
    // El enum se publica una sola vez como esquema compartido y reasons lo referencia.
    const ref: string | undefined = reasons.items.$ref;
    const enumSchema = ref ? schemas[ref.split('/').pop() as string] : reasons.items;
    expect(enumSchema.enum).toEqual(PINNED_CODES);
    expect(enumSchema.enum).toHaveLength(7);
  });
});
