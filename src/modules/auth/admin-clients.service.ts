import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  AdminClientItemDto,
  AdminClientsPageDto,
} from './dto/admin-clients-response.dto.js';
import { ListAdminClientsDto } from './dto/list-admin-clients.dto.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

@Injectable()
export class AdminClientsService {
  constructor(private readonly prisma: PrismaService) {}

  private snapshot<T>(read: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.prisma.client.transaction(async (tx) => {
      await tx.execute(
        this.prisma.client.raw.sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
          .affectedCount()
          .build(),
      );
      return read(tx);
    });
  }

  async listClients(
    dto: ListAdminClientsDto = new ListAdminClientsDto(),
  ): Promise<AdminClientsPageDto> {
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? 20;

    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 1000000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 50
    ) {
      throw new BadRequestException('Invalid pagination parameters');
    }

    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BadRequestException('Invalid pagination parameters');
    }

    let pattern = '';
    if (dto.search !== undefined) {
      if (typeof dto.search !== 'string') {
        throw new BadRequestException('Search must be a string');
      }
      const trimmed = dto.search.trim();
      if (trimmed.length < 2 || trimmed.length > 100) {
        throw new BadRequestException(
          'Search must be between 2 and 100 trimmed characters',
        );
      }
      pattern = `%${escapeLike(trimmed)}%`;
    }

    const raw = this.prisma.client.raw;
    const countPlan = raw.sql`
      SELECT count(*)::int AS total
      FROM public."user" u
      WHERE u.role = 'CLIENT'
        AND (${pattern} = '' OR (u.name ILIKE ${pattern} ESCAPE '\\' OR u.email ILIKE ${pattern} ESCAPE '\\'))
    `
      .returnsRow({ total: 'pg/int4@1' })
      .build();

    const itemsPlan = raw.sql`
      SELECT u.id, u.name, u.email
      FROM public."user" u
      WHERE u.role = 'CLIENT'
        AND (${pattern} = '' OR (u.name ILIKE ${pattern} ESCAPE '\\' OR u.email ILIKE ${pattern} ESCAPE '\\'))
      ORDER BY u.name ASC, u.id ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `
      .returnsRow({
        id: 'pg/text@1',
        name: 'pg/text@1',
        email: 'pg/text@1',
      })
      .build();

    return this.snapshot(async (tx) => {
      const countRows = await tx.query(countPlan);
      const rows = await tx.query(itemsPlan);
      const total = countRows[0]?.total ?? 0;
      const items: AdminClientItemDto[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
      }));
      return {
        items,
        total,
        page,
        pageSize,
      };
    });
  }
}
