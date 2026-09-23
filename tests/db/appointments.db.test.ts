import request from 'supertest';

import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { appointmentsService } from '@/modules/appointments/appointments.service';
import { calendarService } from '@/modules/calendar/calendar.service';
import { createUser, authHeader } from './helpers/factories';

/**
 * Appointments, against real rows.
 *
 * The thing most worth proving here is not that an appointment can be created
 * — it is that one Person's appointment is unreachable from another Person's
 * account, through every route and every verb. That scoping runs through
 * `personAccess.resolveSubject` and a `personId` on the row itself, and a test
 * with only one user in it would see none of it. So every case below has at
 * least two people in the database and usually three.
 */

const app = createApp();

const grant = (
  personId: string,
  userId: string,
  role: 'OWNER' | 'CAREGIVER' | 'VIEWER',
) =>
  prisma.personMembership.create({
    data: { personId, userId, role, status: 'ACTIVE', acceptedAt: new Date() },
  });

const inDays = (days: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

const validBooking = (overrides: Record<string, unknown> = {}) => ({
  title: 'Cardiology follow-up',
  startsAt: inDays(7).toISOString(),
  durationMinutes: 45,
  clinician: 'Dr Adeyemi',
  specialty: 'Cardiology',
  location: 'Lagos University Teaching Hospital',
  reason: 'Six-month review',
  ...overrides,
});

describe('an appointment is built person-native', () => {
  it('writes the subject on the row and on the plan, and grants nothing by account', async () => {
    const user = await createUser();

    const res = await request(app)
      .post('/api/v1/appointments')
      .set(...authHeader(user))
      .send(validBooking());

    expect(res.status).toBe(201);

    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: res.body.data.id },
      include: { carePlan: true },
    });

    // The subject is the Person, on the appointment itself…
    expect(appointment.personId).toBe(user.personId);
    // …and on the plan that carries it into the care engine.
    expect(appointment.carePlan.personId).toBe(user.personId);
    expect(appointment.carePlan.type).toBe('APPOINTMENT');
    // Provenance, not access.
    expect(appointment.createdByUserId).toBe(user.id);
  });

  it('keeps the structured detail off CarePlan.metadata', async () => {
    const user = await createUser();

    const created = await appointmentsService.create(user.id, {
      ...validBooking(),
      startsAt: inDays(7),
      reminderLeadMinutes: [1440, 60],
    } as never);

    const plan = await prisma.carePlan.findUniqueOrThrow({
      where: { id: created.carePlanId },
    });

    // The JSON column already smuggles frequency, customTimes, aiDraftId and
    // babyName elsewhere in the codebase. Nothing about an appointment joined
    // it: every field is a real column.
    expect(plan.metadata).toEqual({});
    expect(created.clinician).toBe('Dr Adeyemi');
    expect(created.specialty).toBe('Cardiology');
    expect(created.location).toBe('Lagos University Teaching Hospital');
    expect(created.durationMinutes).toBe(45);
    expect(created.reminderLeadMinutes).toEqual([1440, 60]);
  });

  it('compiles down to a care event and one reminder per lead time', async () => {
    const user = await createUser();

    const created = await appointmentsService.create(user.id, {
      ...validBooking(),
      startsAt: inDays(7),
      reminderLeadMinutes: [1440, 60],
    } as never);

    const events = await prisma.careEvent.findMany({
      where: { carePlanId: created.carePlanId },
      include: { reminders: true },
    });

    // One event, two reminders — not two events. A CareEvent is what the
    // calendar syncs, so one per lead time would book the same appointment
    // into someone's diary twice.
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('APPOINTMENT');
    expect(events[0].scheduledFor.getTime()).toBe(created.startsAt.getTime());

    const sendAts = events[0].reminders
      .map((r) => created.startsAt.getTime() - r.sendAt.getTime())
      .sort((a, b) => a - b);

    // One hour and one day ahead of the appointment, in milliseconds.
    expect(sendAts).toEqual([60 * 60_000, 1440 * 60_000]);
  });

  it('refuses a time that has already passed', async () => {
    const user = await createUser();

    const res = await request(app)
      .post('/api/v1/appointments')
      .set(...authHeader(user))
      .send(validBooking({ startsAt: inDays(-1).toISOString() }));

    expect(res.status).toBe(400);
    expect(await prisma.appointment.count()).toBe(0);
  });
});

