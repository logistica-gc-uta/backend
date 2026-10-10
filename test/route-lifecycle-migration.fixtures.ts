export const ROUTE_FOUNDATION_HASH =
  "46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452";

export const ROUTE_BASELINE_HASH =
  '00d34ab56ae55b663a53148a126d233c0801ea6863ee0e3b22273a20d77d862e';

// Deliberately preserve null, duplicate and invalid legacy positions without sorting.
export const LEGACY_ROUTE_FIXTURE = `
  INSERT INTO public."user" (id, name, email, password, role) VALUES
    ('client', 'Client', 'client@fixture.invalid', 'fixture', 'CLIENT'),
    ('driver-user', 'Driver', 'driver@fixture.invalid', 'fixture', 'DRIVER'),
    ('admin', 'Admin', 'admin@fixture.invalid', 'fixture', 'ADMIN');
  INSERT INTO public.driver (id, "userId", vehicle, "isAvailable")
    VALUES ('driver', 'driver-user', 'Fixture', false);
  INSERT INTO public.zone (id, name, code) VALUES ('zone', 'Fixture', 'FIXTURE');
  INSERT INTO public.route (id, "driverId", "zoneId") VALUES
    ('legacy-a', 'driver', 'zone'), ('legacy-b', 'driver', 'zone');
  INSERT INTO public."order" (id, "userId", "zoneId", "routeId", status, "deliveryAddress", "stopOrder") VALUES
    ('order-null', 'client', 'zone', 'legacy-a', 'PENDING', 'Fixture', NULL),
    ('order-one', 'client', 'zone', 'legacy-a', 'ASSIGNED', 'Fixture', 1),
    ('order-duplicate', 'client', 'zone', 'legacy-a', 'DELIVERED', 'Fixture', 1),
    ('order-invalid', 'client', 'zone', 'legacy-b', 'CANCELLED', 'Fixture', -2);
`;
