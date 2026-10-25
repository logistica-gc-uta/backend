import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../database/prisma.service.js';
import { ShopOrdersModule } from './orders.module.js';

describe('ShopOrdersModule DI and bootstrap', () => {
  it('compiles and resolves all controller and guard dependencies cleanly', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ShopOrdersModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ client: {} })
      .compile();

    expect(moduleRef).toBeDefined();
    expect(moduleRef.get(ShopOrdersModule)).toBeInstanceOf(ShopOrdersModule);
  });
});
