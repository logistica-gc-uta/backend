import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AdminClientsController } from './admin-clients.controller.js';
import { AdminClientsService } from './admin-clients.service.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import { ListAdminClientsDto } from './dto/list-admin-clients.dto.js';
import { Role } from './dto/register.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';

interface SqlPlan {
  text: string;
  values: unknown[];
}

function createFixture(
  rows: Array<Record<string, unknown>> = [
    {
      id: 'client-1',
      name: 'Ana Cliente',
      email: 'client1@delivery.com',
    },
  ],
  total = rows.length,
) {
  const plans: SqlPlan[] = [];
  const executed: SqlPlan[] = [];

  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const plan: SqlPlan & {
      returnsRow: () => unknown;
      affectedCount: () => unknown;
      build: () => SqlPlan;
    } = {
      text: strings.join('?'),
      values,
      returnsRow() {
        return this;
      },
      affectedCount() {
        return this;
      },
      build() {
        return { text: this.text, values: this.values };
      },
    };
    return plan;
  };

  const tx = {
    execute: jest.fn(async (plan: SqlPlan) => {
      executed.push(plan);
      return 0;
    }),
    query: jest.fn(async (plan: SqlPlan) => {
      plans.push(plan);
      if (plan.text.includes('count(*)::int AS total')) {
        return [{ total }];
      }
      return rows;
    }),
  };

  const client = {
    raw: { sql },
    transaction: jest.fn(async <T>(work: (arg: typeof tx) => Promise<T>) =>
      work(tx),
    ),
  };

  const prisma = { client };
  const service = new AdminClientsService(prisma as any);

  return { service, prisma, client, tx, plans, executed };
}

