import { ProductsController } from './products.controller.js';

describe('ProductsController', () => {
  let controller: ProductsController;
  let productsServiceMock: any;

  beforeEach(() => {
    productsServiceMock = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      updateStock: jest.fn(),
    };
    controller = new ProductsController(productsServiceMock);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('findAll debe delegar al servicio', async () => {
    const products = [{ id: '1', name: 'P1' }];
    productsServiceMock.findAll.mockResolvedValue(products);

    const result = await controller.findAll();
    expect(productsServiceMock.findAll).toHaveBeenCalled();
    expect(result).toEqual(products);
  });

  it('create debe delegar al servicio', async () => {
    const dto = { name: 'P1', price: 100, stock: 10 };
    const created = { id: '1', ...dto };
    productsServiceMock.create.mockResolvedValue(created);

    const result = await controller.create(dto);
    expect(productsServiceMock.create).toHaveBeenCalledWith(dto);
    expect(result).toEqual(created);
  });

  it('updateStock debe delegar al servicio', async () => {
    const updated = { id: '1', stock: 20 };
    productsServiceMock.updateStock.mockResolvedValue(updated);

    const result = await controller.updateStock('1', { stock: 20 });
    expect(productsServiceMock.updateStock).toHaveBeenCalledWith('1', { stock: 20 });
    expect(result).toEqual(updated);
  });
});