describe('one Person’s appointment is unreachable from another’s account', () => {
  it('refuses to book against a Person the caller has no relationship with', async () => {
    const carer = await createUser();
    const stranger = await createUser();

    const res = await request(app)
      .post('/api/v1/appointments')
      .set(...authHeader(carer))
      .send(validBooking({ personId: stranger.personId }));

    expect(res.status).toBe(403);
    expect(await prisma.appointment.count()).toBe(0);
  });

  it('does not list, read, update, cancel or complete it', async () => {
    const patient = await createUser();
    const outsider = await createUser();

    const appointment = await appointmentsService.create(patient.id, {
      ...validBooking(),
      startsAt: inDays(7),
    } as never);

    // Listing: scoped to the outsider's own Person, so it simply is not there.
    const list = await request(app)
      .get('/api/v1/appointments')
      .set(...authHeader(outsider));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);

    // Reading it by id, with no personId named: resolves to the outsider's own
    // Person, and the row is not theirs.
    const read = await request(app)
      .get(`/api/v1/appointments/${appointment.id}`)
      .set(...authHeader(outsider));
    expect(read.status).toBe(404);

    // Naming the subject explicitly is refused earlier, at the access check.
    const named = await request(app)
      .get(`/api/v1/appointments/${appointment.id}?personId=${patient.personId}`)
      .set(...authHeader(outsider));
    expect(named.status).toBe(403);

    const patched = await request(app)
      .patch(`/api/v1/appointments/${appointment.id}`)
      .set(...authHeader(outsider))
      .send({ notes: 'moved by someone else' });
    expect(patched.status).toBe(404);

    const cancelled = await request(app)
      .post(`/api/v1/appointments/${appointment.id}/cancel`)
      .set(...authHeader(outsider))
      .send({});
    expect(cancelled.status).toBe(404);

    const completed = await request(app)
      .post(`/api/v1/appointments/${appointment.id}/complete`)
      .set(...authHeader(outsider))
      .send({});
    expect(completed.status).toBe(404);

    // Nothing moved.
    const after = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    expect(after.status).toBe('SCHEDULED');
    expect(after.notes).toBe(appointment.notes);
  });

  it('lets a caregiver act, and a viewer only look', async () => {
    const patient = await createUser();
    const carer = await createUser();
    const observer = await createUser();

    await grant(patient.personId, carer.id, 'CAREGIVER');
    await grant(patient.personId, observer.id, 'VIEWER');

    const booked = await request(app)
      .post('/api/v1/appointments')
      .set(...authHeader(carer))
      .send(validBooking({ personId: patient.personId }));
    expect(booked.status).toBe(201);

    // The record belongs to the patient, not to the caregiver who booked it.
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: booked.body.data.id },
    });
    expect(row.personId).toBe(patient.personId);
    expect(row.createdByUserId).toBe(carer.id);

    // A viewer reads the same single row — not a copy of it.
    const seen = await request(app)
      .get(`/api/v1/appointments?personId=${patient.personId}`)
      .set(...authHeader(observer));
    expect(seen.status).toBe(200);
    expect(seen.body.data).toHaveLength(1);
    expect(seen.body.data[0].id).toBe(row.id);

    // …and cannot change it.
    const refused = await request(app)
      .post(`/api/v1/appointments/${row.id}/cancel`)
      .set(...authHeader(observer))
      .send({ personId: patient.personId });
    expect(refused.status).toBe(403);

    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('SCHEDULED');
  });
});

