import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { nowInstant } from '../../../common/temporal.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { shopError } from '../shop-http.filter.js';
import {
  ShopSettingsAdminDto,
  ShopSettingsPatchDto,
  ShopSettingsPublicDto,
} from './dto/shop-settings.dto.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];

export function toIsoTimestamp(val: unknown): string {
  if (val === null || val === undefined) {
    throw new Error('Settings timestamp is absent (null or undefined)');
  }
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) {
      throw new Error('Invalid Date timestamp stored in settings');
    }
    return val.toISOString();
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length === 0) {
      throw new Error('Settings timestamp is empty string');
    }
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid string timestamp stored in settings: ${val}`);
    }
    return d.toISOString();
  }
  if (typeof val === 'object' && typeof (val as { toString?: () => string }).toString === 'function') {
    const str = (val as { toString: () => string }).toString();
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid Temporal timestamp stored in settings: ${str}`);
    }
    return d.toISOString();
  }
  throw new Error('Settings timestamp is absent or unparseable');
}

interface RawSettingsRow {
  id: string;
  singletonKey: string;
  version: number;
  currency: string;
  shippingStatus: string;
  shippingAmountCents: number;
  shippingIncludedInPrices: boolean;
  taxMode: string;
  taxEnabled: boolean;
  taxRateBps: number;
  maxUnitsPerSkuPerOrder: number;
  deliveryTimeZone: string;
  deliveryStartTime: string;
  deliveryEndTime: string;
  deliveryBoundariesInclusive: boolean;
  updatedById: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

@Injectable()
export class ShopSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private mapToPublicDto(row: RawSettingsRow): ShopSettingsPublicDto {
    const updatedAtIso = toIsoTimestamp(row.updatedAt);

    return {
      version: row.version,
      currency: 'USD',
      shipping: {
        status: 'FREE_INCLUDED',
        amountCents: 0,
        includedInPrices: true,
      },
      tax: {
        mode: 'SIMULATED',
        enabled: row.taxEnabled,
        rateBps: row.taxRateBps,
        ratePercent: row.taxRateBps / 100,
      },
      limits: {
        maxUnitsPerSkuPerOrder: row.maxUnitsPerSkuPerOrder,
      },
      deliverySchedule: {
        timeZone: 'America/Guayaquil',
        startTime: row.deliveryStartTime,
        endTime: row.deliveryEndTime,
        boundariesInclusive: true,
      },
      updatedAt: updatedAtIso,
    };
  }

  private mapToAdminDto(row: RawSettingsRow): ShopSettingsAdminDto {
    const publicDto = this.mapToPublicDto(row);
    const createdAtIso = toIsoTimestamp(row.createdAt);

    return {
      version: publicDto.version,
      currency: publicDto.currency,
      shipping: publicDto.shipping,
      tax: publicDto.tax,
      limits: publicDto.limits,
      deliverySchedule: publicDto.deliverySchedule,
      updatedAt: publicDto.updatedAt,
      updatedById: row.updatedById ?? null,
      createdAt: createdAtIso,
    };
  }

  async getPublicSettings(): Promise<ShopSettingsPublicDto> {
    const row = await this.loadSingletonRow();
    return this.mapToPublicDto(row);
  }

  async getAdminSettings(): Promise<ShopSettingsAdminDto> {
    const row = await this.loadSingletonRow();
    return this.mapToAdminDto(row);
  }

