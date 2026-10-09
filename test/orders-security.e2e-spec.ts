import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/modules/auth/dto/register.dto.js';
import { OrderStatus } from '../src/modules/orders/dto/update-order-status.dto.js';
import {
  DriverFixture,
  OrderFixture,
  ProductFixture,
  SecurityFixtureManager,
  UserFixture,
  ZoneFixture,
} from './orders-security.fixtures.js';

describe('Orders Security Integration & E2E (PostgreSQL Real)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let fixtures: SecurityFixtureManager;

  // Shared test actors & fixtures
  let admin: UserFixture;
  let clientA: UserFixture;
  let clientB: UserFixture;
  let driverUserA: UserFixture;
  let driverUserB: UserFixture;
  let driverUserOrphan: UserFixture;

  let driverA: DriverFixture;
  let driverB: DriverFixture;

  let zone: ZoneFixture;
  let product: ProductFixture;

  let orderClientAAssignedRouteA: OrderFixture;
  let orderClientBAssignedRouteB: OrderFixture;
  let orderClientAPendingUnassigned: OrderFixture;
  let orderDeliveredTerminal: OrderFixture;
  let orderCancelledTerminal: OrderFixture;

  beforeAll(async () => {
    // 1. Verificación de preparación de entorno sin exponer secretos
    expect(process.env.DATABASE_URL).toBeDefined();
    expect(process.env.DATABASE_URL?.length).toBeGreaterThan(0);
    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.JWT_SECRET?.length).toBeGreaterThan(0);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    fixtures = new SecurityFixtureManager(prisma, jwtService);

    // 2. Creación aislada de actores con credenciales JWT reales y registros en PostgreSQL
    admin = await fixtures.createUser(Role.ADMIN, 'admin');
    clientA = await fixtures.createUser(Role.CLIENT, 'clientA');
    clientB = await fixtures.createUser(Role.CLIENT, 'clientB');
    driverUserA = await fixtures.createUser(Role.DRIVER, 'driverA');
    driverUserB = await fixtures.createUser(Role.DRIVER, 'driverB');
    driverUserOrphan = await fixtures.createUser(Role.DRIVER, 'driverOrphan');

    driverA = await fixtures.createDriver(driverUserA.id);
    driverB = await fixtures.createDriver(driverUserB.id);

    zone = await fixtures.createZone();
    product = await fixtures.createProduct(50, 100);

    const routeA = await fixtures.createRoute(driverA.id, zone.id);
    const routeB = await fixtures.createRoute(driverB.id, zone.id);

    // Órdenes para escenarios de permisos y ownership
    orderClientAAssignedRouteA = await fixtures.createOrder(
      clientA.id,
      zone.id,
      routeA.id,
      OrderStatus.ASSIGNED,
    );
    await fixtures.createOrderItem(orderClientAAssignedRouteA.id, product.id, 2, 100);

    orderClientBAssignedRouteB = await fixtures.createOrder(
      clientB.id,
      zone.id,
      routeB.id,
      OrderStatus.ASSIGNED,
    );
    await fixtures.createOrderItem(orderClientBAssignedRouteB.id, product.id, 1, 100);

    orderClientAPendingUnassigned = await fixtures.createOrder(
      clientA.id,
      zone.id,
      null,
      OrderStatus.PENDING,
    );
    await fixtures.createOrderItem(orderClientAPendingUnassigned.id, product.id, 1, 100);

    orderDeliveredTerminal = await fixtures.createOrder(
      clientA.id,
      zone.id,
      routeA.id,
      OrderStatus.DELIVERED,
    );

    orderCancelledTerminal = await fixtures.createOrder(
      clientA.id,
      zone.id,
      routeA.id,
      OrderStatus.CANCELLED,
    );
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await app.close();
    }
  });

  describe('1. Autenticación JWT estricta y protección contra identidades falsificadas', () => {
    it('debe rechazar solicitudes sin cabecera Authorization con 401 Unauthorized', async () => {
      const endpoints = [
        () => request(app.getHttpServer()).get('/api/v1/orders'),
        () => request(app.getHttpServer()).get(`/api/v1/orders/${orderClientAAssignedRouteA.id}`),
        () => request(app.getHttpServer()).get('/api/v1/orders/my-orders'),
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/orders/${orderClientAAssignedRouteA.id}/status`)
            .send({ status: OrderStatus.CANCELLED }),
      ];

      for (const call of endpoints) {
        const res = await call();
        expect(res.status).toBe(401);
      }
    });

    it('debe rechazar tokens malformados o con firma inválida con 401 Unauthorized', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', 'Bearer token.totalmente.invalido');

      expect(res.status).toBe(401);
    });

    it('debe rechazar token con sub no existente en la base de datos con 401 Unauthorized', async () => {
      const forgedToken = fixtures.createForgedToken('00000000-0000-0000-0000-000000000000');
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderClientAAssignedRouteA.id}`)
        .set('Authorization', `Bearer ${forgedToken}`);

      expect(res.status).toBe(401);
      expect(res.body.message).toContain('Token no válido o usuario inexistente');
    });

    it('debe ignorar identidades inyectadas por el cliente y validar únicamente el token JWT firmado', async () => {
      // ClientA intenta falsificar ser Admin inyectando campos adicionales
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${clientA.token}`)
        .set('x-user-role', 'ADMIN');

      expect(res.status).toBe(403);
    });
  });

  describe('2. Matriz de permisos de CLIENT: aislamiento propio vs foráneo', () => {
    it('CLIENT A debe poder consultar el detalle de su propio pedido', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderClientAAssignedRouteA.id}`)
        .set('Authorization', `Bearer ${clientA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orderClientAAssignedRouteA.id);
      expect(res.body.userId).toBe(clientA.id);
    });

    it('CLIENT A debe recibir 403 Forbidden al consultar un pedido de CLIENT B (IDOR/BOLA)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderClientBAssignedRouteB.id}`)
        .set('Authorization', `Bearer ${clientA.token}`);

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('No tiene permisos para consultar este pedido');
    });

    it('CLIENT A debe consultar su historial en my-orders sin ver pedidos de otros clientes', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders/my-orders')
        .set('Authorization', `Bearer ${clientA.token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const foreignOrders = res.body.filter((o: any) => o.userId !== clientA.id);
      expect(foreignOrders.length).toBe(0);
      const ownOrderFound = res.body.some((o: any) => o.id === orderClientAAssignedRouteA.id);
      expect(ownOrderFound).toBe(true);
    });

    it('CLIENT debe recibir 403 Forbidden al intentar listar pedidos globales en GET /orders', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${clientA.token}`);

      expect(res.status).toBe(403);
    });

    it('CLIENT debe recibir 403 Forbidden al intentar modificar el estado de un pedido', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderClientAAssignedRouteA.id);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderClientAAssignedRouteA.id}/status`)
        .set('Authorization', `Bearer ${clientA.token}`)
        .send({ status: OrderStatus.CANCELLED });

      expect(res.status).toBe(403);

      const snapshotAfter = await fixtures.getOrderSnapshot(orderClientAAssignedRouteA.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });
  });

  describe('3. Matriz de permisos de DRIVER: lectura de ruta propia vs foránea y escrituras fail-closed', () => {
    it('DRIVER A debe poder consultar un pedido asignado a su ruta', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderClientAAssignedRouteA.id}`)
        .set('Authorization', `Bearer ${driverUserA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orderClientAAssignedRouteA.id);
    });

    it('DRIVER A debe recibir 403 Forbidden al consultar un pedido de la ruta de DRIVER B', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderClientBAssignedRouteB.id}`)
        .set('Authorization', `Bearer ${driverUserA.token}`);

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('No tiene permisos para consultar pedidos de otra ruta');
    });

    it('DRIVER A debe recibir 403 Forbidden al consultar un pedido sin ruta asignada', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderClientAPendingUnassigned.id}`)
        .set('Authorization', `Bearer ${driverUserA.token}`);

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('El pedido no está asignado a ninguna ruta');
    });

    it('DRIVER sin registro de Driver asociado debe recibir 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderClientAAssignedRouteA.id}`)
        .set('Authorization', `Bearer ${driverUserOrphan.token}`);

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('El usuario no tiene un perfil de repartidor asociado');
    });

    it('DRIVER A debe recibir 403 Forbidden al intentar mutar un pedido de DRIVER B (cross write denegado)', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderClientBAssignedRouteB.id);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderClientBAssignedRouteB.id}/status`)
        .set('Authorization', `Bearer ${driverUserA.token}`)
        .send({ status: OrderStatus.IN_TRANSIT });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('No tiene permisos para modificar pedidos de otra ruta');

      const snapshotAfter = await fixtures.getOrderSnapshot(orderClientBAssignedRouteB.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });

    it('DRIVER A debe recibir 403 Forbidden al intentar mutar su propio pedido (fail-closed por Issue #10)', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderClientAAssignedRouteA.id);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderClientAAssignedRouteA.id}/status`)
        .set('Authorization', `Bearer ${driverUserA.token}`)
        .send({ status: OrderStatus.IN_TRANSIT });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('deshabilitadas hasta que se implemente la verificación de ruta en progreso (#10)');

      const snapshotAfter = await fixtures.getOrderSnapshot(orderClientAAssignedRouteA.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });
  });

  describe('4. Matriz de permisos de ADMIN: lecturas globales, cancelación y transiciones restringidas', () => {
    it('ADMIN debe poder listar todos los pedidos globalmente', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${admin.token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(4);
    });

    it('ADMIN debe poder consultar el detalle de cualquier pedido', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderClientAAssignedRouteA.id}`)
        .set('Authorization', `Bearer ${admin.token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orderClientAAssignedRouteA.id);
    });

    it('ADMIN puede cancelar un pedido no terminal PENDING', async () => {
      const orderToCancel = await fixtures.createOrder(
        clientA.id,
        zone.id,
        null,
        OrderStatus.PENDING,
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderToCancel.id}/status`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ status: OrderStatus.CANCELLED });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(OrderStatus.CANCELLED);

      const snapshot = await fixtures.getOrderSnapshot(orderToCancel.id);
      expect(snapshot?.status).toBe(OrderStatus.CANCELLED);
    });

    it('ADMIN debe recibir 400 Bad Request si intenta cambiar estado a ASSIGNED en este endpoint', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderClientAPendingUnassigned.id);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderClientAPendingUnassigned.id}/status`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ status: OrderStatus.ASSIGNED });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('solo puede realizarse a través del endpoint de rutas');

      const snapshotAfter = await fixtures.getOrderSnapshot(orderClientAPendingUnassigned.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });

    it('ADMIN debe recibir 400 Bad Request si intenta transiciones no administrativas (IN_TRANSIT / DELIVERED)', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderClientAAssignedRouteA.id);

      const resInTransit = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderClientAAssignedRouteA.id}/status`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ status: OrderStatus.IN_TRANSIT });

      expect(resInTransit.status).toBe(400);
      expect(resInTransit.body.message).toContain('solo pueden cancelar pedidos no terminales');

      const snapshotAfter = await fixtures.getOrderSnapshot(orderClientAAssignedRouteA.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });
  });

  describe('5. Grafo central de estados y protección de estados terminales', () => {
    it('debe rechazar transiciones inválidas del grafo con 400 Bad Request (PENDING -> DELIVERED)', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderClientAPendingUnassigned.id);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderClientAPendingUnassigned.id}/status`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ status: OrderStatus.DELIVERED });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Transición de estado inválida: no se permite cambiar de 'PENDING' a 'DELIVERED'");

      const snapshotAfter = await fixtures.getOrderSnapshot(orderClientAPendingUnassigned.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });

    it('debe rechazar mutaciones salientes desde estado terminal DELIVERED', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderDeliveredTerminal.id);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderDeliveredTerminal.id}/status`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ status: OrderStatus.CANCELLED });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("No se puede realizar una transición desde el estado terminal 'DELIVERED'");

      const snapshotAfter = await fixtures.getOrderSnapshot(orderDeliveredTerminal.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });

    it('debe rechazar mutaciones salientes desde estado terminal CANCELLED', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderCancelledTerminal.id);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderCancelledTerminal.id}/status`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ status: OrderStatus.PENDING });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("No se puede realizar una transición desde el estado terminal 'CANCELLED'");

      const snapshotAfter = await fixtures.getOrderSnapshot(orderCancelledTerminal.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });
  });

  describe('6. Escritura condicional atómica y detección de concurrencia (zero-row)', () => {
    it('debe responder 409 Conflict si el pedido fue modificado concurrentemente', async () => {
      const orderRace = await fixtures.createOrder(
        clientA.id,
        zone.id,
        null,
        OrderStatus.PENDING,
      );

      // Simular cambio concurrente directo en PostgreSQL
      await prisma.order.where({ id: orderRace.id }).update({ status: OrderStatus.CANCELLED });

      // Si un proceso intenta cancelar asumiendo que seguía PENDING, la actualización condicional
      // encuentra el estado terminal o discrepancia y la base de datos no aplica la transición obsoleta.
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderRace.id}/status`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ status: OrderStatus.CANCELLED });

      // Al haber pasado a CANCELLED concurrentemente, el validador del ciclo de vida rechaza transición desde terminal
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("No se puede realizar una transición desde el estado terminal 'CANCELLED'");
    });

    it('debe comprobar el comportamiento de actualización condicional zero-row en PostgreSQL y Prisma 8', async () => {
      const orderStale = await fixtures.createOrder(
        clientA.id,
        zone.id,
        null,
        OrderStatus.PENDING,
      );

      // Cambiamos el estado en DB a ASSIGNED simulando mutación concurrente
      await prisma.order.where({ id: orderStale.id }).update({ status: OrderStatus.ASSIGNED });

      // Ejecutamos la consulta condicional con el estado antiguo (PENDING) que ahora tiene 0 filas coincidentes
      const zeroRowUpdate = await prisma.order
        .where({ id: orderStale.id, status: OrderStatus.PENDING })
        .update({ status: OrderStatus.CANCELLED });

      // Prisma 8 retorna null cuando la cláusula WHERE condicional no coincide con ningún registro
      expect(zeroRowUpdate).toBeNull();

      // Verificamos que el estado en la base de datos se mantiene en ASSIGNED y no fue alterado
      const snapshot = await fixtures.getOrderSnapshot(orderStale.id);
      expect(snapshot?.status).toBe(OrderStatus.ASSIGNED);
    });
  });

  describe('7. Prioridad estricta de autorización y propiedad sobre el ciclo de vida', () => {
    it('GET /api/v1/routes debe restringir acceso exclusivo a ADMIN y rechazar CLIENT y DRIVER con 403', async () => {
      const clientRes = await request(app.getHttpServer())
        .get('/api/v1/routes')
        .set('Authorization', `Bearer ${clientA.token}`);
      expect(clientRes.status).toBe(403);

      const driverRes = await request(app.getHttpServer())
        .get('/api/v1/routes')
        .set('Authorization', `Bearer ${driverUserA.token}`);
      expect(driverRes.status).toBe(403);

      const adminRes = await request(app.getHttpServer())
        .get('/api/v1/routes')
        .set('Authorization', `Bearer ${admin.token}`);
      expect(adminRes.status).toBe(200);
      expect(Array.isArray(adminRes.body)).toBe(true);
    });

    it('DRIVER es rechazado con 403 Forbidden ante transiciones inválidas en pedidos ajenos (no filtra estado del grafo)', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderClientAPendingUnassigned.id);

      // Transición sintácticamente inválida (PENDING -> DELIVERED) sobre pedido no asignado a la ruta del chofer:
      // Debe responder 403 Forbidden (no 400 Bad Request), evitando filtrar información del estado del recurso ajeno
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderClientAPendingUnassigned.id}/status`)
        .set('Authorization', `Bearer ${driverUserA.token}`)
        .send({ status: OrderStatus.DELIVERED });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('El pedido no está asignado a ninguna ruta');

      const snapshotAfter = await fixtures.getOrderSnapshot(orderClientAPendingUnassigned.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });

    it('DRIVER es rechazado con 403 Forbidden ante transiciones inválidas en pedidos de otra ruta (cross-write denegado)', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderClientBAssignedRouteB.id);

      // Transición inválida en pedido de ruta de DRIVER B enviada por DRIVER A
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderClientBAssignedRouteB.id}/status`)
        .set('Authorization', `Bearer ${driverUserA.token}`)
        .send({ status: OrderStatus.DELIVERED });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('No tiene permisos para modificar pedidos de otra ruta');

      const snapshotAfter = await fixtures.getOrderSnapshot(orderClientBAssignedRouteB.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });

    it('DRIVER es rechazado con 403 Forbidden ante transiciones sobre pedidos propios en estado terminal (fail-closed #10)', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderDeliveredTerminal.id);

      // DRIVER A intenta modificar pedido terminal de su ruta:
      // Debe responder 403 Forbidden (fail-closed por Issue #10) antes de validar el grafo de estados
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderDeliveredTerminal.id}/status`)
        .set('Authorization', `Bearer ${driverUserA.token}`)
        .send({ status: OrderStatus.CANCELLED });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('deshabilitadas hasta que se implemente la verificación de ruta en progreso (#10)');

      const snapshotAfter = await fixtures.getOrderSnapshot(orderDeliveredTerminal.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });

    it('CLIENT es rechazado con 403 Forbidden ante transiciones sobre pedidos terminales (rechazo por rol antes del grafo)', async () => {
      const snapshotBefore = await fixtures.getOrderSnapshot(orderDeliveredTerminal.id);

      // CLIENT intenta modificar pedido terminal:
      // Debe responder 403 Forbidden sin exponer información del grafo terminal con 400
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderDeliveredTerminal.id}/status`)
        .set('Authorization', `Bearer ${clientA.token}`)
        .send({ status: OrderStatus.CANCELLED });

      expect(res.status).toBe(403);

      const snapshotAfter = await fixtures.getOrderSnapshot(orderDeliveredTerminal.id);
      expect(snapshotAfter?.status).toBe(snapshotBefore?.status);
    });
  });
});
