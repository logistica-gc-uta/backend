import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../database/prisma.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { ShopSettingsModule } from '../settings/shop-settings.module.js';
import { CheckoutConfirmationService } from './checkout-confirmation.service.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

@Module({
  imports: [AuthModule, PrismaModule, ShopSettingsModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, CheckoutConfirmationService],
  exports: [CheckoutService, CheckoutConfirmationService],
})
export class CheckoutModule {}
