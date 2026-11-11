import { RoutesModule } from '../routes/routes.module.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ShopSettingsModule } from '../shop/settings/shop-settings.module.js';
import { StoreCoverageModule } from '../store-coverage/store-coverage.module.js';
import { AdminPurchaseService } from './admin-purchase.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [AuthModule, RoutesModule, StoreCoverageModule, ShopSettingsModule],
  controllers: [OrdersController],
  providers: [OrdersService, AdminPurchaseService],
  exports: [OrdersService],
})
export class OrdersModule {}
