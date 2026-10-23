#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/9f73d985865e87ee2463db38ee9153132c0c6748c5ca43dda00b82d77a1685af/contract';
import startContract from '../../snapshots/9f73d985865e87ee2463db38ee9153132c0c6748c5ca43dda00b82d77a1685af/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/b263aff9f248d0da2ead5a0700a5b035ab3653ec79e1f8c651ab5f936e21e1ea/contract';
import endContract from '../../snapshots/b263aff9f248d0da2ead5a0700a5b035ab3653ec79e1f8c651ab5f936e21e1ea/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'uploadedAsset',
        constraint: 'upload_asset_valid_5f740ac4',
      }),
      this.dropNotNull({ schema: 'public', table: 'uploadedAsset', column: 'secureUrl' }),
      this.setDefault({
        schema: 'public',
        table: 'uploadedAsset',
        column: 'status',
        defaultSql: "DEFAULT 'UPLOADING'",
        operationClass: 'widening',
      }),
      this.addUnique({
        schema: 'public',
        table: 'category',
        constraint: 'category_name_key',
        columns: ['name'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploadedAsset',
        constraint: 'upload_asset_valid_0bca3c81',
        expression:
          "status IN ('UPLOADING', 'UPLOADED', 'ATTACHED', 'CLEANUP_PENDING', 'DELETED') AND bytes BETWEEN 1 AND 5242880 AND width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192 AND format IN ('jpg', 'png', 'webp') AND \"cleanupAttempts\" >= 0 AND (\"secureUrl\" IS NULL OR \"secureUrl\" LIKE 'https://%') AND (status NOT IN ('UPLOADED', 'ATTACHED') OR \"secureUrl\" IS NOT NULL)",
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
