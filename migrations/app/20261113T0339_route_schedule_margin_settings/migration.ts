#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/a2fd787bf37564e662b981accae124f9d7bde83c91b8ca1c8b16e338a9384973/contract';
import endContract from '../../snapshots/a2fd787bf37564e662b981accae124f9d7bde83c91b8ca1c8b16e338a9384973/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e44d61fd753bd3404c42e85b9570cb95731fcf8b6f1659b4e254e2a4774adc70/contract';
import startContract from '../../snapshots/e44d61fd753bd3404c42e85b9570cb95731fcf8b6f1659b4e254e2a4774adc70/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'shopBusinessSettings',
        constraint: 'shop_settings_valid_abaee184',
      }),
      this.addColumn({
        schema: 'public',
        table: 'shopBusinessSettings',
        column: col('routeTimeWindowMarginMinutes', 'int4', {
          notNull: true,
          default: lit(30),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'shopBusinessSettings',
        constraint: 'shop_settings_valid_a76e081c',
        expression:
          'version >= 1 AND currency = \'USD\' AND "shippingStatus" = \'FREE_INCLUDED\' AND "shippingAmountCents" = 0 AND "shippingIncludedInPrices" = true AND "taxMode" = \'SIMULATED\' AND "taxRateBps" BETWEEN 0 AND 10000 AND "maxUnitsPerSkuPerOrder" BETWEEN 1 AND 100 AND "deliveryTimeZone" = \'America/Guayaquil\' AND "deliveryBoundariesInclusive" = true AND "deliveryStartTime" ~ \'^([01][0-9]|2[0-3]):[0-5][0-9]$\' AND "deliveryEndTime" ~ \'^([01][0-9]|2[0-3]):[0-5][0-9]$\' AND "deliveryStartTime" < "deliveryEndTime" AND "routeTimeWindowMarginMinutes" BETWEEN 5 AND 180',
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