describe('moving an appointment moves what it had scheduled', () => {
  it('withdraws the old reminders and derives new ones', async () => {
    const user = await createUser();

    const appointment = await appointmentsService.create(user.id, {
      ...validBooking(),
      startsAt: inDays(7),
      reminderLeadMinutes: [1440, 60],
    } as never);

    const originalEvent = await prisma.careEvent.findFirstOrThrow({
      where: { carePlanId: appointment.carePlanId },
    });

    const movedTo = inDays(14, 14);
    await appointmentsService.update(user.id, appointment.id, { startsAt: movedTo } as never);

    // The old event is gone, and its reminders went with it. Nothing survives
    // pointing at a time that no longer exists — not even cancelled, which
    // would still be a row claiming a visit was once scheduled for then.
    expect(
      await prisma.careEvent.findUnique({ where: { id: originalEvent.id } }),
    ).toBeNull();
    expect(
      await prisma.reminder.count({ where: { careEventId: originalEvent.id } }),
    ).toBe(0);

    // Exactly one event for the appointment — not one per reminder, which
    // would put it in the calendar twice.
    const events = await prisma.careEvent.findMany({
      where: { carePlanId: appointment.carePlanId },
      include: { reminders: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0].scheduledFor.getTime()).toBe(movedTo.getTime());

    const leads = events[0].reminders
      .map((r) => movedTo.getTime() - r.sendAt.getTime())
      .sort((a, b) => a - b);
    expect(leads).toEqual([60 * 60_000, 1440 * 60_000]);
    expect(events[0].reminders.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('leaves the schedule alone when only the notes change', async () => {
    const user = await createUser();

    const appointment = await appointmentsService.create(user.id, {
      ...validBooking(),
      startsAt: inDays(7),
    } as never);

    const before = await prisma.reminder.findMany({
      where: { careEvent: { carePlanId: appointment.carePlanId } },
      orderBy: { sendAt: 'asc' },
    });

    await appointmentsService.update(user.id, appointment.id, {
      notes: 'Bring the previous ECG',
    } as never);

    const after = await prisma.reminder.findMany({
      where: { careEvent: { carePlanId: appointment.carePlanId } },
      orderBy: { sendAt: 'asc' },
    });

    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.every((r) => r.status === 'PENDING')).toBe(true);
  });
});

describe('cancelling keeps the record and stops the noise', () => {
  it('marks the appointment, withdraws reminders, and deletes nothing', async () => {
    const user = await createUser();

    const appointment = await appointmentsService.create(user.id, {
      ...validBooking(),
      startsAt: inDays(7),
    } as never);

    await appointmentsService.cancel(user.id, appointment.id, 'Clinic closed');

    const after = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });

    // Kept. That it was going to happen is part of the record.
    expect(after.status).toBe('CANCELLED');
    expect(after.cancellationReason).toBe('Clinic closed');
    expect(after.cancelledAt).toBeInstanceOf(Date);

    const live = await prisma.reminder.count({
      where: { careEvent: { carePlanId: appointment.carePlanId }, status: 'PENDING' },
    });
    expect(live).toBe(0);

    const plan = await prisma.carePlan.findUniqueOrThrow({
      where: { id: appointment.carePlanId },
    });
    // Finished with, not paused — pausing is for a course of treatment.
    expect(plan.status).toBe('COMPLETED');
  });

  it('refuses to cancel twice', async () => {
    const user = await createUser();
    const appointment = await appointmentsService.create(user.id, {
      ...validBooking(),
      startsAt: inDays(7),
    } as never);

    await appointmentsService.cancel(user.id, appointment.id);

    await expect(
      appointmentsService.cancel(user.id, appointment.id),
    ).rejects.toMatchObject({ errorCode: 'CONFLICT' });
  });
});

describe('calendar sync never takes an appointment down with it', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('still books when preparing the calendar throws', async () => {
    const user = await createUser();

    jest
      .spyOn(calendarService, 'prepareCarePlanSync')
      .mockRejectedValue(new Error('Google Calendar is unreachable'));

    const res = await request(app)
      .post('/api/v1/appointments')
      .set(...authHeader(user))
      .send(validBooking());

    // The booking is the primary flow and it succeeded.
    expect(res.status).toBe(201);

    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: res.body.data.id },
    });
    expect(appointment.status).toBe('SCHEDULED');

    // And the reminders that matter were still written.
    const reminders = await prisma.reminder.count({
      where: { careEvent: { carePlanId: appointment.carePlanId }, status: 'PENDING' },
    });
    expect(reminders).toBe(2);
  });

  it('still cancels when cleaning the calendar up throws', async () => {
    const user = await createUser();

    const appointment = await appointmentsService.create(user.id, {
      ...validBooking(),
      startsAt: inDays(7),
    } as never);

    jest
      .spyOn(calendarService, 'cleanupCarePlanEvents')
      .mockRejectedValue(new Error('Google Calendar is unreachable'));

    await expect(
      appointmentsService.cancel(user.id, appointment.id),
    ).resolves.toBeTruthy();

    const after = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    expect(after.status).toBe('CANCELLED');

    const live = await prisma.reminder.count({
      where: { careEvent: { carePlanId: appointment.carePlanId }, status: 'PENDING' },
    });
    expect(live).toBe(0);
  });
});

