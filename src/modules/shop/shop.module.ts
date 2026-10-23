import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module.js';
import { ShopSettingsModule } from './settings/shop-settings.module.js';
import { UploadsModule } from './uploads/uploads.module.js';

@Module({
  imports: [CatalogModule, UploadsModule, ShopSettingsModule],
  exports: [ShopSettingsModule],
})
export class ShopModule {}
