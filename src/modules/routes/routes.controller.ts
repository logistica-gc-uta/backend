import { AdminRouteHistoryResponseDto } from './dto/route-history-response.dto.js';
import { LegacyRouteReconciliationService } from './legacy-route-reconciliation.service.js';
import { RegularizeLegacyRouteDto } from './dto/regularize-legacy-route.dto.js';
import { RouteReconciliationResponseDto } from './dto/route-reconciliation-response.dto.js';
import { RouteReturnService } from './route-return.service.js';
import { RouteReturnResponseDto } from './dto/route-return-response.dto.js';
import { RouteProgressService } from './route-progress.service.js';
import { RecordFailedVisitDto } from './dto/record-failed-visit.dto.js';
import {
  VisitAttemptResponseDto,
  RouteCompletionResponseDto,
} from './dto/route-progress-response.dto.js';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { AssignRouteDto } from './dto/assign-route.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RouteExecutionService } from './route-execution.service.js';
import { RouteStartResponseDto } from './dto/route-start-response.dto.js';
import { ConfirmDraftRouteDto } from './dto/confirm-draft-route.dto.js';
import { AssignDraftRouteDto } from './dto/assign-draft-route.dto.js';
import { RouteAssignmentResponseDto } from './dto/route-assignment-response.dto.js';
import { RoutesService } from './routes.service.js';

@ApiTags('Routes')
@ApiBearerAuth('JWT-auth')
@Controller('routes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RoutesController {
  constructor(
    private readonly routesService: RoutesService,
    private readonly execution: RouteExecutionService,
    private readonly progress: RouteProgressService,
    private readonly depotReturn: RouteReturnService,
    private readonly reconciliation: LegacyRouteReconciliationService,
  ) {}

  @Post(':id/reconcile')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Audit administrative release of an unverified legacy hold, not physical return',
  })
  @ApiResponse({ status: 200, type: RouteReconciliationResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid UUID, reason/evidence or extra request fields',
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Current ADMIN role required' })
  @ApiResponse({ status: 404, description: 'Route not found' })
  @ApiResponse({
    status: 409,
    description: 'Verified route or conflicting reconciliation audit',
  })
  async reconcile(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') actorId: string,
    @Body() dto: RegularizeLegacyRouteDto,
  ): Promise<RouteReconciliationResponseDto> {
    return this.reconciliation.reconcile(id, actorId, dto);
  }

  @Post(':id/stops/:stopId/failure')
  @Roles(Role.DRIVER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a failed visit with persisted idempotency evidence',
  })
  @ApiResponse({ status: 200, type: VisitAttemptResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Conflicting replay or unresolved operational state',
  })
  async fail(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @CurrentUser('userId') actorId: string,
    @Body() dto: RecordFailedVisitDto,
  ) {
    return this.progress.fail(id, stopId, actorId, dto);
  }

  @Post(':id/complete')
  @Roles(Role.DRIVER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete resolved visits without releasing the driver',
  })
  @ApiResponse({ status: 200, type: RouteCompletionResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Unresolved visits or conflicting completion evidence',
  })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') actorId: string,
    @Body() body: unknown,
    @Headers('content-type') contentType: string | undefined,
  ) {
    if (
      !contentType?.toLowerCase().startsWith('application/json') ||
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length
    )
      throw new BadRequestException('Completion requires an empty JSON object');
    return this.progress.complete(id, actorId);
  }

  @Post(':id/return')
  @Roles(Role.DRIVER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm physical depot return of an owned completed route',
  })
  @ApiResponse({ status: 200, type: RouteReturnResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid UUID or body' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'DRIVER ownership required' })
  @ApiResponse({ status: 404, description: 'Route not found' })
  @ApiResponse({
    status: 409,
    description: 'Completion audit or reservation conflict',
  })
  async returnToDepot(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') actorId: string,
    @Body() body: unknown,
    @Headers('content-type') contentType?: string,
  ): Promise<RouteReturnResponseDto> {
    if (
      (contentType && contentType.split(';')[0] !== 'application/json') ||
      (body !== undefined &&
        (body === null ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length !== 0))
    )
      throw new BadRequestException('Return accepts only an empty JSON body');
    return this.depotReturn.returnToDepot(id, actorId);
  }

  @Post(':id/start')
  @Roles(Role.DRIVER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Start an owned assigned route; replay preserves the original start',
  })
  @ApiResponse({ status: 200, type: RouteStartResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid UUID or nonempty body' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({
    status: 403,
    description: 'DRIVER role and ownership required',
  })
  @ApiResponse({ status: 404, description: 'Route not found' })
  @ApiResponse({
    status: 409,
    description: 'Invalid lifecycle, reservation or stop evidence',
  })
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Body() body: unknown,
    @Headers('content-type') contentType?: string,
  ): Promise<RouteStartResponseDto> {
    if (contentType && contentType.split(';')[0] !== 'application/json')
      throw new BadRequestException('Start accepts only an empty JSON body');
    if (
      body !== undefined &&
      (body === null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0)
    ) {
      throw new BadRequestException('Start accepts no request fields');
    }
    return this.execution.start(id, userId);
  }

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Confirm an explicit dated proposal as DRAFT; no planning algorithm',
  })
  @ApiResponse({ status: 201, type: RouteAssignmentResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Order eligibility, active claim or exact timestamp conflict',
  })
  async confirmDraft(
    @Body() dto: ConfirmDraftRouteDto,
    @CurrentUser('userId') actorId: string,
  ): Promise<RouteAssignmentResponseDto> {
    return this.routesService.confirmDraft(dto, actorId);
  }

  @Post(':id/assign')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign an existing DRAFT to an effectively available driver',
  })
  @ApiResponse({ status: 200, type: RouteAssignmentResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Driver hold, lifecycle, claim or eligibility conflict',
  })
  async assignDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDraftRouteDto,
    @CurrentUser('userId') actorId: string,
  ): Promise<RouteAssignmentResponseDto> {
    return this.routesService.assignDraft(id, dto, actorId);
  }

  @Post('assign')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Atomically confirm and assign using the orders exact common scheduled timestamp',
  })
  @ApiResponse({ status: 201, type: RouteAssignmentResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid request or maximum four distinct orders exceeded',
  })
  @ApiResponse({ status: 404, description: 'Driver, zone or order not found' })
  @ApiResponse({
    status: 409,
    description:
      'Eligibility, date, claim, reservation or driver hold conflict',
  })
  @HttpCode(HttpStatus.CREATED)
  async assign(
    @Body() dto: AssignRouteDto,
    @CurrentUser('userId') actorId: string,
  ): Promise<RouteAssignmentResponseDto> {
    return this.routesService.assignRoute(dto, actorId);
  }

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Listar todas las rutas creadas con chofer y órdenes (Solo ADMIN)',
  })
  @ApiResponse({
    status: 200,
    type: [AdminRouteHistoryResponseDto],
    description:
      'Routes with stable visit history and current commercial attributes',
  })
  async findAll() {
    return this.routesService.findAll();
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Consultar detalle de una ruta por ID (Solo ADMIN)',
  })
  @ApiResponse({
    status: 200,
    type: AdminRouteHistoryResponseDto,
    description:
      'Route with stable visit history and current commercial attributes',
  })
  @ApiResponse({ status: 404, description: 'Ruta no encontrada' })
  async findOne(@Param('id') id: string) {
    return this.routesService.findOne(id);
  }
}
