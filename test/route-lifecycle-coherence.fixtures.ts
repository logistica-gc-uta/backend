export const COHERENCE_FIXTURE = `
BEGIN;
INSERT INTO public."user" (id, name, email, password, role) VALUES
  ('owner-a', 'Owner A', 'owner-a@fixture.invalid', 'fixture', 'DRIVER'),
  ('owner-b', 'Owner B', 'owner-b@fixture.invalid', 'fixture', 'DRIVER'),
  ('owner-c', 'Owner C', 'owner-c@fixture.invalid', 'fixture', 'DRIVER'),
  ('owner-workflow', 'Owner Workflow', 'owner-workflow@fixture.invalid', 'fixture', 'DRIVER'),
  ('owner-legacy', 'Owner Legacy', 'owner-legacy@fixture.invalid', 'fixture', 'DRIVER'),
  ('owner-legacy-second', 'Owner Legacy Second', 'owner-legacy-second@fixture.invalid', 'fixture', 'DRIVER'),
  ('admin', 'Admin', 'admin@fixture.invalid', 'fixture', 'ADMIN'),
  ('client', 'Client', 'client@fixture.invalid', 'fixture', 'CLIENT');
INSERT INTO public.driver (id, "userId", vehicle) VALUES
  ('driver-a', 'owner-a', 'Fixture A'),
  ('driver-b', 'owner-b', 'Fixture B'),
  ('driver-c', 'owner-c', 'Fixture C'),
  ('driver-workflow', 'owner-workflow', 'Fixture Workflow'),
  ('driver-legacy', 'owner-legacy', 'Fixture Legacy'),
  ('driver-legacy-second', 'owner-legacy-second', 'Fixture Legacy Second');
INSERT INTO public.zone (id, name, code) VALUES ('zone', 'Fixture', 'FIXTURE');
INSERT INTO public.route (id, "zoneId", status) VALUES
  ('route-a', 'zone', 'DRAFT'),
  ('route-b', 'zone', 'DRAFT'),
  ('route-draft', 'zone', 'DRAFT'),
  ('route-completed', 'zone', 'DRAFT');
INSERT INTO public.route (id, "driverId", "zoneId", status) VALUES
  ('route-legacy', 'driver-legacy', 'zone', NULL);
INSERT INTO public."order" (id, "userId", "zoneId", "routeId", status, "deliveryAddress") VALUES
  ('order-a', 'client', 'zone', 'route-a', 'ASSIGNED', 'Fixture A'),
  ('order-b', 'client', 'zone', 'route-b', 'ASSIGNED', 'Fixture B'),
  ('order-completed', 'client', 'zone', 'route-completed', 'ASSIGNED', 'Fixture Completed'),
  ('order-draft', 'client', 'zone', NULL, 'PENDING', 'Fixture Draft'),
  ('order-extra', 'client', 'zone', NULL, 'PENDING', 'Fixture Extra');
INSERT INTO public."routeStop" (id, "routeId", "orderId", sequence, outcome) VALUES
  ('stop-a', 'route-a', 'order-a', 1, 'PENDING'),
  ('stop-b', 'route-b', 'order-b', 1, 'PENDING'),
  ('stop-completed', 'route-completed', 'order-completed', 1, 'PENDING'),
  ('stop-draft', 'route-draft', 'order-draft', 1, 'PENDING');
INSERT INTO public."orderClaim" (id, "routeId", "orderId", "claimedAt") VALUES
  ('claim-a', 'route-a', 'order-a', NOW() - INTERVAL '1 minute'),
  ('claim-b', 'route-b', 'order-b', NOW()),
  ('claim-completed', 'route-completed', 'order-completed', NOW() - INTERVAL '2 minutes'),
  ('claim-draft', 'route-draft', 'order-draft', NOW());
INSERT INTO public."driverReservation" (id, "routeId", "driverId", "reservedAt") VALUES
  ('reservation-a', 'route-a', 'driver-a', NOW() - INTERVAL '1 minute'),
  ('reservation-b', 'route-b', 'driver-b', NOW()),
  ('reservation-completed', 'route-completed', 'driver-c', NOW());
INSERT INTO public."driverReservation" (id, "routeId", "driverId") VALUES
  ('legacy-reservation', 'route-legacy', 'driver-legacy');
UPDATE public.route SET "driverId" = 'driver-a', status = 'IN_PROGRESS',
  "startedAt" = NOW() - INTERVAL '1 minute', "startedById" = 'owner-a'
  WHERE id = 'route-a';
UPDATE public.route SET "driverId" = 'driver-b', status = 'ASSIGNED'
  WHERE id = 'route-b';
UPDATE public.route SET "driverId" = 'driver-c', status = 'IN_PROGRESS',
  "startedAt" = NOW() - INTERVAL '2 minutes', "startedById" = 'owner-c'
  WHERE id = 'route-completed';
UPDATE public."routeStop" SET outcome = 'SUCCESSFUL' WHERE id = 'stop-completed';
INSERT INTO public."deliveryAttempt" (id, "stopId", "driverId", outcome, "recordedAt", context, "idempotencyKey", "requestPayload") VALUES
  ('attempt-completed', 'stop-completed', 'driver-c', 'SUCCESSFUL', NOW() - INTERVAL '1 minute', '{}', 'completed', '{}');
UPDATE public.route SET status = 'COMPLETED', "completedAt" = NOW() - INTERVAL '1 minute',
  "completedById" = 'owner-c' WHERE id = 'route-completed';
UPDATE public."orderClaim" SET "releasedAt" = NOW() - INTERVAL '1 minute'
  WHERE id = 'claim-completed';
COMMIT;
`;

export const COHERENCE_LEGACY_ROUTE_FIXTURE = `
BEGIN;
INSERT INTO public.route (id, "driverId", "zoneId", status) VALUES
  ('route-legacy-second', 'driver-legacy-second', 'zone', NULL);
INSERT INTO public."driverReservation" (id, "routeId", "driverId") VALUES
  ('legacy-reservation-second', 'route-legacy-second', 'driver-legacy-second');
COMMIT;
`;
