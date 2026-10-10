import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { PlanningIneligibilityReason } from '../src/modules/orders/order-geography.util.js';

describe('Swagger Geolocation OpenAPI Specification (GREEN verification)', () => {
  let app: INestApplication;
  let document: any;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');

    const config = new DocumentBuilder()
      .setTitle('Sistema de Logística y Entrega de Pedidos - UTA')
      .setVersion('1.0.0')
      .build();

    document = SwaggerModule.createDocument(app, config);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Esquemas registrados en components.schemas', () => {
    it('debe registrar el esquema GeoPointDto con lat y lng numéricos', () => {
      const schema = document.components?.schemas?.GeoPointDto;
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.properties?.lat).toBeDefined();
      expect(schema.properties?.lat.type).toBe('number');
      expect(schema.properties?.lng).toBeDefined();
      expect(schema.properties?.lng.type).toBe('number');
    });

    it('debe registrar el esquema PlanningEligibilityDto con enum de razones', () => {
      const schema = document.components?.schemas?.PlanningEligibilityDto;
      expect(schema).toBeDefined();
      expect(schema.properties?.eligible).toBeDefined();
      expect(schema.properties?.eligible.type).toBe('boolean');
      expect(schema.properties?.reasons).toBeDefined();
      expect(schema.properties?.reasons.type).toBe('array');

      const expectedReasons = Object.values(PlanningIneligibilityReason);
      expect(schema.properties?.reasons.items?.enum).toEqual(
        expect.arrayContaining(expectedReasons),
      );
    });

    it('debe registrar el esquema ZoneResponseDto con coordenadas anulables y depotLocation', () => {
      const schema = document.components?.schemas?.ZoneResponseDto;
      expect(schema).toBeDefined();
      expect(schema.properties?.id).toBeDefined();
      expect(schema.properties?.name).toBeDefined();
      expect(schema.properties?.code).toBeDefined();

      // Nulabilidad de coordenadas de zona
      expect(schema.properties?.depotLat).toBeDefined();
      expect(schema.properties?.depotLat.nullable).toBe(true);
      expect(schema.properties?.depotLng).toBeDefined();
      expect(schema.properties?.depotLng.nullable).toBe(true);

      // Objeto estructurado depotLocation
      expect(schema.properties?.depotLocation).toBeDefined();
      expect(schema.properties?.depotLocation.nullable).toBe(true);
      expect(
        schema.properties?.depotLocation.$ref ||
          schema.properties?.depotLocation.allOf?.[0]?.$ref,
      ).toBe('#/components/schemas/GeoPointDto');
    });

    it('debe registrar el esquema OrderCreatedResponseDto con persistencia escalar y nulabilidad', () => {
      const schema = document.components?.schemas?.OrderCreatedResponseDto;
      expect(schema).toBeDefined();
      expect(schema.properties?.id).toBeDefined();
      expect(schema.properties?.deliveryAddress).toBeDefined();

      // Coordenadas escalares anulables
      expect(schema.properties?.deliveryLat).toBeDefined();
      expect(schema.properties?.deliveryLat.nullable).toBe(true);
      expect(schema.properties?.deliveryLng).toBeDefined();
      expect(schema.properties?.deliveryLng.nullable).toBe(true);

      // Fecha programada y estado
      expect(schema.properties?.scheduledDeliveryDate).toBeDefined();
      expect(schema.properties?.scheduledDeliveryDate.nullable).toBe(true);
      expect(schema.properties?.status).toBeDefined();
      expect(schema.properties?.total).toBeDefined();
    });

    it('debe registrar el esquema OrderResponseDto con deliveryLocation, planningEligibility e ítems', () => {
      const schema = document.components?.schemas?.OrderResponseDto;
      expect(schema).toBeDefined();

      // Relación con zona enriquecida
      expect(schema.properties?.zone).toBeDefined();
      expect(
        schema.properties?.zone.$ref ||
          schema.properties?.zone.allOf?.[0]?.$ref,
      ).toBe('#/components/schemas/ZoneResponseDto');

      // Objeto estructurado deliveryLocation
      expect(schema.properties?.deliveryLocation).toBeDefined();
      expect(schema.properties?.deliveryLocation.nullable).toBe(true);
      expect(
        schema.properties?.deliveryLocation.$ref ||
          schema.properties?.deliveryLocation.allOf?.[0]?.$ref,
      ).toBe('#/components/schemas/GeoPointDto');

      // Objeto estructurado planningEligibility
      expect(schema.properties?.planningEligibility).toBeDefined();
      expect(
        schema.properties?.planningEligibility.$ref ||
          schema.properties?.planningEligibility.allOf?.[0]?.$ref,
      ).toBe('#/components/schemas/PlanningEligibilityDto');

      // Ítems anidados
      expect(schema.properties?.items).toBeDefined();
      expect(schema.properties?.items.type).toBe('array');
      expect(schema.properties?.items.items?.$ref).toBe(
        '#/components/schemas/OrderItemResponseDto',
      );
    });
  });

  describe('Rutas y respuestas OpenAPI (paths)', () => {
    it('GET /api/v1/zones debe responder con un arreglo de ZoneResponseDto', () => {
      const op = document.paths?.['/api/v1/zones']?.get;
      expect(op).toBeDefined();
      const response200 = op.responses?.['200'];
      expect(response200).toBeDefined();
      const schema = response200.content?.['application/json']?.schema;
      expect(schema?.type).toBe('array');
      expect(schema?.items?.$ref).toBe('#/components/schemas/ZoneResponseDto');
    });

    it('POST /api/v1/zones debe responder 201 con ZoneResponseDto', () => {
      const op = document.paths?.['/api/v1/zones']?.post;
      expect(op).toBeDefined();
      const response201 = op.responses?.['201'];
      expect(response201).toBeDefined();
      const schema = response201.content?.['application/json']?.schema;
      expect(schema?.$ref).toBe('#/components/schemas/ZoneResponseDto');
    });

    it('GET /api/v1/zones/{id} debe responder 200 con ZoneResponseDto', () => {
      const op = document.paths?.['/api/v1/zones/{id}']?.get;
      expect(op).toBeDefined();
      const response200 = op.responses?.['200'];
      expect(response200).toBeDefined();
      const schema = response200.content?.['application/json']?.schema;
      expect(schema?.$ref).toBe('#/components/schemas/ZoneResponseDto');
    });

    it('POST /api/v1/orders debe responder 201 con OrderCreatedResponseDto', () => {
      const op = document.paths?.['/api/v1/orders']?.post;
      expect(op).toBeDefined();
      const response201 = op.responses?.['201'];
      expect(response201).toBeDefined();
      const schema = response201.content?.['application/json']?.schema;
      expect(schema?.$ref).toBe('#/components/schemas/OrderCreatedResponseDto');
    });

    it('GET /api/v1/orders/my-orders debe responder 200 con un arreglo de OrderResponseDto', () => {
      const op = document.paths?.['/api/v1/orders/my-orders']?.get;
      expect(op).toBeDefined();
      const response200 = op.responses?.['200'];
      expect(response200).toBeDefined();
      const schema = response200.content?.['application/json']?.schema;
      expect(schema?.type).toBe('array');
      expect(schema?.items?.$ref).toBe('#/components/schemas/OrderResponseDto');
    });

    it('GET /api/v1/orders debe responder 200 con un arreglo de OrderResponseDto', () => {
      const op = document.paths?.['/api/v1/orders']?.get;
      expect(op).toBeDefined();
      const response200 = op.responses?.['200'];
      expect(response200).toBeDefined();
      const schema = response200.content?.['application/json']?.schema;
      expect(schema?.type).toBe('array');
      expect(schema?.items?.$ref).toBe('#/components/schemas/OrderResponseDto');
    });

    it('GET /api/v1/orders/{id} debe responder 200 con OrderResponseDto', () => {
      const op = document.paths?.['/api/v1/orders/{id}']?.get;
      expect(op).toBeDefined();
      const response200 = op.responses?.['200'];
      expect(response200).toBeDefined();
      const schema = response200.content?.['application/json']?.schema;
      expect(schema?.$ref).toBe('#/components/schemas/OrderResponseDto');
    });

    it('PATCH /api/v1/orders/{id}/status debe responder 200 con OrderCreatedResponseDto', () => {
      const op = document.paths?.['/api/v1/orders/{id}/status']?.patch;
      expect(op).toBeDefined();
      const response200 = op.responses?.['200'];
      expect(response200).toBeDefined();
      const schema = response200.content?.['application/json']?.schema;
      expect(schema?.$ref).toBe('#/components/schemas/OrderCreatedResponseDto');
    });
  });
});