describe('appointments nobody attended stop being upcoming', () => {
  /**
   * Reaching the past honestly is impossible — the API refuses to book one
   * there, which is the point. So the row is aged with SQL, exactly as the
   * billing suite ages a stale checkout: what is under test is the sweep's
   * own query, and it has to be the query that will run in production.
   */
  const setStartsAt = async (appointmentId: string, when: Date) => {
    await prisma.$executeRaw`
      UPDATE appointments SET "startsAt" = ${when} WHERE id = ${appointmentId}
    `;
    await prisma.$executeRaw`
      UPDATE care_events SET "scheduledFor" = ${when}
       WHERE "carePlanId" = (SELECT "carePlanId" FROM appointments WHERE id = ${appointmentId})
    `;
  };

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

  it('marks one whose time has passed, and settles what it left behind', async () => {
    const user = await createUser();
    const appointment = await appointmentsService.create(user.id, {
      ...validBooking(),
      startsAt: inDays(1),
    } as never);

    // Well past the end plus the grace window.
    await setStartsAt(appointment.id, hoursAgo(12));

    const result = await appointmentsService.sweepMissed();
    expect(result.missed).toBe(1);

    const after = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    expect(after.status).toBe('MISSED');

    // Nothing left that would still fire or still look pending.
    const livePending = await prisma.reminder.count({
      where: { careEvent: { carePlanId: appointment.carePlanId }, status: 'PENDING' },
    });
    expect(livePending).toBe(0);

    const events = await prisma.careEvent.findMany({
      where: { carePlanId: appointment.carePlanId },
    });
    expect(events.every((e) => e.status === 'MISSED')).toBe(true);

    const plan = await prisma.carePlan.findUniqueOrThrow({
      where: { id: appointment.carePlanId },
    });
    expect(plan.status).toBe('COMPLETED');
  });

  it('leaves alone anything still ahead, in progress, or already resolved', async () => {
    const user = await createUser();

    const future = await appointmentsService.create(user.id, {
      ...validBooking({ title: 'Still to come' }),
      startsAt: inDays(3),
    } as never);

    // Started 15 minutes ago and runs for 45: still in the room, not missed.
    const inProgress = await appointmentsService.create(user.id, {
      ...validBooking({ title: 'Happening now' }),
      startsAt: inDays(1),
    } as never);
    await setStartsAt(inProgress.id, new Date(Date.now() - 15 * 60_000));

    // Over, but inside the grace window — two hours by default.
    const justFinished = await appointmentsService.create(user.id, {
      ...validBooking({ title: 'Only just over' }),
      startsAt: inDays(1),
    } as never);
    await setStartsAt(justFinished.id, hoursAgo(1));

    // Long past, but already cancelled. A cancelled appointment was not
    // missed — somebody said so at the time.
    const cancelled = await appointmentsService.create(user.id, {
      ...validBooking({ title: 'Called off' }),
      startsAt: inDays(1),
    } as never);
    await appointmentsService.cancel(user.id, cancelled.id);
    await setStartsAt(cancelled.id, hoursAgo(48));

    const result = await appointmentsService.sweepMissed();
    expect(result.missed).toBe(0);

    const statuses = await prisma.appointment.findMany({
      where: { id: { in: [future.id, inProgress.id, justFinished.id, cancelled.id] } },
      select: { id: true, status: true },
    });
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s.status]));

    expect(byId[future.id]).toBe('SCHEDULED');
    expect(byId[inProgress.id]).toBe('SCHEDULED');
    expect(byId[justFinished.id]).toBe('SCHEDULED');
    expect(byId[cancelled.id]).toBe('CANCELLED');
  });

  it('sweeps a CONFIRMED appointment too', async () => {
    const user = await createUser();
    const appointment = await appointmentsService.create(user.id, {
      ...validBooking(),
      startsAt: inDays(1),
    } as never);

    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CONFIRMED' },
    });
    await setStartsAt(appointment.id, hoursAgo(12));

    expect((await appointmentsService.sweepMissed()).missed).toBe(1);
    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status,
    ).toBe('MISSED');
  });

  /**
   * The claim, under contention.
   *
   * Two sweeps at once is the real deployment: the scheduler runs on every
   * worker process. If the claim were a read followed by a write, both would
   * see the same SCHEDULED rows and both would count them.
   */
  it('never lets two concurrent sweeps claim the same appointment', async () => {
    const user = await createUser();

    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const appointment = await appointmentsService.create(user.id, {
        ...validBooking({ title: `Overdue ${i}` }),
        startsAt: inDays(1),
      } as never);
      await setStartsAt(appointment.id, hoursAgo(12 + i));
      ids.push(appointment.id);
    }

    const [first, second] = await Promise.all([
      appointmentsService.sweepMissed(),
      appointmentsService.sweepMissed(),
    ]);

    // Between them they took each appointment exactly once — never twice, and
    // never fewer than all of them.
    expect(first.missed + second.missed).toBe(6);

    const missed = await prisma.appointment.count({
      where: { id: { in: ids }, status: 'MISSED' },
    });
    expect(missed).toBe(6);
  });

  it('respects the limit so one tick cannot run away with the database', async () => {
    const user = await createUser();

    for (let i = 0; i < 4; i += 1) {
      const appointment = await appointmentsService.create(user.id, {
        ...validBooking({ title: `Backlog ${i}` }),
        startsAt: inDays(1),
      } as never);
      await setStartsAt(appointment.id, hoursAgo(20 + i));
    }

    expect((await appointmentsService.sweepMissed({ limit: 2 })).missed).toBe(2);
    expect((await appointmentsService.sweepMissed({ limit: 2 })).missed).toBe(2);
    expect((await appointmentsService.sweepMissed({ limit: 2 })).missed).toBe(0);
  });
});

