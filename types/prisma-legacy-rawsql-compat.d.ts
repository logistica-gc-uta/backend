import '@prisma/orm-postgres/migration';

/**
 * Project-owned downstream compatibility, NOT an official Prisma fix.
 * rawSql is an identity at runtime: return the actual input T, never a full
 * SDK operation that would falsely promise target.details.objectType.
 * SQL and file provenance are enforced separately by the compatibility spec.
 */
declare module '@prisma/orm-postgres/migration' {
  type LegacyRawSqlIdentity =
    | {
        id: 'backfill.legacy-route-stops';
        label: 'Preserve legacy route/order associations';
        target: {
          id: 'postgres';
          details: { schema: 'public'; name: 'routeStop'; objectType?: never };
        };
      }
    | {
        id: 'route-lifecycle.integrity-guards';
        label: 'Install row-locked route structure and append-only history guards';
        target: {
          id: 'postgres';
          details: { schema: 'public'; name: 'route_integrity_guard'; objectType?: never };
        };
      }
    | {
        id: 'route-lifecycle.coherence-guards';
        label: 'Install deferred lifecycle coherence and insert-time audit guards';
        target: {
          id: 'postgres';
          details: { schema: 'public'; name: 'route_lifecycle_coherence_guard'; objectType?: never };
        };
      };

  type LegacyRawSqlStep = { description: string; sql: string };
  type LegacyRawSqlOperation = LegacyRawSqlIdentity & {
    operationClass: 'additive';
    precheck: [LegacyRawSqlStep, ...LegacyRawSqlStep[]];
    execute: [LegacyRawSqlStep, ...LegacyRawSqlStep[]];
    postcheck: [LegacyRawSqlStep, ...LegacyRawSqlStep[]];
  };

  // Adds one narrow overload; the installed SDK overload remains unchanged.
  function rawSql<T extends LegacyRawSqlOperation>(op: T): T;
}
