import { RouteHistoryService } from './route-history.service.js';
import { LegacyRouteReconciliationService } from './legacy-route-reconciliation.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { RouteReturnService } from './route-return.service.js';
import { RouteAssignmentService } from './route-assignment.service.js';
import { RouteProgressService } from './route-progress.service.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RoutesController } from './routes.controller.js';
import { RouteExecutionService } from './route-execution.service.js';
import { RoutesService } from './routes.service.js';

@Module({
  imports: [AuthModule],
  controllers: [RoutesController],
  providers: [
    RouteHistoryService,
    RouteAvailabilityService,
    RouteReturnService,
    LegacyRouteReconciliationService,
    RouteAssignmentService,
    RoutesService,
    RouteExecutionService,
    RouteProgressService,
  ],
  exports: [
    RouteAvailabilityService,
    RoutesService,
    RouteProgressService,
    RouteHistoryService,
  ],
})
export class RoutesModule {}
