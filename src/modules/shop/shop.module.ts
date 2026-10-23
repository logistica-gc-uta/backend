import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module.js';
import { UploadsModule } from './uploads/uploads.module.js';

@Module({ imports: [CatalogModule, UploadsModule] })
export class ShopModule {}
