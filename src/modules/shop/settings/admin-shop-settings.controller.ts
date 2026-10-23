import {
  Body,
  Controller,
  Get,
  Patch,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { Role } from '../../auth/dto/register.dto.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { ShopHttpExceptionFilter } from '../shop-http.filter.js';
import {
  ShopSettingsAdminDto,
  ShopSettingsPatchDto,
} from './dto/shop-settings.dto.js';
import { ShopSettingsService } from './shop-settings.service.js';

@ApiTags('Shop Settings')
@ApiBearerAuth()
@Controller('admin/shop-settings')
@UseFilters(ShopHttpExceptionFilter)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminShopSettingsController {
  constructor(private readonly settingsService: ShopSettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Consultar configuración de tienda como ADMIN',
    description:
      'La configuración ADMIN se valida, audita y versiona en PostgreSQL. Incluye updatedById y createdAt.',
  })
  @ApiResponse({
    status: 200,
    description: 'OK',
    type: ShopSettingsAdminDto,
  })
  async getAdminSettings(): Promise<ShopSettingsAdminDto> {
    return this.settingsService.getAdminSettings();
  }

  @Patch()
  @ApiOperation({
    summary:
      'Actualizar tasa IVA simulada, límite SKU y horario mediante control optimista de versión',
    description:
      'La configuración ADMIN se valida, audita y versiona en PostgreSQL. La tasa de IVA no es fiscal. 00:00<startTime<endTime<=23:59; horarios iniciales 07:00-17:00 inclusive America/Guayaquil. Sólo ADMIN; shipping no editable.',
  })
  @ApiBody({ type: ShopSettingsPatchDto })
  @ApiResponse({
    status: 200,
    description: 'OK',
    type: ShopSettingsAdminDto,
  })
  async patchAdminSettings(
    @CurrentUser('userId') actorId: string,
    @Body() patch: ShopSettingsPatchDto,
  ): Promise<ShopSettingsAdminDto> {
    return this.settingsService.patchAdminSettings(actorId, patch);
  }
}
