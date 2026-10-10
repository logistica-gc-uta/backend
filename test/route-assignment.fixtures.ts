export const PROPOSAL_DATE = '2026-10-10T00:00:00Z';
export const ASSIGNMENT_FIXTURE = `
  INSERT INTO public."user" (id,name,email,password,role) VALUES
    ('admin','Admin','admin@fixture.invalid','fixture','ADMIN'),
    ('driver-user','Driver','driver@fixture.invalid','fixture','DRIVER'),
    ('client','Client','client@fixture.invalid','fixture','CLIENT');
  INSERT INTO public.driver (id,"userId",vehicle,"isAvailable") VALUES
    ('driver','driver-user','Fixture',true);
  INSERT INTO public.zone (id,name,code) VALUES
    ('zone','Fixture','FIXTURE'), ('other-zone','Other','OTHER');
  INSERT INTO public."order" (id,"userId","zoneId",status,"deliveryAddress","scheduledDeliveryDate") VALUES
    ('one','client','zone','PENDING','Fixture','${PROPOSAL_DATE}'),
    ('two','client','zone','PENDING','Fixture','${PROPOSAL_DATE}'),
    ('three','client','zone','PENDING','Fixture','${PROPOSAL_DATE}'),
    ('four','client','zone','PENDING','Fixture','${PROPOSAL_DATE}'),
    ('five','client','zone','PENDING','Fixture','${PROPOSAL_DATE}');
`;