  private async loadSingletonRow(): Promise<RawSettingsRow> {
    const row = (await this.prisma.client.orm.public.ShopBusinessSettings.where({
      singletonKey: 'GLOBAL',
    }).first()) as RawSettingsRow | undefined;

    if (!row) {
      throw shopError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'SETTINGS_NOT_CONFIGURED',
        'Shop business settings not initialized in database',
      );
    }
    return row;
  }

  async patchAdminSettings(
    actorId: string,
    patch: ShopSettingsPatchDto,
  ): Promise<ShopSettingsAdminDto> {
    this.validatePatchInput(patch);

    return this.prisma.client.transaction(async (tx: Transaction) => {
      // 1. Pinned connection query with exclusive FOR UPDATE lock
      const lockPlan = this.prisma.client.raw.sql`
        SELECT id
        FROM public."shopBusinessSettings"
        WHERE "singletonKey" = 'GLOBAL'
        FOR UPDATE
      `
        .returnsRow({ id: 'pg/text@1' })
        .build();

      const lockedRows = (await tx.query(lockPlan)) as { id: string }[];
      if (!lockedRows.length || !lockedRows[0]) {
        throw shopError(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'SETTINGS_NOT_CONFIGURED',
          'Shop business settings not initialized in database',
        );
      }
      const lockedId = lockedRows[0].id;

      // Read current state under lock on transaction
      const current = (await tx.orm.public.ShopBusinessSettings.where({
        id: lockedId,
      }).first()) as RawSettingsRow | undefined;

      if (!current) {
        throw shopError(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'SETTINGS_NOT_CONFIGURED',
          'Shop business settings not initialized in database',
        );
      }

      // 2. Optimistic CAS check
      if (current.version !== patch.expectedVersion) {
        throw shopError(
          HttpStatus.CONFLICT,
          'SETTINGS_VERSION_CONFLICT',
          `Settings version conflict: current version is ${current.version}, expected ${patch.expectedVersion}`,
          { currentVersion: current.version, expectedVersion: patch.expectedVersion },
        );
      }

      // 3. Merged schedule validation (00:00 <= startTime < endTime <= 23:59)
      const mergedStartTime =
        patch.deliverySchedule?.startTime ?? current.deliveryStartTime;
      const mergedEndTime =
        patch.deliverySchedule?.endTime ?? current.deliveryEndTime;

      if (mergedStartTime >= mergedEndTime) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          `Delivery schedule startTime (${mergedStartTime}) must be strictly earlier than endTime (${mergedEndTime})`,
          { startTime: mergedStartTime, endTime: mergedEndTime },
        );
      }

      // 4. Compute changes and detect no-op
      const changedFields: Record<string, any> = {};
      let hasChange = false;

      const newTaxEnabled =
        patch.tax?.enabled !== undefined ? patch.tax.enabled : current.taxEnabled;
      const newTaxRateBps =
        patch.tax?.rateBps !== undefined ? patch.tax.rateBps : current.taxRateBps;

      if (patch.tax) {
        const taxChanges: Record<string, unknown> = {};
        if (patch.tax.enabled !== undefined && patch.tax.enabled !== current.taxEnabled) {
          taxChanges['enabled'] = patch.tax.enabled;
          hasChange = true;
        }
        if (patch.tax.rateBps !== undefined && patch.tax.rateBps !== current.taxRateBps) {
          taxChanges['rateBps'] = patch.tax.rateBps;
          taxChanges['ratePercent'] = patch.tax.rateBps / 100;
          hasChange = true;
        }
        if (Object.keys(taxChanges).length > 0) {
          changedFields['tax'] = taxChanges;
        }
      }

      const newMaxUnits =
        patch.limits?.maxUnitsPerSkuPerOrder !== undefined
          ? patch.limits.maxUnitsPerSkuPerOrder
          : current.maxUnitsPerSkuPerOrder;

      if (
        patch.limits?.maxUnitsPerSkuPerOrder !== undefined &&
        patch.limits.maxUnitsPerSkuPerOrder !== current.maxUnitsPerSkuPerOrder
      ) {
        changedFields['limits'] = {
          maxUnitsPerSkuPerOrder: patch.limits.maxUnitsPerSkuPerOrder,
        };
        hasChange = true;
      }

      if (patch.deliverySchedule) {
        const scheduleChanges: Record<string, unknown> = {};
        if (
          patch.deliverySchedule.startTime !== undefined &&
          patch.deliverySchedule.startTime !== current.deliveryStartTime
        ) {
          scheduleChanges['startTime'] = patch.deliverySchedule.startTime;
          hasChange = true;
        }
        if (
          patch.deliverySchedule.endTime !== undefined &&
          patch.deliverySchedule.endTime !== current.deliveryEndTime
        ) {
          scheduleChanges['endTime'] = patch.deliverySchedule.endTime;
          hasChange = true;
        }
        if (Object.keys(scheduleChanges).length > 0) {
          changedFields['deliverySchedule'] = scheduleChanges;
        }
      }

      if (!hasChange) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'No modifications detected in patch payload',
        );
      }

      // 5. Apply atomic version increment and persisted update
      const newVersion = current.version + 1;
      const now = nowInstant();
      const nowIso = toIsoTimestamp(now);

      await tx.orm.public.ShopBusinessSettings.where({ id: current.id }).update({
        version: newVersion,
        taxEnabled: newTaxEnabled,
        taxRateBps: newTaxRateBps,
        maxUnitsPerSkuPerOrder: newMaxUnits,
        deliveryStartTime: mergedStartTime,
        deliveryEndTime: mergedEndTime,
        updatedById: actorId,
        updatedAt: now,
      });

      // 6. Persist audit in SAME transaction
      await tx.orm.public.ShopSettingsAudit.create({
        id: randomUUID(),
        settingsId: current.id,
        actorId,
        expectedVersion: current.version,
        newVersion,
        changedFields,
        snapshot: {
          before: {
            version: current.version,
            taxEnabled: current.taxEnabled,
            taxRateBps: current.taxRateBps,
            maxUnitsPerSkuPerOrder: current.maxUnitsPerSkuPerOrder,
            deliveryStartTime: current.deliveryStartTime,
            deliveryEndTime: current.deliveryEndTime,
            updatedById: current.updatedById,
            updatedAt: toIsoTimestamp(current.updatedAt),
          },
          after: {
            version: newVersion,
            taxEnabled: newTaxEnabled,
            taxRateBps: newTaxRateBps,
            maxUnitsPerSkuPerOrder: newMaxUnits,
            deliveryStartTime: mergedStartTime,
            deliveryEndTime: mergedEndTime,
            updatedById: actorId,
            updatedAt: nowIso,
          },
        },
        recordedAt: now,
      });

      const updatedRow: RawSettingsRow = {
        ...current,
        version: newVersion,
        taxEnabled: newTaxEnabled,
        taxRateBps: newTaxRateBps,
        maxUnitsPerSkuPerOrder: newMaxUnits,
        deliveryStartTime: mergedStartTime,
        deliveryEndTime: mergedEndTime,
        updatedById: actorId,
        updatedAt: now,
      };

      return this.mapToAdminDto(updatedRow);
    });
  }

  private validatePatchInput(patch: ShopSettingsPatchDto): void {
    if (
      patch.expectedVersion === undefined ||
      patch.expectedVersion === null ||
      !Number.isInteger(patch.expectedVersion) ||
      patch.expectedVersion < 1
    ) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'expectedVersion must be a positive integer >= 1',
      );
    }

    if (patch.tax !== undefined && (patch.tax === null || typeof patch.tax !== 'object')) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'tax must be an object if provided, not null',
      );
    }

    if (patch.limits !== undefined && (patch.limits === null || typeof patch.limits !== 'object')) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'limits must be an object if provided, not null',
      );
    }

    if (
      patch.deliverySchedule !== undefined &&
      (patch.deliverySchedule === null || typeof patch.deliverySchedule !== 'object')
    ) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'deliverySchedule must be an object if provided, not null',
      );
    }

    if (!patch.tax && !patch.limits && !patch.deliverySchedule) {
      throw shopError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'At least one editable setting section (tax, limits, deliverySchedule) must be provided',
      );
    }

    if (patch.tax) {
      if (patch.tax.enabled !== undefined && (patch.tax.enabled === null || typeof patch.tax.enabled !== 'boolean')) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'tax.enabled must be a boolean if provided, not null',
        );
      }
      if (patch.tax.rateBps !== undefined && patch.tax.rateBps === null) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'tax.rateBps cannot be null',
        );
      }
      if (patch.tax.enabled === undefined && patch.tax.rateBps === undefined) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'tax patch must contain at least one of enabled or rateBps',
        );
      }
      if (
        patch.tax.rateBps !== undefined &&
        (!Number.isInteger(patch.tax.rateBps) ||
          patch.tax.rateBps < 0 ||
          patch.tax.rateBps > 10000)
      ) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'tax.rateBps must be an integer between 0 and 10000 (0% to 100%)',
        );
      }
    }

    if (patch.limits) {
      if (
        patch.limits.maxUnitsPerSkuPerOrder === undefined ||
        patch.limits.maxUnitsPerSkuPerOrder === null ||
        !Number.isInteger(patch.limits.maxUnitsPerSkuPerOrder) ||
        patch.limits.maxUnitsPerSkuPerOrder < 1 ||
        patch.limits.maxUnitsPerSkuPerOrder > 100
      ) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'limits.maxUnitsPerSkuPerOrder must be an integer between 1 and 100',
        );
      }
    }

    if (patch.deliverySchedule) {
      if (patch.deliverySchedule.startTime !== undefined && patch.deliverySchedule.startTime === null) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'deliverySchedule.startTime cannot be null',
        );
      }
      if (patch.deliverySchedule.endTime !== undefined && patch.deliverySchedule.endTime === null) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'deliverySchedule.endTime cannot be null',
        );
      }
      if (
        patch.deliverySchedule.startTime === undefined &&
        patch.deliverySchedule.endTime === undefined
      ) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'deliverySchedule patch must contain at least one of startTime or endTime',
        );
      }
      const timeRegex = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
      if (
        patch.deliverySchedule.startTime !== undefined &&
        (typeof patch.deliverySchedule.startTime !== 'string' || !timeRegex.test(patch.deliverySchedule.startTime))
      ) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'deliverySchedule.startTime must be a valid HH:mm time string (00:00 to 23:59)',
        );
      }
      if (
        patch.deliverySchedule.endTime !== undefined &&
        (typeof patch.deliverySchedule.endTime !== 'string' || !timeRegex.test(patch.deliverySchedule.endTime))
      ) {
        throw shopError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          'deliverySchedule.endTime must be a valid HH:mm time string (00:00 to 23:59)',
        );
      }
    }
  }
}
