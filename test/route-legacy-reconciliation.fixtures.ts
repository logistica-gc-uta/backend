export const LEGACY_A = 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb71';
export const LEGACY_B = 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb72';
export const DRIVERLESS = 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb73';
export const OTHER_LEGACY = 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb74';
export const VERIFIED = 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb75';
export const LEGACY_PAYLOAD = {
  reason: 'Dispatch independently checked',
  evidence: 'Depot operator and dispatcher confirmed no current load',
};
// Fresh database seed before integrity guards; retain deliberately ambiguous history.
export const LEGACY_RECONCILIATION_FIXTURE = `
INSERT INTO public."user" (id,name,email,password,role) VALUES
('owner','Owner','owner@fixture.invalid','fixture','DRIVER'),
('other','Other','other@fixture.invalid','fixture','DRIVER'),
('admin','Admin','admin@fixture.invalid','fixture','ADMIN'),
('admin2','Admin2','admin2@fixture.invalid','fixture','ADMIN'),
('client','Client','client@fixture.invalid','fixture','CLIENT');
INSERT INTO public.driver (id,"userId",vehicle,"isAvailable") VALUES
('driver','owner','Fixture',false),('other-driver','other','Fixture',false);
INSERT INTO public.zone (id,name,code) VALUES ('zone','Fixture','FIXTURE');
INSERT INTO public.route (id,"driverId","zoneId",date,status) VALUES
('${LEGACY_A}','driver','zone','2020-02-03T00:00:00Z',NULL),('${LEGACY_B}','driver','zone','2020-02-03T00:00:00Z',NULL),
('${DRIVERLESS}',NULL,'zone','2020-02-03T00:00:00Z',NULL),('${OTHER_LEGACY}','other-driver','zone','2020-02-03T00:00:00Z',NULL),
('${VERIFIED}','other-driver','zone','2026-10-10T00:00:00Z','ASSIGNED');
INSERT INTO public."driverReservation" (id,"driverId","routeId","reservedAt") VALUES
('legacy-reservation','driver','${LEGACY_A}',NULL),
('verified-reservation','other-driver','${VERIFIED}','2026-10-10T00:00:00Z');
INSERT INTO public."order" (id,"userId","zoneId",status,"deliveryAddress","routeId","stopOrder") VALUES
('ambiguous','client','zone','PENDING','Fixture','${LEGACY_A}',-3);
INSERT INTO public."routeStop" (id,"routeId","orderId",sequence,outcome,"isLegacy") VALUES
('ambiguous-a','${LEGACY_A}','ambiguous',NULL,NULL,true),
('ambiguous-b','${LEGACY_B}','ambiguous',NULL,NULL,true);
INSERT INTO public."orderClaim" (id,"orderId","routeId","claimedAt") VALUES
('legacy-claim','ambiguous','${LEGACY_A}',NULL);
`;
