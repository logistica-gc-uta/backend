export const RETURN_ROUTE = 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb7c';
export const RETURN_DATE = '2026-10-10T00:00:00Z';
// Fresh owned database only. Existing audit pairs are seeded explicitly, not invented by return.
export const RETURN_FIXTURE = `
INSERT INTO public."user" (id,name,email,password,role) VALUES
('owner','Owner','owner@fixture.invalid','fixture','DRIVER'),
('other','Other','other@fixture.invalid','fixture','DRIVER'),
('admin','Admin','admin@fixture.invalid','fixture','ADMIN'),
('client','Client','client@fixture.invalid','fixture','CLIENT');
INSERT INTO public.driver (id,"userId",vehicle,"isAvailable") VALUES
('driver','owner','Fixture',false),('other-driver','other','Fixture',true);
INSERT INTO public.zone (id,name,code) VALUES ('zone','Fixture','FIXTURE');
INSERT INTO public.route (id,"driverId","zoneId",date,status,"startedAt","startedById","completedAt","completedById") VALUES
('${RETURN_ROUTE}','driver','zone','${RETURN_DATE}','COMPLETED','${RETURN_DATE}','owner','${RETURN_DATE}','owner');
INSERT INTO public."driverReservation" (id,"driverId","routeId","reservedAt") VALUES
('reservation','driver','${RETURN_ROUTE}','${RETURN_DATE}');
INSERT INTO public."order" (id,"userId","zoneId",status,"deliveryAddress","scheduledDeliveryDate") VALUES
('pending','client','zone','PENDING','Fixture','${RETURN_DATE}');
`;

export const LEGACY_ROUTE = 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb7d';
export const LEGACY_RETURN_FIXTURE = `
INSERT INTO public.route (id,"driverId","zoneId",status) VALUES ('${LEGACY_ROUTE}','driver','zone',NULL);
INSERT INTO public."routeStop" (id,"routeId","orderId",sequence,outcome,"isLegacy") VALUES ('ambiguous','${LEGACY_ROUTE}','pending',NULL,NULL,true);
`;
