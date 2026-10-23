import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../database/prisma.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { AdminCatalogController, PublicCatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({ imports: [AuthModule, PrismaModule], controllers: [PublicCatalogController, AdminCatalogController], providers: [CatalogService] })
export class CatalogModule {}
