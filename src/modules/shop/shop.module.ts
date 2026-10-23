import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { ShopSettingsModule } from './settings/shop-settings.module.js';
import { UploadsModule } from './uploads/uploads.module.js';

@Module({
  imports: [CatalogModule, UploadsModule, ShopSettingsModule, CheckoutModule],
  exports: [ShopSettingsModule, CheckoutModule],
})
export class ShopModule {}
