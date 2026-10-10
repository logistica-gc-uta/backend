export const START_ROUTE = 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb7c';
export const OTHER_ROUTE = 'f8541a2e-d9cb-4b09-8d9d-5c21e527cb7d';
export const START_FIXTURE = `
  INSERT INTO public."user" (id,name,email,password,role) VALUES
    ('owner','Owner','owner@fixture.invalid','fixture','DRIVER'),
    ('other','Other','other@fixture.invalid','fixture','DRIVER'),
    ('admin','Admin','admin@fixture.invalid','fixture','ADMIN'),
    ('client','Client','client@fixture.invalid','fixture','CLIENT');
  INSERT INTO public.driver (id,"userId",vehicle,"isAvailable") VALUES
    ('driver','owner','Fixture',false), ('other-driver','other','Fixture',true);
  INSERT INTO public.zone (id,name,code) VALUES ('zone','Fixture','FIXTURE');
  INSERT INTO public.route (id,"driverId","zoneId",date,status) VALUES
    ('${START_ROUTE}','driver','zone','2026-10-10T00:00:00Z','ASSIGNED'),
    ('${OTHER_ROUTE}','driver','zone','2026-10-10T00:00:00Z','ASSIGNED');
  INSERT INTO public."order" (id,"userId","zoneId","routeId",status,"deliveryAddress","scheduledDeliveryDate") VALUES
    ('order','client','zone','${START_ROUTE}','ASSIGNED','Fixture','2026-10-10T00:00:00Z'),
    ('other-order','client','zone','${OTHER_ROUTE}','ASSIGNED','Fixture','2026-10-10T00:00:00Z');
  INSERT INTO public."routeStop" (id,"routeId","orderId",sequence,outcome,"isLegacy") VALUES
    ('stop','${START_ROUTE}','order',1,'PENDING',false),
    ('other-stop','${OTHER_ROUTE}','other-order',1,'PENDING',false);
  INSERT INTO public."orderClaim" (id,"routeId","orderId","claimedAt") VALUES
    ('claim','${START_ROUTE}','order',now()), ('other-claim','${OTHER_ROUTE}','other-order',now());
  INSERT INTO public."driverReservation" (id,"routeId","driverId","reservedAt") VALUES
    ('reservation','${START_ROUTE}','driver',now());
`;
