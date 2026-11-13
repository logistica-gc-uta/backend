const todayGuayaquil = Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate();
const atLocal = (daysOffset: number, plainTime: string) =>
  todayGuayaquil
    .add({ days: daysOffset })
    .toZonedDateTime({ timeZone: 'America/Guayaquil', plainTime })
    .toInstant()
    .toString();

export const PROPOSAL_DAY = todayGuayaquil.toString();
export const PROPOSAL_YESTERDAY_DAY = todayGuayaquil.subtract({ days: 1 }).toString();
export const PROPOSAL_TOMORROW_DAY = todayGuayaquil.add({ days: 1 }).toString();
export const PROPOSAL_DATE = atLocal(0, '19:00:00');
export const PROPOSAL_SAME_DAY_NIGHT = atLocal(0, '22:00:00');
export const PROPOSAL_NEXT_DAY_MIDNIGHT = atLocal(1, '00:00:00');
export const PROPOSAL_TOMORROW_NOON = atLocal(1, '12:00:00');
export const PROPOSAL_YESTERDAY_NOON = atLocal(-1, '12:00:00');
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
