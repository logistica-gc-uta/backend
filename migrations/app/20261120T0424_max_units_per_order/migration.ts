#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/26b9ce897d81c1659e885bf4417cfcfda96d2a33bc6fa69a24ed74be8788a332/contract';
import endContract from '../../snapshots/26b9ce897d81c1659e885bf4417cfcfda96d2a33bc6fa69a24ed74be8788a332/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/2ba9059120d3e914cfd40c2b6f0520d25b2c6e26c198e93389573d9c48b1cfda/contract';
import startContract from '../../snapshots/2ba9059120d3e914cfd40c2b6f0520d25b2c6e26c198e93389573d9c48b1cfda/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'shopBusinessSettings',
        constraint: 'shop_settings_valid_a76e081c',
      }),
      this.addColumn({
        schema: 'public',
        table: 'shopBusinessSettings',
        column: col('maxUnitsPerOrder', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'shopBusinessSettings',
        constraint: 'shop_settings_valid_eba44d0c',
        expression:
          'version >= 1 AND currency = \'USD\' AND "shippingStatus" = \'FREE_INCLUDED\' AND "shippingAmountCents" = 0 AND "shippingIncludedInPrices" = true AND "taxMode" = \'SIMULATED\' AND "taxRateBps" BETWEEN 0 AND 10000 AND "maxUnitsPerSkuPerOrder" BETWEEN 1 AND 100 AND "deliveryTimeZone" = \'America/Guayaquil\' AND "deliveryBoundariesInclusive" = true AND "deliveryStartTime" ~ \'^([01][0-9]|2[0-3]):[0-5][0-9]$\' AND "deliveryEndTime" ~ \'^([01][0-9]|2[0-3]):[0-5][0-9]$\' AND "deliveryStartTime" < "deliveryEndTime" AND "routeTimeWindowMarginMinutes" BETWEEN 5 AND 180 AND ("maxUnitsPerOrder" IS NULL OR "maxUnitsPerOrder" BETWEEN 1 AND 1000)',
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
