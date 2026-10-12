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
      'Propose routes with Clarke & Wright for a day (read-only; nothing is persisted)',
    description:
      'Selects the PENDING, geographically ready orders scheduled on the given America/Guayaquil calendar day, groups them by zone and returns temporary proposals of at most four stops that start and end at the zone depot. Distances are straight-line (Haversine). Orders that cannot be planned are listed in `excluded` with their reasons. A proposal is confirmed as DRAFT with POST /routes (using its `zoneId`, `routeDate` and `orderIds`) and assigned with POST /routes/:id/assign.',
  })
  @ApiResponse({ status: 200, type: RouteProposalResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid or missing date, invalid zoneId or unknown query field',
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Current ADMIN role required' })
  @ApiResponse({ status: 404, description: 'Zone not found' })
  @ApiResponse({
    status: 422,
    description: 'Too many plannable orders in one zone for a single request',
  })
  async propose(
    @Query() query: PlanRoutesQueryDto,
  ): Promise<RouteProposalResponseDto> {
    return this.planning.propose(query);
  }
}