describe('every appointment has a Person, always', () => {
  it('leaves no row with a null or orphaned personId', async () => {
    const patient = await createUser();
    const carer = await createUser();
    await grant(patient.personId, carer.id, 'CAREGIVER');

    // A populated spread: two subjects, two bookers, and three lifecycle states.
    const own = await appointmentsService.create(carer.id, {
      ...validBooking({ title: 'Own dentist' }),
      startsAt: inDays(3),
    } as never);
    const forPatient = await appointmentsService.create(carer.id, {
      ...validBooking({ title: 'Patient cardiology', personId: patient.personId }),
      startsAt: inDays(5),
    } as never);
    const doomed = await appointmentsService.create(patient.id, {
      ...validBooking({ title: 'To be cancelled' }),
      startsAt: inDays(9),
    } as never);

    await appointmentsService.cancel(patient.id, doomed.id);
    await appointmentsService.complete(carer.id, own.id);

    // The verification query: zero appointments with a null or orphaned
    // Person reference. personId is NOT NULL in the schema, so the left join
    // is what would catch a reference pointing at nothing.
    const orphans = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
        FROM appointments a
        LEFT JOIN persons p ON p.id = a."personId"
       WHERE a."personId" IS NULL OR p.id IS NULL
    `;
    expect(Number(orphans[0].count)).toBe(0);

    // And the same for the plan rows appointments create.
    const planOrphans = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
        FROM care_plans cp
        LEFT JOIN persons p ON p.id = cp."personId"
       WHERE cp.type = 'APPOINTMENT' AND (cp."personId" IS NULL OR p.id IS NULL)
    `;
    expect(Number(planOrphans[0].count)).toBe(0);

    expect(await prisma.appointment.count()).toBe(3);
    expect(forPatient.personId).toBe(patient.personId);
  });
});
