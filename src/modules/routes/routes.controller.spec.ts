import { RoutesController } from './routes.controller.js';

describe('RoutesController', () => {
  let controller: RoutesController;
  let routesServiceMock: any;

  beforeEach(() => {
    routesServiceMock = {
      assignRoute: jest.fn(),
      confirmDraft: jest.fn(),
      assignDraft: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
    };
    controller = new RoutesController(
      routesServiceMock,
      {
        start: jest.fn(),
      } as any,
      { fail: jest.fn(), complete: jest.fn() } as any,
      { returnToDepot: jest.fn() } as any,
      { reconcile: jest.fn() } as any,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('assign debe delegar al servicio assignRoute', async () => {
    const dto = {
      driverId: 'driver-1',
      zoneId: 'zone-1',
      orderIds: ['order-1'],
    };
    const createdRoute = { id: 'route-1', ...dto };
    routesServiceMock.assignRoute.mockResolvedValue(createdRoute);

    const result = await controller.assign(dto, 'admin');
    expect(routesServiceMock.assignRoute).toHaveBeenCalledWith(dto, 'admin');
    expect(result).toEqual(createdRoute);
  });

  it('findAll debe delegar al servicio findAll', async () => {
    const routes = [{ id: 'route-1' }];
    routesServiceMock.findAll.mockResolvedValue(routes);

    const result = await controller.findAll();
    expect(routesServiceMock.findAll).toHaveBeenCalled();
    expect(result).toEqual(routes);
  });

  it('findOne debe delegar al servicio findOne', async () => {
    const route = { id: 'route-1' };
    routesServiceMock.findOne.mockResolvedValue(route);

    const result = await controller.findOne('route-1');
    expect(routesServiceMock.findOne).toHaveBeenCalledWith('route-1');
    expect(result).toEqual(route);
  });
  it('delegates failure with the authenticated actor, not body identity', async () => {
    const progress = {
      fail: jest.fn().mockResolvedValue({ id: 'attempt' }),
      complete: jest.fn(),
    };
    const subject = new RoutesController(
      routesServiceMock,
      { start: jest.fn() } as any,
      progress as any,
      { returnToDepot: jest.fn() } as any,
      { reconcile: jest.fn() } as any,
    );
    const dto = {
      reason: 'RECIPIENT_ABSENT',
      context: 'Recipient unavailable',
      requestId: 'request',
    } as any;
    await expect(subject.fail('route', 'stop', 'actor', dto)).resolves.toEqual({
      id: 'attempt',
    });
    expect(progress.fail).toHaveBeenCalledWith('route', 'stop', 'actor', dto);
  });
  it('rejects completion identity in the body before service execution', async () => {
    await expect(
      controller.complete(
        'route',
        'actor',
        { driverId: 'spoof' },
        'application/json',
      ),
    ).rejects.toThrow('empty JSON');
  });
});

describe('RoutesController assembled lifecycle handlers', () => {
  const routes: any = { confirmDraft: jest.fn(), assignDraft: jest.fn() };
  const depot: any = {
    returnToDepot: jest.fn().mockResolvedValue({
      id: 'route',
      status: 'COMPLETED',
      returnedAt: 'original',
    }),
  };
  const controller = new RoutesController(
    routes,
    {} as any,
    {} as any,
    depot,
    {} as any,
  );
  it('delegates confirmed proposals and existing-draft assignment with ADMIN actor', async () => {
    const proposal: any = {
      zoneId: 'zone',
      orderIds: ['order'],
      routeDate: '2026-10-10T00:00:00Z',
    };
    await controller.confirmDraft(proposal, 'admin');
    expect(routes.confirmDraft).toHaveBeenCalledWith(proposal, 'admin');
    await controller.assignDraft('route', { driverId: 'driver' }, 'admin');
    expect(routes.assignDraft).toHaveBeenCalledWith(
      'route',
      { driverId: 'driver' },
      'admin',
    );
  });
  it('passes return identity only from authenticated actor', async () => {
    await controller.returnToDepot('route', 'owner', {});
    expect(depot.returnToDepot).toHaveBeenCalledWith('route', 'owner');
  });
  it('rejects return identity fields before any service call', async () => {
    depot.returnToDepot.mockClear();
    await expect(
      controller.returnToDepot('route', 'owner', { driverId: 'driver' }),
    ).rejects.toThrow('empty JSON');
    expect(depot.returnToDepot).not.toHaveBeenCalled();
  });
});

describe('Route history serialized Swagger matches role-specific responses', () => {
  let app: import('@nestjs/common').INestApplication;
  let doc: import('@nestjs/swagger').OpenAPIObject;
  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const { PassportModule } = await import('@nestjs/passport');
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    const { RoutesService } = await import('./routes.service.js');
    const { RouteExecutionService } =
      await import('./route-execution.service.js');
    const { RouteProgressService } =
      await import('./route-progress.service.js');
    const { RouteReturnService } = await import('./route-return.service.js');
    const { LegacyRouteReconciliationService } =
      await import('./legacy-route-reconciliation.service.js');
    const { DriversController } =
      await import('../drivers/drivers.controller.js');
    const { DriversService } = await import('../drivers/drivers.service.js');
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [RoutesController, DriversController],
      providers: [
        RoutesService,
        RouteExecutionService,
        RouteProgressService,
        RouteReturnService,
        LegacyRouteReconciliationService,
        DriversService,
      ].map((provide) => ({ provide, useValue: {} })),
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  });
  afterAll(async () => {
    await app?.close();
  });
  it('has exactly the persisted lifecycle states plus the NULL projection, not an invented return state', () => {
    expect(
      doc.components!.schemas!.RouteHistoryResponseDto.properties!.status,
    ).toMatchObject({
      enum: ['UNVERIFIED', 'DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'],
    });
  });
  it('publishes complete ADMIN route/order/driver fields while DRIVER retains its restricted schema', () => {
    const response = (path: string) =>
      (doc.paths[path].get!.responses['200'] as any).content['application/json']
        .schema;
    expect(response('/api/v1/routes')).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/AdminRouteHistoryResponseDto' },
    });
    expect(response('/api/v1/routes/{id}')).toEqual({
      $ref: '#/components/schemas/AdminRouteHistoryResponseDto',
    });
    expect(response('/api/v1/drivers/me/routes')).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/RouteHistoryResponseDto' },
    });
    const schemas: any = doc.components!.schemas;
    expect(
      Object.keys(schemas.AdminRouteHistoryResponseDto.properties).sort(),
    ).toEqual(
      [
        'id',
        'date',
        'zone',
        'status',
        'orders',
        'stops',
        'events',
        'driverId',
        'zoneId',
        'createdAt',
        'startedAt',
        'startedById',
        'completedAt',
        'completedById',
        'returnedAt',
        'returnedById',
        'driver',
      ].sort(),
    );
    expect(
      Object.keys(schemas.AdminRouteHistoryOrderDto.properties).sort(),
    ).toEqual(
      [
        'id',
        'userId',
        'zoneId',
        'routeId',
        'status',
        'total',
        'deliveryAddress',
        'scheduledDeliveryDate',
        'stopOrder',
        'deliveryLat',
        'deliveryLng',
        'createdAt',
        'requiresAdministrativeReview',
      ].sort(),
    );
    expect(Object.keys(schemas.RouteHistoryOrderDto.properties).sort()).toEqual(
      [
        'id',
        'deliveryAddress',
        'status',
        'scheduledDeliveryDate',
        'stopOrder',
      ].sort(),
    );
    expect(
      schemas.AdminRouteHistoryResponseDto.properties.driver,
    ).toMatchObject({ nullable: true });
    expect(schemas.AdminRouteHistoryDriverDto.properties.user).toBeDefined();
  });
});
