import { randomUUID } from 'node:crypto';
import {
  createOwnedDatabase,
  runPrismaMigrate,
  runPrismaVerify,
  execPsqlCommand,
  backupOwnedDatabase,
  restoreOwnedDatabase,
  startOwnedContainer,
  cleanupOwnedResources,
  createScratchFile,
} from './geolocation-migration.fixtures.js';

describe('Geolocation Migration and Persistence (Issue #9 - T1)', () => {
  const BASELINE_HASH = 'ade716a5854bac9da24d9d458e813194b99fcacf7c156ace530749782dfead7f';

  const sessionSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const FRESH_DB_NAME = `geo_fresh_${sessionSuffix}`;
  const LEGACY_DB_NAME = `geo_legacy_${sessionSuffix}`;
  const RESTORE_DB_NAME = `geo_restore_${sessionSuffix}`;

  let freshDbUrl: string;
  let legacyDbUrl: string;
  let restoreDbUrl: string;
  let backupScratchPath: string;

  beforeAll(() => {
    startOwnedContainer();
    backupScratchPath = createScratchFile('migration-recovery');
  });

  afterAll(() => {
    cleanupOwnedResources();
  });

  describe('Baseline Pre-Migration Checks (RED on Baseline)', () => {
    it('verifies baseline database lacks geolocation columns and check constraints', () => {
      legacyDbUrl = createOwnedDatabase(LEGACY_DB_NAME);
      // Migrate strictly up to baseline hash
      runPrismaMigrate(legacyDbUrl, BASELINE_HASH);

      // Verify columns do not exist on baseline
      expect(() => {
        execPsqlCommand(
          LEGACY_DB_NAME,
          `SELECT "deliveryLat", "deliveryLng" FROM public."order" LIMIT 1;`,
        );
      }).toThrow(/column "deliveryLat" does not exist/);

      expect(() => {
        execPsqlCommand(
          LEGACY_DB_NAME,
          `SELECT "depotLat", "depotLng" FROM public.zone LIMIT 1;`,
        );
      }).toThrow(/column "depotLat" does not exist/);
    });
  });

  describe('Migration Application on Fresh and Legacy Databases (GREEN)', () => {
    it('seeds representative linked historical data into baseline database prior to migration', () => {
      // Seed legacy data including user, driver, zone, route, product, order, orderItem
      execPsqlCommand(
        LEGACY_DB_NAME,
        `
        INSERT INTO public."user" (id, name, email, password, role, "createdAt")
        VALUES ('u-legacy-client', 'Legacy Client', 'legacy-client@test.com', 'hash123', 'CLIENT', NOW());

        INSERT INTO public."user" (id, name, email, password, role, "createdAt")
        VALUES ('u-legacy-driver', 'Legacy Driver User', 'legacy-driver@test.com', 'hash123', 'DRIVER', NOW());

        INSERT INTO public.driver (id, "userId", vehicle, "isAvailable", "createdAt")
        VALUES ('d-legacy-1', 'u-legacy-driver', 'Camion-01', true, NOW());

        INSERT INTO public.zone (id, name, code, "createdAt")
        VALUES ('z-legacy-1', 'Zona Norte', 'ZN-01', NOW());

        INSERT INTO public.route (id, "driverId", "zoneId", date, "createdAt")
        VALUES ('r-legacy-1', 'd-legacy-1', 'z-legacy-1', NOW(), NOW());

        INSERT INTO public.product (id, name, description, price, stock, "createdAt")
        VALUES ('p-legacy-1', 'Producto Test', 'Desc test', 50.0, 10, NOW());

        INSERT INTO public."order" (
          id, "userId", "zoneId", "routeId", status, total, "deliveryAddress", "scheduledDeliveryDate", "stopOrder", "createdAt"
        ) VALUES (
          'o-legacy-1', 'u-legacy-client', 'z-legacy-1', 'r-legacy-1', 'PENDING', 50.0, 'Calle 100 #15-20', NOW(), 1, NOW()
        );

        INSERT INTO public."orderItem" (id, "orderId", "productId", quantity, price)
        VALUES ('oi-legacy-1', 'o-legacy-1', 'p-legacy-1', 1, 50.0);
        `,
      );

      const relationCount = execPsqlCommand(
        LEGACY_DB_NAME,
        `
        SELECT COUNT(*)
        FROM public."order" o
        JOIN public."user" u ON o."userId" = u.id
        JOIN public.zone z ON o."zoneId" = z.id
        JOIN public.route r ON o."routeId" = r.id
        JOIN public.driver d ON r."driverId" = d.id
        JOIN public."orderItem" oi ON oi."orderId" = o.id
        WHERE o.id = 'o-legacy-1';
        `,
      );
      expect(relationCount).toBe('1');
    });

    it('applies geolocation migration to legacy database and verifies historical integrity', () => {
      // Migrate legacy database forward to latest
      runPrismaMigrate(legacyDbUrl);

      // Verify historical rows have actual NULL coordinates and untouched business fields
      const legacyOrderReadback = execPsqlCommand(
        LEGACY_DB_NAME,
        `SELECT id || '|' || "deliveryAddress" || '|' || ("deliveryLat" IS NULL)::text || '|' || ("deliveryLng" IS NULL)::text || '|' || total::text FROM public."order" WHERE id = 'o-legacy-1';`,
      );
      expect(legacyOrderReadback).toBe('o-legacy-1|Calle 100 #15-20|true|true|50');

      const legacyZoneReadback = execPsqlCommand(
        LEGACY_DB_NAME,
        `SELECT id || '|' || name || '|' || code || '|' || ("depotLat" IS NULL)::text || '|' || ("depotLng" IS NULL)::text FROM public.zone WHERE id = 'z-legacy-1';`,
      );
      expect(legacyZoneReadback).toBe('z-legacy-1|Zona Norte|ZN-01|true|true');

      // Verify foreign key relations remain intact after migration
      const postMigrateRelationCount = execPsqlCommand(
        LEGACY_DB_NAME,
        `
        SELECT COUNT(*)
        FROM public."order" o
        JOIN public."user" u ON o."userId" = u.id
        JOIN public.zone z ON o."zoneId" = z.id
        JOIN public.route r ON o."routeId" = r.id
        JOIN public.driver d ON r."driverId" = d.id
        JOIN public."orderItem" oi ON oi."orderId" = o.id
        WHERE o.id = 'o-legacy-1';
        `,
      );
      expect(postMigrateRelationCount).toBe('1');

      // Verify schema parity and marker on migrated legacy database
      const verifyRes = runPrismaVerify(legacyDbUrl);
      expect(verifyRes.success).toBe(true);
    });

    it('migrates a fresh database completely from scratch and verifies schema parity', () => {
      freshDbUrl = createOwnedDatabase(FRESH_DB_NAME);
      runPrismaMigrate(freshDbUrl);

      const verifyRes = runPrismaVerify(freshDbUrl);
      expect(verifyRes.success).toBe(true);
    });
  });

  describe('Constraint Enforcement and Pair / Range Bypasses', () => {
    it('accepts complete NULL pair on Order and Zone', () => {
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-null-test', 'Zona Null', 'ZN-NULL', NULL, NULL);
          `,
        );
      }).not.toThrow();

      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public."user" (id, name, email, password, role)
          VALUES ('u-null-test', 'User Null', 'unull@test.com', 'h', 'CLIENT');

          INSERT INTO public."order" (id, "userId", "zoneId", "deliveryAddress", "deliveryLat", "deliveryLng")
          VALUES ('o-null-test', 'u-null-test', 'z-null-test', 'Cra 7 #72', NULL, NULL);
          `,
        );
      }).not.toThrow();

      const nullReadback = execPsqlCommand(
        FRESH_DB_NAME,
        `SELECT ("deliveryLat" IS NULL)::text || '|' || ("deliveryLng" IS NULL)::text FROM public."order" WHERE id = 'o-null-test';`,
      );
      expect(nullReadback).toBe('true|true');
    });

    it('accepts complete valid finite coordinates in range on Order and Zone', () => {
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-valid-test', 'Zona Valida', 'ZN-VAL', 4.6097, -74.0817);
          `,
        );
      }).not.toThrow();

      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public."order" (id, "userId", "zoneId", "deliveryAddress", "deliveryLat", "deliveryLng")
          VALUES ('o-valid-test', 'u-null-test', 'z-valid-test', 'Calle 26 #50', -90.0, 180.0);
          `,
        );
      }).not.toThrow();

      // Test boundary points [-90, 90] and [-180, 180]
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-bound-test', 'Zona Boundary', 'ZN-BND', 90.0, -180.0);
          `,
        );
      }).not.toThrow();

      const validReadback = execPsqlCommand(
        FRESH_DB_NAME,
        `SELECT "deliveryLat"::text || '|' || "deliveryLng"::text FROM public."order" WHERE id = 'o-valid-test';`,
      );
      expect(validReadback).toBe('-90|180');
    });

    it('rejects incomplete coordinate pairs (pair bypasses) with check violation', () => {
      // Incomplete lat without lng
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-incomp-1', 'Zona Incompleta 1', 'ZN-INC1', 4.6097, NULL);
          `,
        );
      }).toThrow(/check/i);

      // Incomplete lng without lat
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-incomp-2', 'Zona Incompleta 2', 'ZN-INC2', NULL, -74.0817);
          `,
        );
      }).toThrow(/check/i);

      // Order incomplete pairs
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public."order" (id, "userId", "zoneId", "deliveryAddress", "deliveryLat", "deliveryLng")
          VALUES ('o-incomp-1', 'u-null-test', 'z-valid-test', 'Dir', 4.6097, NULL);
          `,
        );
      }).toThrow(/check/i);

      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public."order" (id, "userId", "zoneId", "deliveryAddress", "deliveryLat", "deliveryLng")
          VALUES ('o-incomp-2', 'u-null-test', 'z-valid-test', 'Dir', NULL, -74.0817);
          `,
        );
      }).toThrow(/check/i);
    });

    it('rejects out-of-range coordinates (range bypasses) with check violation', () => {
      // Latitude > 90
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-range-1', 'Zona Range 1', 'ZN-R1', 90.0001, -74.0817);
          `,
        );
      }).toThrow(/check/i);

      // Latitude < -90
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-range-2', 'Zona Range 2', 'ZN-R2', -90.0001, -74.0817);
          `,
        );
      }).toThrow(/check/i);

      // Longitude > 180
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public."order" (id, "userId", "zoneId", "deliveryAddress", "deliveryLat", "deliveryLng")
          VALUES ('o-range-1', 'u-null-test', 'z-valid-test', 'Dir', 4.6097, 180.0001);
          `,
        );
      }).toThrow(/check/i);

      // Longitude < -180
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public."order" (id, "userId", "zoneId", "deliveryAddress", "deliveryLat", "deliveryLng")
          VALUES ('o-range-2', 'u-null-test', 'z-valid-test', 'Dir', 4.6097, -180.0001);
          `,
        );
      }).toThrow(/check/i);
    });

    it('rejects non-finite coordinates (NaN and Infinity) with check violation', () => {
      // NaN latitude
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-nan-1', 'Zona NaN 1', 'ZN-NAN1', 'NaN'::float8, 0.0);
          `,
        );
      }).toThrow(/check/i);

      // Infinity latitude
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-inf-1', 'Zona Inf 1', 'ZN-INF1', 'Infinity'::float8, 0.0);
          `,
        );
      }).toThrow(/check/i);

      // -Infinity longitude on order
      expect(() => {
        execPsqlCommand(
          FRESH_DB_NAME,
          `
          INSERT INTO public."order" (id, "userId", "zoneId", "deliveryAddress", "deliveryLat", "deliveryLng")
          VALUES ('o-inf-1', 'u-null-test', 'z-valid-test', 'Dir', 0.0, '-Infinity'::float8);
          `,
        );
      }).toThrow(/check/i);
    });
  });

  describe('Backup and Recovery Verification on Fresh Disposable DB', () => {
    it('backs up migrated database and restores into a fresh disposable database without data loss', () => {
      // Back up LEGACY_DB_NAME (which has historical + migrated structure)
      backupOwnedDatabase(LEGACY_DB_NAME, backupScratchPath);

      // Create new fresh disposable database for recovery
      restoreDbUrl = createOwnedDatabase(RESTORE_DB_NAME);

      // Restore backup into the fresh database
      restoreOwnedDatabase(RESTORE_DB_NAME, backupScratchPath);

      // Verify historical data exists intact on restored database
      const restoredOrderReadback = execPsqlCommand(
        RESTORE_DB_NAME,
        `SELECT id || '|' || "deliveryAddress" || '|' || ("deliveryLat" IS NULL)::text || '|' || ("deliveryLng" IS NULL)::text FROM public."order" WHERE id = 'o-legacy-1';`,
      );
      expect(restoredOrderReadback).toBe('o-legacy-1|Calle 100 #15-20|true|true');

      // Verify relations on restored database
      const restoredRelationCount = execPsqlCommand(
        RESTORE_DB_NAME,
        `
        SELECT COUNT(*)
        FROM public."order" o
        JOIN public."user" u ON o."userId" = u.id
        JOIN public.zone z ON o."zoneId" = z.id
        JOIN public.route r ON o."routeId" = r.id
        JOIN public.driver d ON r."driverId" = d.id
        JOIN public."orderItem" oi ON oi."orderId" = o.id
        WHERE o.id = 'o-legacy-1';
        `,
      );
      expect(restoredRelationCount).toBe('1');

      // Verify schema parity and marker on restored database
      const verifyRes = runPrismaVerify(restoreDbUrl);
      expect(verifyRes.success).toBe(true);

      // Verify check constraints are active and enforced on restored database
      expect(() => {
        execPsqlCommand(
          RESTORE_DB_NAME,
          `
          INSERT INTO public.zone (id, name, code, "depotLat", "depotLng")
          VALUES ('z-res-invalid', 'Restored Invalid', 'ZR-INV', 100.0, 0.0);
          `,
        );
      }).toThrow(/check/i);
    });
  });
});
