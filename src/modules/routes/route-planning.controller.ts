import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PlanRoutesQueryDto } from './dto/plan-routes-query.dto.js';
import { RouteProposalResponseDto } from './dto/route-proposal-response.dto.js';
import { RoutePlanningService } from './route-planning.service.js';

// Served under its own path, not /routes/proposals, so GET /routes/:id can never capture it.
@ApiTags('Routes')
@ApiBearerAuth('JWT-auth')
@Controller('route-proposals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RoutePlanningController {
  constructor(private readonly planning: RoutePlanningService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Propose routes grouped by compatible delivery time window and road/distance savings (read-only; nothing is persisted)',
    description:
      'Selects the PENDING, geographically ready orders scheduled on the given America/Guayaquil calendar day, groups them by zone (or common store origin when zoneId is null) and compatible scheduled-hour window (max - min <= ShopBusinessSettings.routePlanning.timeWindowMarginMinutes, default 30 min), and returns temporary proposals bounded by both an independent four-stop maximum and the effective vehicle capacity in product units (selected driverId stored vehicleCapacity, or default 4 when unset or omitted), ordered chronologically (earliest scheduledDeliveryDate first). Order demand is the indivisible sum of OrderItem.quantity (legacy itemless orders count as 1); orders exceeding vehicle capacity are never split and appear in `excluded` with reason `VEHICLE_CAPACITY_EXCEEDED` and `requiredUnits`. When StoreCoverage is configured, its store location is used as the common origin and return depot across proposals (falling back to zone depot coordinates otherwise). When ROAD_ENGINE=OSRM is active, OSRM estimated road durations (no live traffic, not an ETA) are used as the primary routing cost with road distance for tie-breaks; otherwise straight-line Haversine distance is used. A proposal is confirmed as DRAFT with POST /routes (using its `routeDate`, `orderIds`, optional nullable `zoneId`, and optional `driverId`) and assigned with POST /routes/:id/assign.',
  })
  @ApiResponse({ status: 200, type: RouteProposalResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid or missing date, invalid zoneId, invalid driverId or unknown query field',
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Current ADMIN role required' })
  @ApiResponse({ status: 404, description: 'Zone or driver not found' })
  @ApiResponse({
    status: 422,
    description:
      'Too many plannable orders in one zone for a single request, or (road engine) ROAD_ROUTE_NOT_FOUND / ROAD_POINT_OFF_NETWORK / ROAD_MATRIX_TOO_LARGE with the affected order ids',
  })
  @ApiResponse({
    status: 502,
    description: 'ROAD_ENGINE_BAD_RESPONSE: the road engine answered with incomplete data; nothing is proposed',
  })
  @ApiResponse({
    status: 503,
    description: 'ROAD_ENGINE_UNAVAILABLE: the road engine did not answer; no routes are proposed and nothing is persisted',
  })
  async propose(
    @Query() query: PlanRoutesQueryDto,
  ): Promise<RouteProposalResponseDto> {
    return this.planning.propose(query);
  }

  @Get('road-engine')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Estado del motor vial (solo ADMIN)',
    description:
      'Indica si las propuestas usan la red vial (OSRM) o la línea recta, y si el motor responde ahora. No expone la URL ni credenciales de la instancia. Si el motor no responde, las propuestas nuevas se rechazan con ROAD_ENGINE_UNAVAILABLE: no se generan rutas con datos incompletos ni en línea recta, los pedidos siguen pendientes y las rutas ya generadas no se cancelan.',
  })
  @ApiResponse({ status: 200, description: 'Estado actual del motor vial' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Current ADMIN role required' })
  async roadEngine() {
    return this.planning.roadEngineStatus();
  }
}
