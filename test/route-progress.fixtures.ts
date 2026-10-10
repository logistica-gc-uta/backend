import { START_FIXTURE, START_ROUTE, OTHER_ROUTE } from './route-start.fixtures.js';

export const FAILED_STOP = '172458d0-8e18-42ad-87ec-9d6611a76d26';
export const SUCCESS_STOP = '172458d0-8e18-42ad-87ec-9d6611a76d27';
// Each test owns a fresh database; never truncate protected operational history.
export const PROGRESS_FIXTURE =
  START_FIXTURE.replace(
    'TRUNCATE public."user", public.zone CASCADE;',
    '',
  )
  .replace("('stop',", `('${FAILED_STOP}',`)
  .replace(
    `('${OTHER_ROUTE}','driver','zone','2026-10-10T00:00:00Z','ASSIGNED');`,
    `('${OTHER_ROUTE}','driver','zone','2026-10-10T00:00:00Z','DRAFT');`,
  )
  .replace(
    `'other-order','client','zone','${OTHER_ROUTE}','ASSIGNED'`,
    `'other-order','client','zone',NULL,'PENDING'`,
  ) +
  `
  INSERT INTO public."order" (id,"userId","zoneId","routeId",status,"deliveryAddress") VALUES
    ('success-order','client','zone','${START_ROUTE}','ASSIGNED','Fixture');
  INSERT INTO public."routeStop" (id,"routeId","orderId",sequence,outcome,"isLegacy") VALUES
    ('${SUCCESS_STOP}','${START_ROUTE}','success-order',2,'PENDING',false);
  INSERT INTO public."orderClaim" (id,"routeId","orderId","claimedAt") VALUES
    ('success-claim','${START_ROUTE}','success-order',now());
`;
