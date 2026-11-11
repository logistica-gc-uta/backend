import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseFilters, UsePipes } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StoreCoverageHttpExceptionFilter } from './store-coverage-http.filter.js';
import {
  EvaluateCoverageDto,
  EvaluateCoverageResponseDto,
  StoreCoverageConfiguredDto,
  StoreCoverageUnconfiguredDto,
} from './dto/store-coverage.dto.js';
import { storeCoverageValidationPipe } from './store-coverage-validation.js';
import { StoreCoverageService } from './store-coverage.service.js';

@ApiTags('Store Coverage')
@Controller('store-coverage')
@UseFilters(StoreCoverageHttpExceptionFilter)
export class StoreCoverageController {
  constructor(private readonly storeCoverageService: StoreCoverageService) {}

  @Get()
  @ApiOperation({
    summary: 'Read the unique store location and general coverage',
    description:
      'Returns configured:false when ADMIN has not saved a store. Never invents a default location. Coverage is planar membership, not road reachability.',
  })
  @ApiResponse({ status: 200, description: 'Current configuration or unconfigured marker' })
  async getCoverage(): Promise<StoreCoverageConfiguredDto | StoreCoverageUnconfiguredDto> {
    return this.storeCoverageService.getCoverage();
  }

  @Post('evaluate')
  @HttpCode(HttpStatus.OK)
  @UsePipes(storeCoverageValidationPipe)
  @ApiOperation({
    summary: 'Classify a WGS84 point against the saved coverage polygon',
    description:
      'Interior and boundary points are accepted. Exterior points are rejected. Unconfigured coverage does not accept points.',
  })
  @ApiBody({ type: EvaluateCoverageDto })
  @ApiResponse({ status: 200, type: EvaluateCoverageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid coordinates' })
  @ApiResponse({ status: 409, description: 'Store and coverage are not configured' })
  async evaluate(@Body() dto: EvaluateCoverageDto): Promise<EvaluateCoverageResponseDto> {
    return this.storeCoverageService.evaluatePoint(dto);
  }
}
