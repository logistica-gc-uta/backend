import { DispatchInterventionService } from './dispatch-intervention.service.js';
import { DispatchEmergencyService } from './dispatch-emergency.service.js';
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
import { ShopSettingsModule } from '../shop/settings/shop-settings.module.js';
import { StoreCoverageModule } from '../store-coverage/store-coverage.module.js';
import { RoutesController } from './routes.controller.js';
import { RouteExecutionService } from './route-execution.service.js';
import { RoutesService } from './routes.service.js';
import { RoutePlanningService } from './route-planning.service.js';
import { RoutePlanningController } from './route-planning.controller.js';
import { RoadMetricsService } from './road/road-metrics.service.js';

@Module({
  imports: [AuthModule, StoreCoverageModule, ShopSettingsModule],
  controllers: [RoutesController, RoutePlanningController, DispatchController],
  providers: [
    // Motor vial (#47): se construye con la configuración del entorno, no por inyección de parámetros.
    { provide: RoadMetricsService, useFactory: () => new RoadMetricsService() },
    DispatchEmergencyService,
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
