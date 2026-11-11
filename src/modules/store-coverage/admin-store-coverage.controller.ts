import { Body, Controller, HttpCode, HttpStatus, Put, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { StoreCoverageHttpExceptionFilter } from './store-coverage-http.filter.js';
import { StoreCoverageConfiguredDto, UpsertStoreCoverageDto } from './dto/store-coverage.dto.js';
import { storeCoverageValidationPipe } from './store-coverage-validation.js';
import { StoreCoverageService } from './store-coverage.service.js';

@ApiTags('Store Coverage')
@ApiBearerAuth('JWT-auth')
@Controller('admin/store-coverage')
@UseFilters(StoreCoverageHttpExceptionFilter)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@UsePipes(storeCoverageValidationPipe)
export class AdminStoreCoverageController {
  constructor(private readonly storeCoverageService: StoreCoverageService) {}

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace the unique store location and general coverage (ADMIN)',
    description:
      'Validates coordinates and a simple GeoJSON Polygon on the server. Invalid payloads leave persisted configuration unchanged. Does not mutate existing orders.',
  })
  @ApiBody({ type: UpsertStoreCoverageDto })
  @ApiResponse({ status: 200, type: StoreCoverageConfiguredDto })
  @ApiResponse({ status: 400, description: 'Invalid location or coverage' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'ADMIN role required' })
  async upsert(
    @CurrentUser('userId') actorId: string,
    @Body() dto: UpsertStoreCoverageDto,
  ): Promise<StoreCoverageConfiguredDto> {
    return this.storeCoverageService.upsertCoverage(actorId, dto);
  }
}
