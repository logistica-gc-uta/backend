import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { DriversService } from './drivers.service.js';

describe('DriversService', () => {
  let service: DriversService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      driver: {
        include: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [DriversService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    service = module.get<DriversService>(DriversService);
  });

  it('findAll debe listar los repartidores incluyendo su usuario', async () => {
    const drivers = [{ id: 'd1', isAvailable: true, user: { name: 'Carlos Chofer' } }];
    const allMock = jest.fn().mockResolvedValue(drivers);
    prismaMock.driver.include.mockReturnValue({ all: allMock });

    const result = await service.findAll();

    expect(prismaMock.driver.include).toHaveBeenCalledWith('user');
    expect(result).toEqual(drivers);
  });
});
