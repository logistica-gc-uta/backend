import { DispatchInterventionService } from './dispatch-intervention.service.js';
import { DispatchController } from './dispatch.controller.js';
import { RouteUrgencyService } from './route-urgency.service.js';
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
import { RoutePlanningService } from './route-planning.service.js';
import { RoutePlanningController } from './route-planning.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [RoutesController, RoutePlanningController, DispatchController],
  providers: [
    DispatchInterventionService,
    RouteUrgencyService,
    RouteHistoryService,
    RouteAvailabilityService,
    RouteReturnService,
    LegacyRouteReconciliationService,
    RouteAssignmentService,
    RoutesService,
    RouteExecutionService,
    RouteProgressService,
    RoutePlanningService,
  ],
  exports: [
    RouteAvailabilityService,
    RoutesService,
    RouteProgressService,
    RouteHistoryService,
  ],
})
export class RoutesModule {}
