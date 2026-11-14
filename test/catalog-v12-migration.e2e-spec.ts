import { randomUUID } from 'node:crypto';
import {
  CATALOG_ORIGIN, CATALOG_CURRENT, createOwnedDatabase, runPrismaMigrate,
  runPrismaVerify, execPsqlCommand, startOwnedContainer, cleanupOwnedResources,
  createScratchFile, backupOwnedDatabase, restoreOwnedDatabase,
} from './catalog-v12-migration.fixtures.js';

describe('catalog v1.2 formal migration — owned PostgreSQL only', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `catalog_${suffix}`;
  const restored = `catalog_restore_${suffix}`;
  let url: string;

  beforeAll(() => {
    startOwnedContainer();
    url = createOwnedDatabase(name);
    runPrismaMigrate(url, CATALOG_ORIGIN);
  });
  afterAll(() => cleanupOwnedResources());

  it('preserves historical float values, leaves invalid cents null, and replays from backup', () => {
    execPsqlCommand(name, `
      INSERT INTO public."user"(id,name,email,password,role) VALUES ('catalog-client','Catalog Client','catalog-client@example.test','hash','CLIENT');
      INSERT INTO public.zone(id,name,code) VALUES ('catalog-zone','Catalog zone','CAT');
      INSERT INTO public.product(id,name,price,stock) VALUES
        ('legacy-valid','Valid',0.1,3),('legacy-invalid','Invalid',0.301,0);
      INSERT INTO public."order"(id,"userId","zoneId",total,"deliveryAddress") VALUES
        ('legacy-order','catalog-client','catalog-zone',0.1,'Address'),('invalid-order','catalog-client','catalog-zone',0.301,'Address');
      INSERT INTO public."orderItem"(id,"orderId","productId",quantity,price) VALUES
        ('legacy-line','legacy-order','legacy-valid',1,0.1),
        ('invalid-line','invalid-order','legacy-invalid',1,0.301);
    `);
    const backup = createScratchFile('catalog-before');
    backupOwnedDatabase(name, backup);
    runPrismaMigrate(url, CATALOG_CURRENT);
    runPrismaVerify(url);
    expect(execPsqlCommand(name, `SELECT price::text||':'||"priceCents"||':'||"isPublished"||':'||(sku = 'LEGACY-'||md5(id)) FROM public.product WHERE id='legacy-valid'`)).toBe('0.1:10:false:true');
    expect(execPsqlCommand(name, `SELECT price::text||':'||coalesce("priceCents"::text,'NULL') FROM public.product WHERE id='legacy-invalid'`)).toBe('0.301:NULL');
    expect(execPsqlCommand(name, `SELECT total::text||':'||coalesce("subtotalCents"::text,'NULL') FROM public."order" WHERE id='invalid-order'`)).toBe('0.301:NULL');
    expect(execPsqlCommand(name, `SELECT "unitPriceCents" FROM public."orderItem" WHERE id='legacy-line'`)).toBe('10');
    expect(execPsqlCommand(name, `SELECT coalesce("unitPriceCents"::text,'NULL') FROM public."orderItem" WHERE id='invalid-line'`)).toBe('NULL');
    expect(() => execPsqlCommand(name, `UPDATE public.product SET stock=-1 WHERE id='legacy-valid'`)).toThrow();
    expect(() => execPsqlCommand(name, `UPDATE public.product SET "isPublished"=true WHERE id='legacy-valid'`)).toThrow();
    expect(() => execPsqlCommand(name, `INSERT INTO public.category(id,name,slug) VALUES ('c1','Category','unique'),('c2','Category','unique')`)).toThrow();
    expect(() => execPsqlCommand(name, `INSERT INTO public.category(id,name,slug) VALUES ('c3','Same Name','first'),('c4','Same Name','second')`)).toThrow();
    execPsqlCommand(name, `INSERT INTO public."uploadedAsset" (id,"actorId","publicId",format,bytes,width,height,"expiresAt")
      VALUES ('reservation','catalog-client','regalia/products/reservation','jpg',100,10,10,now() + interval '1 day')`);
    expect(execPsqlCommand(name, `SELECT status||':'||coalesce("secureUrl",'NULL') FROM public."uploadedAsset" WHERE id='reservation'`)).toBe('UPLOADING:NULL');
    expect(() => execPsqlCommand(name, `UPDATE public."uploadedAsset" SET status='UPLOADED' WHERE id='reservation'`)).toThrow();
    expect(() => execPsqlCommand(name, `UPDATE public."uploadedAsset" SET "secureUrl"='http://example.test/image' WHERE id='reservation'`)).toThrow();
    const restoredUrl = createOwnedDatabase(restored);
    restoreOwnedDatabase(restored, backup);
    expect(() => execPsqlCommand(restored, `SELECT "priceCents" FROM public.product LIMIT 1`)).toThrow();
    runPrismaMigrate(restoredUrl, CATALOG_CURRENT);
    expect(execPsqlCommand(restored, `SELECT price::text||':'||"priceCents" FROM public.product WHERE id='legacy-valid'`)).toBe('0.1:10');
  });

  it('CT-042: audita los importes con más de dos decimales sin truncarlos y el rollback deja intactos los históricos', () => {
    const audit = `catalog_audit_${suffix}`;
    const auditRestored = `catalog_audit_restore_${suffix}`;
    const auditUrl = createOwnedDatabase(audit);
    runPrismaMigrate(auditUrl, CATALOG_ORIGIN);
    execPsqlCommand(audit, `
      INSERT INTO public."user"(id,name,email,password,role) VALUES ('audit-client','Audit Client','audit-client@example.test','hash','CLIENT');
      INSERT INTO public.zone(id,name,code) VALUES ('audit-zone','Audit zone','AUD');
      INSERT INTO public.product(id,name,price,stock) VALUES
        ('p-a','Exacto dos decimales',19.99,1),('p-b','Medio centavo',0.005,1),('p-c','Redondeo ambiguo',2.675,1),
        ('p-d','Tres decimales',12.345,1),('p-e','Decimo',0.1,1),('p-f','Entero',1000,1);
      INSERT INTO public."order"(id,"userId","zoneId",total,"deliveryAddress") VALUES
        ('o-a','audit-client','audit-zone',19.99,'Address'),('o-b','audit-client','audit-zone',0.005,'Address');
      INSERT INTO public."orderItem"(id,"orderId","productId",quantity,price) VALUES
        ('l-a','o-a','p-a',1,19.99),('l-b','o-b','p-b',1,0.005);
    `);
    const fingerprint = (database: string) =>
      execPsqlCommand(database, `SELECT md5(
        (SELECT string_agg(id||':'||price::text, ',' ORDER BY id) FROM public.product) ||
        (SELECT string_agg(id||':'||total::text, ',' ORDER BY id) FROM public."order") ||
        (SELECT string_agg(id||':'||price::text, ',' ORDER BY id) FROM public."orderItem"))`);
    const before = fingerprint(audit);
    const backup = createScratchFile('catalog-audit-before');
    backupOwnedDatabase(audit, backup);

    runPrismaMigrate(auditUrl, CATALOG_CURRENT);
    runPrismaVerify(auditUrl);

    expect(fingerprint(audit)).toBe(before);
    expect(execPsqlCommand(audit, `SELECT string_agg(id||'='||"priceCents", ',' ORDER BY id) FROM public.product WHERE "priceCents" IS NOT NULL`)).toBe('p-a=1999,p-e=10,p-f=100000');
    const moreThanTwoDecimals = execPsqlCommand(audit, `SELECT string_agg(id, ',' ORDER BY id) FROM public.product WHERE price::numeric <> round(price::numeric, 2)`);
    const withoutCents = execPsqlCommand(audit, `SELECT string_agg(id, ',' ORDER BY id) FROM public.product WHERE "priceCents" IS NULL`);
    expect(moreThanTwoDecimals).toBe('p-b,p-c,p-d');
    expect(withoutCents).toBe(moreThanTwoDecimals);
    expect(execPsqlCommand(audit, `SELECT string_agg(id, ',' ORDER BY id) FROM public."orderItem" WHERE "unitPriceCents" IS NULL`)).toBe('l-b');
    expect(execPsqlCommand(audit, `SELECT string_agg(id, ',' ORDER BY id) FROM public."order" WHERE "subtotalCents" IS NULL`)).toBe('o-b');

    runPrismaMigrate(createOwnedDatabase(auditRestored), CATALOG_ORIGIN);
    restoreOwnedDatabase(auditRestored, backup);
    expect(fingerprint(auditRestored)).toBe(before);
    expect(() => execPsqlCommand(auditRestored, `SELECT "priceCents" FROM public.product LIMIT 1`)).toThrow();
  });
});