describe('AdminClientsService', () => {
  it('lists registered CLIENT accounts in a REPEATABLE READ, READ ONLY snapshot with stable ordering and strict allowlist projection', async () => {
    const f = createFixture(
      [
        {
          id: 'client-1',
          name: 'Ana Cliente',
          email: 'client1@delivery.com',
          password: 'bcrypt-secret-hash',
          role: 'CLIENT',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          orders: [{ id: 'order-1' }],
        },
      ],
      1,
    );

    const result = await f.service.listClients(new ListAdminClientsDto());

    expect(result).toEqual({
      items: [
        {
          id: 'client-1',
          name: 'Ana Cliente',
          email: 'client1@delivery.com',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(Object.keys(result.items[0]).sort()).toEqual(['email', 'id', 'name']);
    expect(result.items[0]).not.toHaveProperty('password');
    expect(result.items[0]).not.toHaveProperty('role');
    expect(result.items[0]).not.toHaveProperty('createdAt');
    expect(result.items[0]).not.toHaveProperty('orders');

    expect(f.client.transaction).toHaveBeenCalledTimes(1);
    expect(f.executed).toHaveLength(1);
    expect(f.executed[0].text).toContain(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
    expect(f.plans).toHaveLength(2);
    for (const plan of f.plans) {
      expect(plan.text).toContain("u.role = 'CLIENT'");
      expect(plan.text).not.toContain('password');
    }
    expect(f.plans[1].text).toContain('ORDER BY u.name ASC, u.id ASC');
    expect(f.plans[1].values).toContain(20);
    expect(f.plans[1].values).toContain(0);
  });

  it('trims search and binds case-insensitive partial match on name or email with ESCAPE', async () => {
    const f = createFixture();
    const dto = Object.assign(new ListAdminClientsDto(), {
      page: 2,
      pageSize: 15,
      search: '  ana  ',
    });

    const result = await f.service.listClients(dto);

    expect(result).toMatchObject({
      page: 2,
      pageSize: 15,
      total: 1,
    });
    expect(f.plans[0].text).toContain("u.name ILIKE ? ESCAPE '\\'");
    expect(f.plans[0].text).toContain("u.email ILIKE ? ESCAPE '\\'");
    expect(f.plans[0].values).toContain('%ana%');
    expect(f.plans[1].values).toContain('%ana%');
    expect(f.plans[1].values).toContain(15);
    expect(f.plans[1].values).toContain(15);
  });

  it('escapes SQL LIKE wildcards (%, _, \\) in search terms', async () => {
    const f = createFixture([], 0);
    const dto = Object.assign(new ListAdminClientsDto(), {
      search: '50%_\\',
    });

    const result = await f.service.listClients(dto);

    expect(result).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    expect(f.plans[0].values).toContain('%50\\%\\_\\\\%');
    expect(f.plans[1].values).toContain('%50\\%\\_\\\\%');
  });

  it('preserves total count on an out-of-range page within the same snapshot', async () => {
    const f = createFixture([], 3);
    const dto = Object.assign(new ListAdminClientsDto(), {
      page: 4,
      pageSize: 10,
    });

    const result = await f.service.listClients(dto);

    expect(result).toEqual({
      items: [],
      total: 3,
      page: 4,
      pageSize: 10,
    });
    expect(f.client.transaction).toHaveBeenCalledTimes(1);
    expect(f.plans).toHaveLength(2);
  });

  it.each([
    ['search shorter than 2 chars', { page: 1, pageSize: 20, search: 'a' }],
    ['whitespace-only search', { page: 1, pageSize: 20, search: '   ' }],
    ['search longer than 100 chars', { page: 1, pageSize: 20, search: 'x'.repeat(101) }],
    ['page < 1', { page: 0, pageSize: 20 }],
    ['page > 1000000', { page: 1000001, pageSize: 20 }],
    ['pageSize < 1', { page: 1, pageSize: 0 }],
    ['pageSize > 50', { page: 1, pageSize: 51 }],
  ])('rejects invalid %s before opening a database transaction', async (_label, input) => {
    const f = createFixture();
    await expect(
      f.service.listClients(Object.assign(new ListAdminClientsDto(), input)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.client.transaction).not.toHaveBeenCalled();
  });
});

describe('AdminClientsController', () => {
  it('mounts at admin/clients and enforces JwtAuthGuard + RolesGuard with Role.ADMIN', async () => {
    const listClients = jest.fn().mockResolvedValue({
      items: [{ id: 'c1', name: 'Ana Cliente', email: 'client1@delivery.com' }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    const controller = new AdminClientsController({ listClients } as any);

    expect(Reflect.getMetadata(PATH_METADATA, AdminClientsController)).toBe(
      'admin/clients',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminClientsController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    const findAllHandler = Object.getOwnPropertyDescriptor(
      AdminClientsController.prototype,
      'findAll',
    )?.value;
    expect(Reflect.getMetadata(ROLES_KEY, findAllHandler)).toEqual([
      Role.ADMIN,
    ]);

    const query = Object.assign(new ListAdminClientsDto(), {
      page: 1,
      pageSize: 20,
      search: 'ana',
    });
    await expect(controller.findAll(query)).resolves.toEqual({
      items: [{ id: 'c1', name: 'Ana Cliente', email: 'client1@delivery.com' }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(listClients).toHaveBeenCalledWith(query);
  });
});

describe('ListAdminClientsDto with global ValidationPipe rules', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });

  const validateQuery = (query: Record<string, unknown>) =>
    pipe.transform(query, {
      type: 'query',
      metatype: ListAdminClientsDto,
    });

  it('applies default pagination when query parameters are omitted', async () => {
    await expect(validateQuery({})).resolves.toEqual({
      page: 1,
      pageSize: 20,
    });
  });

  it('transforms numeric query strings and trims search', async () => {
    await expect(
      validateQuery({ page: '2', pageSize: '50', search: '  ana@delivery.com  ' }),
    ).resolves.toEqual({
      page: 2,
      pageSize: 50,
      search: 'ana@delivery.com',
    });
  });

  it.each([
    ['1-char search', { search: 'a' }],
    ['1-char padded search', { search: '  a  ' }],
    ['empty search', { search: '' }],
    ['blank search', { search: '   ' }],
    ['101-char search', { search: 'a'.repeat(101) }],
    ['pageSize > 50', { pageSize: '51' }],
    ['pageSize = 0', { pageSize: '0' }],
    ['negative pageSize', { pageSize: '-5' }],
    ['decimal pageSize', { pageSize: '10.5' }],
    ['page = 0', { page: '0' }],
    ['negative page', { page: '-1' }],
    ['decimal page', { page: '1.5' }],
    ['page > 1000000', { page: '1000001' }],
    ['unknown parameter', { unknown: 'value' }],
    ['phone parameter', { phone: '0991234567' }],
    ['role parameter', { role: 'ADMIN' }],
  ])('rejects %s with 400 BadRequestException', async (_label, query) => {
    await expect(validateQuery(query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
