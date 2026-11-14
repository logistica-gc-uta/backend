import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { HealthResponseDto } from './health.dto.js';

const DEFAULT_HEALTH_TIMEOUT_MS = 3000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<HealthResponseDto> {
    const pingQuery = this.prisma.client.raw.sql`SELECT 'ok'::text AS ok`
      .returnsRow({ ok: 'pg/text@1' })
      .build();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.prisma.client.transaction((tx) => tx.query(pingQuery)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Health check timed out')), timeoutMs);
        }),
      ]);
      return { status: 'ok', database: 'up' };
    } catch {
      // Never log raw driver errors: they may contain connection strings or credentials.
      this.logger.warn('Database health check failed');
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
