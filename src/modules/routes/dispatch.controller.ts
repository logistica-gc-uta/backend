import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
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
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DispatchInterventionService } from './dispatch-intervention.service.js';
import {
  DispatchAuditDto,
  DispatchInterventionDto,
} from './dto/dispatch-intervention.dto.js';
import { RouteUrgencyService } from './route-urgency.service.js';
import {
  UrgencyInboxDto,
  UrgencyProposalDto,
} from './dto/urgency-response.dto.js';

@ApiTags('Dispatch')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('dispatch')
export class DispatchController {
  constructor(
    private readonly urgency: RouteUrgencyService,
    private readonly interventions: DispatchInterventionService,
  ) {}

  @Post('interventions')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Atomically confirm/reject, reorder, move, reassign or prioritize with ADMIN audit',
  })
  @ApiResponse({ status: 200, type: DispatchAuditDto })
  @ApiResponse({
    status: 400,
    description:
      'Invalid or extra fields; actor identity is never accepted in body',
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Current ADMIN role required' })
  @ApiResponse({
    status: 409,
    description:
      'Stale proposal, frozen route, resource or idempotency conflict',
  })
  intervene(
    @Body() dto: DispatchInterventionDto,
    @CurrentUser('userId') actorId: string,
  ) {
    return this.interventions.intervene(dto, actorId);
  }

  @Get('audit')
  @ApiOperation({
    summary:
      'ADMIN persisted intervention outcomes; no recipient contact or attempt context',
  })
  @ApiResponse({ status: 200, type: [DispatchAuditDto] })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Current ADMIN role required' })
  audit() {
    return this.interventions.audit();
  }

  @Get('inbox')
  @ApiOperation({
    summary: 'ADMIN same-day urgencies and failed-visit review inbox',
  })
  @ApiResponse({ status: 200, type: UrgencyInboxDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Current ADMIN role required' })
  inbox(): Promise<UrgencyInboxDto> {
    return this.urgency.inbox();
  }

  @Get('orders/:id/proposal')
  @ApiOperation({
    summary: 'Read-only urgency insertion or new-departure proposal',
  })
  @ApiResponse({ status: 200, type: UrgencyProposalDto })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Current ADMIN role required' })
  propose(@Param('id', ParseUUIDPipe) id: string) {
    return this.urgency.propose(id);
  }
}
