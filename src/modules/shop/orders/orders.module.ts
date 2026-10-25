import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../database/prisma.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { OrdersController } from './orders.controller.js';
import { ShopOrdersService } from './orders.service.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [OrdersController],
  providers: [ShopOrdersService],
  exports: [ShopOrdersService],
})
export class ShopOrdersModule {}
