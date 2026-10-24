import { Controller, Get, UseFilters } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ShopHttpExceptionFilter } from '../shop-http.filter.js';
import { ShopSettingsPublicDto } from './dto/shop-settings.dto.js';
import { ShopSettingsService } from './shop-settings.service.js';

@ApiTags('Shop Settings')
@Controller('shop/settings')
@UseFilters(ShopHttpExceptionFilter)
export class ShopSettingsController {
  constructor(private readonly settingsService: ShopSettingsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Reglas públicas de compra: envío gratis, IVA ficticio, cantidad máxima y horario',
    description:
      'La configuración ADMIN se valida, audita y versiona en PostgreSQL.',
  })
  @ApiResponse({
    status: 200,
    description: 'OK',
    type: ShopSettingsPublicDto,
  })
  async getPublicSettings(): Promise<ShopSettingsPublicDto> {
    return this.settingsService.getPublicSettings();
  }
}
