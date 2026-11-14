import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../database/prisma.service.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthController & HealthService', () => {
  const buildModule = async (transactionImpl: jest.Mock) => {
    const build = jest.fn().mockReturnValue({ sqlText: "SELECT 'ok'::text AS ok" });
    const returnsRow = jest.fn().mockReturnValue({ build });
    const sql = jest.fn().mockReturnValue({ returnsRow });

    const prismaMock = {
      client: {
        raw: { sql },
        transaction: transactionImpl,
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    return { moduleRef, sql, returnsRow, build };
  };

  it('returns HTTP 200 { status: "ok", database: "up" } when PostgreSQL responds', async () => {
    const transaction = jest.fn(async (cb: (tx: { query: jest.Mock }) => Promise<unknown>) =>
      cb({ query: jest.fn().mockResolvedValue([{ ok: 'ok' }]) }),
    );
    const { moduleRef, sql, returnsRow, build } = await buildModule(transaction);
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    try {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      expect(res.body).toEqual({ status: 'ok', database: 'up' });
      expect(sql).toHaveBeenCalledTimes(1);
      expect(returnsRow).toHaveBeenCalledWith({ ok: 'pg/text@1' });
      expect(build).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns HTTP 503 { status: "error", database: "down" } without leaking DB error details or secrets', async () => {
    const secretUrl = 'postgresql://prod_user:super_secret_pw@db.internal:5432/prod_db';
    const transaction = jest.fn().mockRejectedValue(new Error(`ECONNREFUSED ${secretUrl}`));
    const { moduleRef } = await buildModule(transaction);
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    try {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(503);
      expect(res.body).toEqual({ status: 'error', database: 'down' });
      const rawBody = JSON.stringify(res.body);
      expect(rawBody).not.toContain('super_secret_pw');
      expect(rawBody).not.toContain('ECONNREFUSED');
      expect(rawBody).not.toContain('postgresql://');
    } finally {
      await app.close();
    }
  });

  it('throws ServiceUnavailableException when the database query exceeds the timeout', async () => {
    jest.useFakeTimers();
    try {
      const neverResolves = new Promise(() => undefined);
      const transaction = jest.fn().mockReturnValue(neverResolves);
      const { moduleRef } = await buildModule(transaction);
      const service = moduleRef.get(HealthService);

      const checkPromise = service.check(25);
      const assertion = expect(checkPromise).rejects.toBeInstanceOf(ServiceUnavailableException);
      await jest.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});
