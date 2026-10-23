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
});
