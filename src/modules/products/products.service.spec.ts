import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { ProductsService } from './products.service.js';

describe('ProductsService', () => {
  let service: ProductsService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      product: {
        where: jest.fn().mockReturnThis(),
        all: jest.fn(),
        first: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('debe listar únicamente los productos disponibles con stock mayor a 0', async () => {
      const mockProducts = [
        { id: 'prod-1', name: 'Laptop', price: 750, stock: 10 },
        { id: 'prod-2', name: 'Mouse', price: 25, stock: 5 },
      ];

      prismaMock.product.all.mockResolvedValue(mockProducts);

      const result = await service.findAll();

      expect(prismaMock.product.where).toHaveBeenCalled();
      expect(result).toEqual(mockProducts);
      expect(result.every((p: any) => p.stock > 0)).toBe(true);
    });
  });

  describe('findOne', () => {
    it('debe retornar el producto si existe', async () => {
      const mockProduct = { id: 'prod-1', name: 'Laptop', price: 750, stock: 10 };
      prismaMock.product.first.mockResolvedValue(mockProduct);

      const result = await service.findOne('prod-1');

      expect(result).toEqual(mockProduct);
    });

    it('debe lanzar NotFoundException si el producto no existe', async () => {
      prismaMock.product.first.mockResolvedValue(null);

      await expect(service.findOne('prod-inexistente')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('debe crear exitosamente un nuevo producto', async () => {
      const dto = {
        name: 'Teclado Mecánico',
        description: 'RGB Switches Azules',
        price: 60.0,
        stock: 30,
      };

      const createdProduct = {
        id: 'prod-3',
        ...dto,
      };

      prismaMock.product.create.mockResolvedValue(createdProduct);

      const result = await service.create(dto);

      expect(prismaMock.product.create).toHaveBeenCalledWith({
        name: dto.name,
        description: dto.description,
        price: dto.price,
        stock: dto.stock,
      });
      expect(result).toEqual(createdProduct);
    });

    it('debe crear un producto con descripción null si no se proporciona', async () => {
      const dto = {
        name: 'Cable USB-C',
        price: 10.0,
        stock: 100,
      };

      prismaMock.product.create.mockImplementation((data: any) =>
        Promise.resolve({ id: 'prod-4', ...data }),
      );

      const result = await service.create(dto);

      expect(prismaMock.product.create).toHaveBeenCalledWith({
        name: dto.name,
        description: null,
        price: dto.price,
        stock: dto.stock,
      });
      expect(result.description).toBeNull();
    });
  });

  describe('updateStock', () => {
    it('debe actualizar el stock de un producto existente', async () => {
      const mockProduct = { id: 'prod-1', name: 'Laptop', price: 750, stock: 10 };
      const updatedProduct = { ...mockProduct, stock: 25 };

      prismaMock.product.first.mockResolvedValue(mockProduct);
      prismaMock.product.update.mockResolvedValue(updatedProduct);

      const result = await service.updateStock('prod-1', { stock: 25 });

      expect(prismaMock.product.where).toHaveBeenCalledWith({ id: 'prod-1' });
      expect(prismaMock.product.update).toHaveBeenCalledWith({ stock: 25 });
      expect(result.stock).toBe(25);
    });

    it('debe lanzar NotFoundException si se intenta actualizar el stock de un producto que no existe', async () => {
      prismaMock.product.first.mockResolvedValue(null);

      await expect(
        service.updateStock('prod-inexistente', { stock: 50 }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
