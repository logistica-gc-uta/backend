import { RoutesModule } from '../routes/routes.module.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DriverAbsencesController } from './driver-absences.controller.js';
import { DriverAbsencesService } from './driver-absences.service.js';
import { DriversController } from './drivers.controller.js';
import { DriversService } from './drivers.service.js';

@Module({
  imports: [AuthModule, RoutesModule],
  controllers: [DriversController, DriverAbsencesController],
  providers: [DriversService, DriverAbsencesService],
  exports: [DriversService, DriverAbsencesService],
})
export class DriversModule {}
