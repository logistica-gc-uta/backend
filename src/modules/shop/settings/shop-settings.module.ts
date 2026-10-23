import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../database/prisma.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { AdminShopSettingsController } from './admin-shop-settings.controller.js';
import { ShopSettingsController } from './shop-settings.controller.js';
import { ShopSettingsService } from './shop-settings.service.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [ShopSettingsController, AdminShopSettingsController],
  providers: [ShopSettingsService],
  exports: [ShopSettingsService],
})
export class ShopSettingsModule {}
