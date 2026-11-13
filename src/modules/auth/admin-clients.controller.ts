import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminClientsService } from './admin-clients.service.js';
import { Roles } from './decorators/roles.decorator.js';
import { AdminClientsPageDto } from './dto/admin-clients-response.dto.js';
import { ListAdminClientsDto } from './dto/list-admin-clients.dto.js';
import { Role } from './dto/register.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';

@ApiTags('Admin Clients')
@ApiBearerAuth('JWT-auth')
@Controller('admin/clients')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminClientsController {
  constructor(private readonly adminClientsService: AdminClientsService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Search and paginate registered CLIENT users (ADMIN only)',
    description:
      'Returns paginated registered CLIENT users (id, name, email) ordered stably by name ASC, id ASC. Optional search performs a case-insensitive partial match on name or email (minimum 2 trimmed characters). Never exposes password hashes, other roles, createdAt, or order data.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated registered CLIENT accounts',
    type: AdminClientsPageDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid search length, pagination bounds, or unknown query parameter',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid JWT',
  })
  @ApiResponse({
    status: 403,
    description: 'ADMIN role required',
  })
  async findAll(
    @Query() query: ListAdminClientsDto = new ListAdminClientsDto(),
  ): Promise<AdminClientsPageDto> {
    return this.adminClientsService.listClients(query);
  }
}
