import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../database/prisma.service.js';
import { OrderStatus } from './dto/orders-query.dto.js';
import { ShopOrdersService } from './orders.service.js';

describe('ShopOrdersService unit tests (public behavior)', () => {
  let service: ShopOrdersService;
  let mockTx: any;
  let mockPrisma: any;

  beforeEach(async () => {
    mockTx = {
      query: jest.fn(),
      execute: jest.fn(),
    };

    mockPrisma = {
      client: {
        raw: {
          sql: jest.fn().mockReturnValue({
            returnsRow: jest.fn().mockReturnValue({
              build: jest.fn().mockReturnValue({ queryText: 'SQL_ROW' }),
            }),
          }),
        },
        transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx)),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShopOrdersService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<ShopOrdersService>(ShopOrdersService);
  });

  describe('listOrders', () => {
    it('returns empty list and 0 totalPages when count is 0', async () => {
      mockTx.query.mockResolvedValueOnce([{ total: 0 }]);

      const result = await service.listOrders('user-1', { page: 1, pageSize: 10 });
      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 10,
        totalPages: 0,
      });
    });

    it('returns empty items when page offset is out of range', async () => {
      mockTx.query.mockResolvedValueOnce([{ total: 5 }]);

      const result = await service.listOrders('user-1', { page: 2, pageSize: 10 });
      expect(result).toEqual({
        items: [],
        total: 5,
        page: 2,
        pageSize: 10,
        totalPages: 1,
      });
    });

    it('returns paged orders with frozen fields, primary image, and items count', async () => {
      mockTx.query
        .mockResolvedValueOnce([{ total: 15 }])
        .mockResolvedValueOnce([
          {
            id: 'ord-1',
            number: 'RG-2026-ABC1',
            source: 'SHOP',
            createdAt: '2026-10-22T12:00:00.000Z',
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
            status: 'PENDING',
            subtotalCents: BigInt(7300),
            taxAmountCents: BigInt(1095),
            taxRateBps: 1500,
            shippingAmountCents: 0,
            totalCents: BigInt(8395),
            currency: 'USD',
            receiptId: 'rcpt-1',
            taxEnabled: true,
            snapshot: {
              delivery: { scheduledDeliveryDate: '2026-11-15T15:00:00.000Z' },
              items: [
                { productId: 'p1', name: 'Regalo A', quantity: 2, unitPriceCents: 3650, lineTotalCents: 7300, imageUrl: 'https://img.test/a.jpg' },
              ],
            },
          },
        ]);

      const result = await service.listOrders('user-1', { page: 1, pageSize: 10 });
      expect(result.total).toBe(15);
      expect(result.totalPages).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        id: 'ord-1',
        number: 'RG-2026-ABC1',
        source: 'SHOP',
        receiptAvailable: true,
        createdAt: '2026-10-22T12:00:00.000Z',
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        status: 'PENDING',
        totalCents: 8395,
        currency: 'USD',
        paymentStatus: 'APPROVED',
        receiptId: 'rcpt-1',
        itemsCount: 2,
        primaryImageUrl: 'https://img.test/a.jpg',
        primaryProductId: 'p1',
        subtotalCents: 7300,
        taxAmountCents: 1095,
        taxRateBps: 1500,
        shippingAmountCents: 0,
        taxEnabled: true,
      });
    });

    it('handles snapshot delivered as valid JSON string and null primary image', async () => {
      const snapJsonString = JSON.stringify({
        items: [{ productId: 'p2', name: 'Regalo B', sku: 'SKU-B', quantity: 1, unitPriceCents: 5000, lineTotalCents: 5000, imageUrl: '   ' }],
      });

      mockTx.query
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([
          {
            id: 'ord-2',
            number: 'RG-2026-ABC2',
            createdAt: '2026-10-22T12:00:00.000Z',
            scheduledDeliveryDate: '2026-11-20T12:00:00.000Z',
            status: 'ASSIGNED',
            subtotalCents: '5000',
            taxAmountCents: '0',
            taxRateBps: 0,
            shippingAmountCents: 0,
            totalCents: 5000,
            currency: 'USD',
            receiptId: 'rcpt-2',
            taxEnabled: false,
            snapshot: snapJsonString,
          },
        ]);

      const result = await service.listOrders('user-1', { page: 1, pageSize: 10, status: OrderStatus.ASSIGNED });
      expect(result.items[0].primaryImageUrl).toBeNull();
      expect(result.items[0].primaryProductId).toBe('p2');
      expect(result.items[0].scheduledDeliveryDate).toBe('2026-11-20T12:00:00.000Z');
      expect(result.items[0].taxEnabled).toBe(false);
    });

    it('fails closed when snapshot items are missing or corrupted in listOrders', async () => {
      mockTx.query
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([
          {
            id: 'ord-err',
            number: 'RG-ERR',
            createdAt: '2026-10-22T12:00:00.000Z',
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
            status: 'PENDING',
            subtotalCents: 1000,
            taxAmountCents: 150,
            taxRateBps: 1500,
            shippingAmountCents: 0,
            totalCents: 1150,
            currency: 'USD',
            receiptId: 'rcpt-err',
            taxEnabled: true,
            snapshot: { items: [] },
          },
        ]);

      await expect(service.listOrders('user-1', { page: 1, pageSize: 10 })).rejects.toThrow();
    });

    it('fails closed when item quantity is invalid in listOrders', async () => {
      mockTx.query
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([
          {
            id: 'ord-err2',
            number: 'RG-ERR2',
            createdAt: '2026-10-22T12:00:00.000Z',
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
            status: 'PENDING',
            subtotalCents: 1000,
            taxAmountCents: 150,
            taxRateBps: 1500,
            shippingAmountCents: 0,
            totalCents: 1150,
            currency: 'USD',
            receiptId: 'rcpt-err2',
            taxEnabled: true,
            snapshot: { items: [{ name: 'A', quantity: 0 }] },
          },
        ]);

      await expect(service.listOrders('user-1', { page: 1, pageSize: 10 })).rejects.toThrow();
    });
  });

  describe('getOrderDetail', () => {
    it('throws 404 ORDER_NOT_FOUND when order does not exist or belongs to another user', async () => {
      mockTx.query.mockResolvedValue([]);

      await expect(service.getOrderDetail('user-1', '00000000-0000-0000-0000-000000000001')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
        response: {
          error: {
            code: 'ORDER_NOT_FOUND',
          },
        },
      });
    });

    it('returns detail with immutable snapshot and assembled real timeline events including releases and refused attempts', async () => {
      const orderRow = {
        id: 'ord-10',
        number: 'RG-2026-XYZ',
        createdAt: '2026-10-20T10:00:00.000Z',
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        status: 'IN_TRANSIT',
        routeId: 'route-99',
        subtotalCents: BigInt(3650),
        taxAmountCents: BigInt(548),
        taxRateBps: 1500,
        shippingAmountCents: 0,
        totalCents: BigInt(4198),
        currency: 'USD',
        receiptId: 'rcpt-10',
        taxEnabled: true,
        snapshot: {
          buyer: { id: 'user-1', name: 'Juan Perez', email: 'juan@test.com' },
          recipient: { name: 'Maria Lopez', phone: '0999999999' },
          delivery: {
            zoneId: 'z1',
            zoneName: 'Norte',
            address: 'Calle 1 y 2',
            location: { lat: -1.24, lng: -78.61 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
            notes: 'Dejar en portería',
          },
          items: [
            { productId: 'p1', sku: 'SKU-1', name: 'Caja Regalo', quantity: 1, unitPriceCents: 3650, lineTotalCents: 3650, imageUrl: 'https://img.test/pic.png' },
          ],
        },
      };

      const claimsRows = [
        { id: 'c1', claimedAt: '2026-10-20T11:00:00.000Z', releasedAt: '2026-10-20T11:30:00.000Z' },
      ];
      const routeRow = { startedAt: '2026-10-20T12:00:00.000Z' };
      const attemptsRows = [
        { id: 'a1', outcome: 'FAILED', failureReason: 'RECIPIENT_REFUSED', recordedAt: '2026-10-20T13:00:00.000Z' },
        { id: 'a2', outcome: 'FAILED', failureReason: 'OTHER_REASON', recordedAt: '2026-10-20T13:00:00.000Z' },
        { id: 'a3', outcome: 'SUCCESSFUL', failureReason: null, recordedAt: '2026-10-20T14:00:00.000Z' },
      ];

      mockTx.query
        .mockResolvedValueOnce([orderRow])
        .mockResolvedValueOnce(claimsRows)
        .mockResolvedValueOnce([routeRow])
        .mockResolvedValueOnce(attemptsRows);

      const detail = await service.getOrderDetail('user-1', 'ord-10');
      expect(detail.id).toBe('ord-10');
      expect(detail.buyer.name).toBe('Juan Perez');
      expect(detail.recipient!.name).toBe('Maria Lopez');
      expect(detail.delivery.address).toBe('Calle 1 y 2');
      expect(detail.delivery.zoneId).toBe('z1');
      expect(detail.items).toHaveLength(1);
      expect(detail.items[0].sku).toBe('SKU-1');

      // Timeline assertions: verify distinct events sharing timestamps are NOT collapsed
      expect(detail.timeline).toHaveLength(7);
      expect(detail.timeline[0].code).toBe('PENDING');
      expect(detail.timeline[1]).toEqual({ code: 'ASSIGNED', label: 'Asignado a ruta', at: '2026-10-20T11:00:00.000Z' });
      expect(detail.timeline[2]).toEqual({ code: 'CLAIM_RELEASED', label: 'Reserva de ruta liberada', at: '2026-10-20T11:30:00.000Z' });
      expect(detail.timeline[3]).toEqual({ code: 'IN_TRANSIT', label: 'En camino', at: '2026-10-20T12:00:00.000Z' });
      expect(detail.timeline[4]).toEqual({ code: 'ATTEMPT_FAILED', label: 'Intento de entrega fallido: entrega rechazada', at: '2026-10-20T13:00:00.000Z' });
      expect(detail.timeline[5]).toEqual({ code: 'ATTEMPT_FAILED', label: 'Intento de entrega fallido', at: '2026-10-20T13:00:00.000Z' });
      expect(detail.timeline[6]).toEqual({ code: 'DELIVERED', label: 'Entregado', at: '2026-10-20T14:00:00.000Z' });
    });

    it('fails closed when buyer data or recipient data is corrupted in detail snapshot', async () => {
      const corruptOrderRow = {
        id: 'ord-bad',
        number: 'RG-BAD',
        createdAt: '2026-10-20T10:00:00.000Z',
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        status: 'PENDING',
        routeId: null,
        subtotalCents: 1000,
        taxAmountCents: 150,
        taxRateBps: 1500,
        shippingAmountCents: 0,
        totalCents: 1150,
        currency: 'USD',
        receiptId: 'rcpt-bad',
        taxEnabled: true,
        snapshot: {
          buyer: { name: '', email: 'b@test.com' },
          items: [{ name: 'A', sku: 'SKU', quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000 }],
        },
      };

      mockTx.query
        .mockResolvedValueOnce([corruptOrderRow])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(service.getOrderDetail('user-1', 'ord-bad')).rejects.toThrow();
    });

    it('accepts a coverage-era snapshot with null zoneId and zoneName', async () => {
      const orderRow = {
        id: 'ord-cov',
        number: 'RG-2026-COV',
        createdAt: '2026-10-20T10:00:00.000Z',
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        status: 'PENDING',
        routeId: null,
        subtotalCents: BigInt(3650),
        taxAmountCents: BigInt(548),
        taxRateBps: 1500,
        shippingAmountCents: 0,
        totalCents: BigInt(4198),
        currency: 'USD',
        receiptId: 'rcpt-cov',
        taxEnabled: true,
        snapshot: {
          buyer: { id: 'user-1', name: 'Juan Perez', email: 'juan@test.com' },
          recipient: { name: 'Maria Lopez', phone: '0999999999' },
          delivery: {
            zoneId: null,
            zoneName: null,
            address: 'Calle 1 y 2',
            location: { lat: -1.24, lng: -78.61 },
            scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
            notes: null,
          },
          items: [
            { productId: 'p1', sku: 'SKU-1', name: 'Caja Regalo', quantity: 1, unitPriceCents: 3650, lineTotalCents: 3650, imageUrl: null },
          ],
        },
      };
      mockTx.query
        .mockResolvedValueOnce([orderRow])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const detail = await service.getOrderDetail('user-1', 'ord-cov');
      expect(detail.delivery.zoneId).toBeNull();
      expect(detail.delivery.zoneName).toBeNull();
      expect(detail.delivery.address).toBe('Calle 1 y 2');
    });

    it('fails closed when delivery coordinates are missing in detail snapshot', async () => {
      const corruptDeliveryRow = {
        id: 'ord-bad-del',
        number: 'RG-BAD-DEL',
        createdAt: '2026-10-20T10:00:00.000Z',
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
        status: 'PENDING',
        routeId: null,
        subtotalCents: 1000,
        taxAmountCents: 150,
        taxRateBps: 1500,
        shippingAmountCents: 0,
        totalCents: 1150,
        currency: 'USD',
        receiptId: 'rcpt-bad-del',
        taxEnabled: true,
        snapshot: {
          buyer: { name: 'Juan', email: 'j@test.com' },
          recipient: { name: 'Ana', phone: '099111222' },
          delivery: { zoneId: 'z', zoneName: 'ZN', address: 'Calle 1' },
          items: [{ name: 'A', sku: 'SKU', quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000 }],
        },
      };

      mockTx.query
        .mockResolvedValueOnce([corruptDeliveryRow])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(service.getOrderDetail('user-1', 'ord-bad-del')).rejects.toThrow();
    });
  });

  describe('getOrderReceipt', () => {
    it('throws 404 ORDER_NOT_FOUND when receipt is not found', async () => {
      mockTx.query.mockResolvedValue([]);

      await expect(service.getOrderReceipt('user-1', 'ord-404')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
        response: {
          error: {
            code: 'ORDER_NOT_FOUND',
          },
        },
      });
    });

    it('returns sanitized receipt without card PAN, CVV, or secrets', async () => {
      const receiptRow = {
        id: 'rcpt-50',
        number: 'CMP-RG-2026-050',
        orderId: 'ord-50',
        issuedAt: '2026-10-22T12:00:00.000Z',
        merchantName: 'REGALÍA',
        currency: 'USD',
        subtotalCents: BigInt(7300),
        taxMode: 'SIMULATED',
        taxEnabled: true,
        taxRateBps: 1500,
        taxAmountCents: BigInt(1095),
        shippingStatus: 'FREE_INCLUDED',
        shippingAmountCents: 0,
        totalCents: BigInt(8395),
        disclaimer: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA',
        snapshot: {
          buyer: { name: 'Comprador A', email: 'a@test.com' },
          recipient: { name: 'Destinatario B' },
          payment: { reference: 'PAY-DEMO-001', cardLast4: '0001' },
          items: [
            { sku: 'SKU-A', name: 'Caja 1', quantity: 2, unitPriceCents: 3650, lineTotalCents: 7300 },
          ],
        },
      };

      mockTx.query.mockResolvedValueOnce([receiptRow]);

      const receipt = await service.getOrderReceipt('user-1', 'ord-50');
      expect(receipt.id).toBe('rcpt-50');
      expect(receipt.number).toBe('CMP-RG-2026-050');
      expect(receipt.merchantName).toBe('REGALÍA');
      expect(receipt.disclaimer).toBe('COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA');
      expect(receipt.buyer).toEqual({ name: 'Comprador A', email: 'a@test.com' });
      expect(receipt.recipient).toEqual({ name: 'Destinatario B' });
      expect(receipt.items).toEqual([
        { sku: 'SKU-A', name: 'Caja 1', quantity: 2, unitPriceCents: 3650, lineTotalCents: 7300 },
      ]);
      expect(receipt.payment).toEqual({
        status: 'APPROVED',
        reference: 'PAY-DEMO-001',
        cardLast4: '0001',
      });
      expect(receipt.tax).toEqual({
        mode: 'SIMULATED',
        enabled: true,
        rateBps: 1500,
        ratePercent: 15,
        amountCents: 1095,
      });
      expect(receipt.shipping).toEqual({
        status: 'FREE_INCLUDED',
        amountCents: 0,
        includedInPrices: true,
      });
    });

    it('maps a declared ADMIN receipt with distinct buyer and recipient phones', async () => {
      mockTx.query.mockResolvedValueOnce([{
        id: 'rcpt-decl',
        number: 'CMP-RG-DECL',
        orderId: 'ord-decl',
        issuedAt: '2026-10-22T12:00:00.000Z',
        merchantName: 'REGALÍA',
        currency: 'USD',
        subtotalCents: BigInt(7300),
        taxMode: 'SIMULATED',
        taxEnabled: true,
        taxRateBps: 1500,
        taxAmountCents: BigInt(1095),
        shippingStatus: 'FREE_INCLUDED',
        shippingAmountCents: 0,
        totalCents: BigInt(8395),
        disclaimer: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA',
        snapshot: {
          buyer: { name: 'Owner', phone: '+593111' },
          recipient: { name: 'Gift', phone: '+593222' },
          payment: {
            kind: 'ADMIN_DECLARED_EXTERNAL',
            status: 'DECLARED',
            method: 'CASH',
            declaredById: 'admin-1',
            declaredAt: '2026-10-22T12:00:00.000Z',
          },
          items: [{ sku: 'SKU-A', name: 'Caja 1', quantity: 1, unitPriceCents: 7300, lineTotalCents: 7300 }],
        },
      }]);
      const receipt = await service.getOrderReceipt('user-1', 'ord-decl');
      expect(receipt.buyer).toEqual({ name: 'Owner', phone: '+593111' });
      expect(receipt.recipient).toEqual({ name: 'Gift', phone: '+593222' });
      expect(receipt.payment).toEqual({
        kind: 'ADMIN_DECLARED_EXTERNAL',
        status: 'DECLARED',
        method: 'CASH',
        declaredById: 'admin-1',
        declaredAt: '2026-10-22T12:00:00.000Z',
      });
    });

    it('fails closed when payment data is missing from receipt snapshot', async () => {
      const badReceiptRow = {
        id: 'rcpt-bad-pay',
        number: 'CMP-BAD',
        orderId: 'ord-bad-pay',
        issuedAt: '2026-10-22T12:00:00.000Z',
        merchantName: 'REGALÍA',
        currency: 'USD',
        subtotalCents: 1000,
        taxMode: 'SIMULATED',
        taxEnabled: true,
        taxRateBps: 1500,
        taxAmountCents: 150,
        shippingStatus: 'FREE_INCLUDED',
        shippingAmountCents: 0,
        totalCents: 1150,
        disclaimer: 'COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA',
        snapshot: {
          buyer: { name: 'A', email: 'a@test.com' },
          recipient: { name: 'B' },
          items: [{ sku: 'SKU', name: 'Item', quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000 }],
        },
      };

      mockTx.query.mockResolvedValueOnce([badReceiptRow]);

      await expect(service.getOrderReceipt('user-1', 'ord-bad-pay')).rejects.toThrow();
    });
  });

  describe('historial unificado Shop + ADMIN (#46)', () => {
    const withReceipt = (id: string, source: string) => ({
      id,
      number: `RG-${id}`,
      source,
      createdAt: '2026-10-22T12:00:00.000Z',
      scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      status: 'PENDING',
      subtotalCents: BigInt(1000),
      taxAmountCents: BigInt(150),
      taxRateBps: 1500,
      shippingAmountCents: 0,
      totalCents: BigInt(1150),
      currency: 'USD',
      receiptId: `rcpt-${id}`,
      taxEnabled: true,
      snapshot: { items: [{ productId: 'p', name: 'Regalo', sku: 'S', quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000 }] },
    });
    const withoutReceipt = (id: string, source = 'SHOP') => ({
      id,
      number: null,
      source,
      createdAt: '2026-09-01T12:00:00.000Z',
      scheduledDeliveryDate: '2026-09-05T15:00:00.000Z',
      status: 'DELIVERED',
      subtotalCents: null,
      taxAmountCents: null,
      taxRateBps: null,
      shippingAmountCents: null,
      totalCents: null,
      currency: null,
      receiptId: null,
      taxEnabled: null,
      snapshot: null,
    });

    it('una sola lista con el origen de cada pedido: Shop, ADMIN y uno conservado sin comprobante', async () => {
      mockTx.query
        .mockResolvedValueOnce([{ total: 3 }])
        .mockResolvedValueOnce([withReceipt('shop-1', 'SHOP'), withReceipt('admin-1', 'ADMIN'), withoutReceipt('legacy-1')]);

      const result = await service.listOrders('user-1', { page: 1, pageSize: 10 });

      expect(result.items.map((i) => [i.id, i.source, i.receiptAvailable])).toEqual([
        ['shop-1', 'SHOP', true],
        ['admin-1', 'ADMIN', true],
        ['legacy-1', 'SHOP', false],
      ]);
      expect(result.total).toBe(3);
    });

    it('un pedido sin comprobante no inventa importes, pago ni ítems: todo lo derivado del comprobante es null', async () => {
      mockTx.query.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([withoutReceipt('legacy-1', 'ADMIN')]);

      const [item] = (await service.listOrders('user-1', { page: 1, pageSize: 10 })).items;

      expect(item).toEqual({
        id: 'legacy-1',
        number: null,
        source: 'ADMIN',
        receiptAvailable: false,
        createdAt: '2026-09-01T12:00:00.000Z',
        scheduledDeliveryDate: '2026-09-05T15:00:00.000Z',
        status: 'DELIVERED',
        totalCents: null,
        currency: 'USD',
        paymentStatus: null,
        receiptId: null,
        itemsCount: null,
        primaryImageUrl: null,
        primaryProductId: null,
        subtotalCents: null,
        taxAmountCents: null,
        taxRateBps: null,
        shippingAmountCents: null,
        taxEnabled: null,
      });
    });

    it('un pedido antiguo sin comprobante y sin fecha programada se lista con la fecha en null: no se inventa una', async () => {
      mockTx.query
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([{ ...withoutReceipt('legacy-1'), scheduledDeliveryDate: null }]);
      const [item] = (await service.listOrders('user-1', { page: 1, pageSize: 10 })).items;
      expect(item).toMatchObject({ id: 'legacy-1', receiptAvailable: false, scheduledDeliveryDate: null, totalCents: null });
    });

    it('el detalle de un pedido sin comprobante conserva el seguimiento y deja importes, pago e ítems sin disponer', async () => {
      mockTx.query
        .mockResolvedValueOnce([
          {
            ...withoutReceipt('legacy-1', 'ADMIN'),
            routeId: null,
            buyerName: 'María Pérez',
            buyerEmail: 'maria@example.test',
            recipientName: 'Ana',
            recipientPhone: '0991234567',
            deliveryAddress: 'Av. Cevallos',
            deliveryLat: -1.24,
            deliveryLng: -78.62,
            zoneId: null,
            zoneName: null,
          },
        ])
        .mockResolvedValueOnce([]) // claims
        .mockResolvedValueOnce([]); // attempts

      const detail = await service.getOrderDetail('user-1', 'legacy-1');

      expect(detail).toMatchObject({
        id: 'legacy-1',
        source: 'ADMIN',
        receiptAvailable: false,
        number: null,
        totalCents: null,
        paymentStatus: null,
        receiptId: null,
        subtotalCents: null,
        taxEnabled: null,
        items: [],
        buyer: { id: 'user-1', name: 'María Pérez', email: 'maria@example.test' },
        recipient: { name: 'Ana', phone: '0991234567' },
        delivery: { address: 'Av. Cevallos', location: { lat: -1.24, lng: -78.62 }, zoneId: null },
      });
      expect(detail.timeline.map((t) => t.code)).toEqual(['PENDING']);
    });

    it('el detalle sin comprobante tolera un pedido conservado sin destinatario ni coordenadas', async () => {
      mockTx.query
        .mockResolvedValueOnce([
          { ...withoutReceipt('legacy-2'), routeId: null, buyerName: null, buyerEmail: null, recipientName: null, recipientPhone: null, deliveryAddress: null, deliveryLat: null, deliveryLng: null, zoneId: null, zoneName: null },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const detail = await service.getOrderDetail('user-1', 'legacy-2');

      expect(detail.recipient).toBeNull();
      expect(detail.delivery).toMatchObject({ address: '', location: null });
    });

    it('el detalle sin comprobante y sin fecha programada informa la fecha en null', async () => {
      mockTx.query
        .mockResolvedValueOnce([{ ...withoutReceipt('legacy-3'), scheduledDeliveryDate: null, routeId: null, buyerName: 'M', buyerEmail: 'm@x.test', recipientName: null, recipientPhone: null, deliveryAddress: 'Dir', deliveryLat: null, deliveryLng: null, zoneId: null, zoneName: null }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const detail = await service.getOrderDetail('user-1', 'legacy-3');
      expect(detail.scheduledDeliveryDate).toBeNull();
      expect(detail.delivery.scheduledDeliveryDate).toBeNull();
    });

    it('el comprobante de un pedido propio sin comprobante responde RECEIPT_UNAVAILABLE y no genera uno', async () => {
      mockTx.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'legacy-1' }]);
      await expect(service.getOrderReceipt('user-1', 'legacy-1')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
        response: { error: { code: 'RECEIPT_UNAVAILABLE' } },
      });
      expect(mockTx.execute).not.toHaveBeenCalled();
    });

    it('un pedido ajeno o inexistente sigue dando ORDER_NOT_FOUND, sin revelar que existe', async () => {
      mockTx.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await expect(service.getOrderReceipt('user-1', 'de-otro')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
        response: { error: { code: 'ORDER_NOT_FOUND' } },
      });
    });
  });
});
