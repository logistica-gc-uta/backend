import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './database/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { RoutesModule } from './modules/routes/routes.module.js';
import { ZonesModule } from './modules/zones/zones.module.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ZonesModule,
    ProductsModule,
    OrdersModule,
    RoutesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
