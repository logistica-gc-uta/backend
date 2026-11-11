import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../database/prisma.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { ShopSettingsModule } from '../settings/shop-settings.module.js';
import { StoreCoverageModule } from '../../store-coverage/store-coverage.module.js';
import { CheckoutAttemptController } from './checkout-attempt.controller.js';
import { CheckoutAttemptService } from './checkout-attempt.service.js';
import { CheckoutConfirmationService } from './checkout-confirmation.service.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

@Module({
  imports: [AuthModule, PrismaModule, ShopSettingsModule, StoreCoverageModule],
  controllers: [CheckoutController, CheckoutAttemptController],
  providers: [
    CheckoutService,
    CheckoutConfirmationService,
    CheckoutAttemptService,
  ],
  exports: [
    CheckoutService,
    CheckoutConfirmationService,
    CheckoutAttemptService,
  ],
})
export class CheckoutModule {}
