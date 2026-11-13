import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { nowInstant } from '../../common/temporal.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isValidLatitude, isValidLongitude } from '../orders/order-geography.util.js';
import { shopError } from '../shop/shop-http.filter.js';
import {
  classifyPointInCoverage,
  CoverageClassification,
  coverageToGeoJson,
  parseCoveragePolygon,
} from './coverage-geometry.util.js';
import {
  EvaluateCoverageDto,
  EvaluateCoverageResponseDto,
  StoreCoverageConfiguredDto,
  StoreCoverageUnconfiguredDto,
  UpsertStoreCoverageDto,
} from './dto/store-coverage.dto.js';

const SINGLETON_KEY = 'GLOBAL';
const STORE_COVERAGE_LOCK_KEY = 41;

function isSingletonUniqueViolation(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let index = 0; index < pending.length; index += 1) {
    const candidate = pending[index];
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    const text = [record.code, record.constraint, record.constraint_name, record.message]
      .map((value) => (typeof value === 'string' ? value : ''))
      .join(' ');
    if ((record.code === '23505' || record.code === 'P2002' || /unique/i.test(text)) && /singleton/i.test(text)) {
      return true;
    }
    pending.push(record.cause, record.originalError);
  }
  return false;
}

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];

type StoreCoverageRow = {
  id: string;
  singletonKey: string;
  lat: number;
  lng: number;
  coverage: unknown;
  updatedById: string | null;
  updatedAt: Temporal.Instant;
};

function toIsoTimestamp(val: unknown): string {
  if (val === null || val === undefined) {
    throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Missing timestamp');
  }
  if (typeof val === 'string') {
    return val;
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'object' && val !== null && 'toString' in val) {
    return Temporal.Instant.from(val as Temporal.Instant).toString();
  }
  throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Unreadable timestamp');
}

@Injectable()
export class StoreCoverageService {
  constructor(private readonly prisma: PrismaService) {}

  async getCoverage(): Promise<StoreCoverageConfiguredDto | StoreCoverageUnconfiguredDto> {
    const row = await this.loadSingleton();
    if (!row) {
      return { configured: false };
    }
    return this.toConfiguredDto(row);
  }

  async upsertCoverage(actorId: string, dto: UpsertStoreCoverageDto): Promise<StoreCoverageConfiguredDto> {
    const location = this.requireLocation(dto.location?.lat, dto.location?.lng);
    let coverageJson: ReturnType<typeof coverageToGeoJson>;
    try {
      coverageJson = coverageToGeoJson(parseCoveragePolygon(dto.coverage));
    } catch (error) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'STORE_COVERAGE_INVALID',
        error instanceof Error ? error.message : 'Coverage polygon is invalid',
      );
    }

    try {
      return await this.persistCoverage(actorId, location, coverageJson);
    } catch (error) {
      if (!isSingletonUniqueViolation(error)) {
        throw error;
      }
      return this.persistCoverage(actorId, location, coverageJson);
    }
  }

  private async persistCoverage(
    actorId: string,
    location: { lat: number; lng: number },
    coverageJson: ReturnType<typeof coverageToGeoJson>,
  ): Promise<StoreCoverageConfiguredDto> {
    return this.prisma.client.transaction(async (tx: Transaction) => {
      await tx.execute(
        this.prisma.client.raw.sql`SELECT pg_advisory_xact_lock(${STORE_COVERAGE_LOCK_KEY}, 1)`
          .affectedCount()
          .build(),
      );
      const lockPlan = this.prisma.client.raw.sql`
        SELECT id
        FROM public."storeCoverage"
        WHERE "singletonKey" = ${SINGLETON_KEY}
        FOR UPDATE
      `
        .returnsRow({ id: 'pg/text@1' })
        .build();
      const locked = (await tx.query(lockPlan)) as { id: string }[];
      const now = nowInstant();

      if (locked[0]?.id) {
        const updated = await tx.orm.public.StoreCoverage.where({ id: locked[0].id }).update({
          lat: location.lat,
          lng: location.lng,
          coverage: coverageJson,
          updatedById: actorId,
          updatedAt: now,
        });
        if (!updated) {
          throw shopError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Store coverage update failed');
        }
        return this.toConfiguredDto(updated as StoreCoverageRow);
      }

      const created = await tx.orm.public.StoreCoverage.create({
        id: randomUUID(),
        singletonKey: SINGLETON_KEY,
        lat: location.lat,
        lng: location.lng,
        coverage: coverageJson,
        updatedById: actorId,
        createdAt: now,
        updatedAt: now,
      });
      return this.toConfiguredDto(created as StoreCoverageRow);
    });
  }

  async evaluatePoint(
    dto: EvaluateCoverageDto,
    tx?: Transaction,
  ): Promise<EvaluateCoverageResponseDto> {
    const location = this.requireLocation(dto.lat, dto.lng);
    const row = await this.loadSingleton(tx);
    if (!row) {
      throw shopError(
        HttpStatus.CONFLICT,
        'STORE_NOT_CONFIGURED',
        'Store location and coverage have not been configured',
      );
    }

    const position = classifyPointInCoverage(location, row.coverage);
    return {
      accepted: position !== CoverageClassification.EXTERIOR,
      position,
    };
  }

  private async loadSingleton(tx?: Transaction): Promise<StoreCoverageRow | null> {
    const client = tx ?? this.prisma.client;
    const row = (await client.orm.public.StoreCoverage.where({
      singletonKey: SINGLETON_KEY,
    }).first()) as StoreCoverageRow | undefined;
    return row ?? null;
  }

  private requireLocation(lat: unknown, lng: unknown): { lat: number; lng: number } {
    if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'STORE_LOCATION_INVALID',
        'Store or point coordinates must be finite WGS84 latitude and longitude',
      );
    }
    return { lat, lng };
  }

  private toConfiguredDto(row: StoreCoverageRow): StoreCoverageConfiguredDto {
    let coverage: StoreCoverageConfiguredDto['coverage'];
    try {
      coverage = coverageToGeoJson(parseCoveragePolygon(row.coverage, { checkTopology: false }));
    } catch {
      throw shopError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        'Persisted coverage is not a valid polygon',
      );
    }
    return {
      configured: true,
      location: { lat: row.lat, lng: row.lng },
      coverage,
      updatedAt: toIsoTimestamp(row.updatedAt),
      updatedById: row.updatedById,
    };
  }
}
