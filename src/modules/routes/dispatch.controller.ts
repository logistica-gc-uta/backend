import {
  Controller,
  Get,
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
  constructor(private readonly urgency: RouteUrgencyService) {}

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
