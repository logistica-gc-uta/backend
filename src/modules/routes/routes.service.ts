import { RouteHistoryService } from './route-history.service.js';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteAssignmentService } from './route-assignment.service.js';
import { ConfirmDraftRouteDto } from './dto/confirm-draft-route.dto.js';
import { AssignDraftRouteDto } from './dto/assign-draft-route.dto.js';
import { AssignRouteDto } from './dto/assign-route.dto.js';

@Injectable()
export class RoutesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: RouteAssignmentService,
    private readonly history: RouteHistoryService,
  ) {}

  async assignRoute(dto: AssignRouteDto, actorId: string) {
    return this.assignment.assignLegacy(dto, actorId);
  }

  async confirmDraft(dto: ConfirmDraftRouteDto, actorId: string) {
    return this.assignment.confirmDraft(dto, actorId);
  }

  async assignDraft(id: string, dto: AssignDraftRouteDto, actorId: string) {
    return this.assignment.assignDraft(id, dto, actorId);
  }

  async findAll() {
    const routes = await this.prisma.route
      .include('driver', (d) =>
        d.include('user', (user) =>
          user.select('id', 'name', 'email', 'role', 'createdAt'),
        ),
      )
      .include('zone')
      .all();
    return this.history.project(routes, true);
  }

  async findOne(id: string) {
    const route = await this.prisma.route
      .where({ id })
      .include('driver', (d) =>
        d.include('user', (user) =>
          user.select('id', 'name', 'email', 'role', 'createdAt'),
        ),
      )
      .include('zone')
      .first();

    if (!route) {
      throw new NotFoundException(`Ruta con ID '${id}' no encontrada`);
    }
    return (await this.history.project([route], true))[0];
  }
}
