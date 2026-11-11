import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminStoreCoverageController } from './admin-store-coverage.controller.js';
import { StoreCoverageController } from './store-coverage.controller.js';
import { StoreCoverageService } from './store-coverage.service.js';

@Module({
  imports: [AuthModule],
  controllers: [StoreCoverageController, AdminStoreCoverageController],
  providers: [StoreCoverageService],
  exports: [StoreCoverageService],
})
export class StoreCoverageModule {}
