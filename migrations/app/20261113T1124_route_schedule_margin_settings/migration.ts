#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/43c5b496e829fac9432660009b97051986b46f1c7907aebc529e25875912b1a6/contract';
import endContract from '../../snapshots/43c5b496e829fac9432660009b97051986b46f1c7907aebc529e25875912b1a6/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/b5cbec5e55f8808d4442a200be9ff3b6d62e770ea9021d18110262f36e544233/contract';
import startContract from '../../snapshots/b5cbec5e55f8808d4442a200be9ff3b6d62e770ea9021d18110262f36e544233/contract.json' with { type: 'json' };
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
