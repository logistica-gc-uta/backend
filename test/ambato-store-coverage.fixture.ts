import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../src/database/prisma.service.js';

/** Closed GeoJSON ring covering the Ambato shop-quote fixture point [-78.6188, -1.2425]. */
export const AMBATO_COVERAGE_POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-78.63, -1.27],
      [-78.6, -1.27],
      [-78.6, -1.23],
      [-78.63, -1.23],
      [-78.63, -1.27],
    ],
  ],
};

export async function seedAmbatoStoreCoverage(
  db: Pick<PrismaService, 'storeCoverage'>,
): Promise<void> {
  const now = Temporal.Now.instant();
  await db.storeCoverage.create({
    id: randomUUID(),
    singletonKey: 'GLOBAL',
    lat: -1.24908,
    lng: -78.61675,
    coverage: AMBATO_COVERAGE_POLYGON,
    updatedById: null,
    createdAt: now,
    updatedAt: now,
  });
}
