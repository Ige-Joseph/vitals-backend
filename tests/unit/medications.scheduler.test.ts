import { generateMedicationSchedule } from '@/modules/medications/medications.scheduler';
import { MAX_SCHEDULE_DAYS } from '@/config/medication.config';

// Date-only values, built at UTC midnight because that is what the API
// produces: `startDate` arrives as "YYYY-MM-DD" and `new Date(str)` parses a
// bare date as UTC. The scheduler reads the UTC components for exactly that
// reason, so a fixture built at *local* midnight would be a day out for any
// machine ahead of UTC and would not match production input.
const utcMidnight = (offsetDays: number): Date => {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetDays),
  );
};

const tomorrow = utcMidnight(1);

const in7Days = utcMidnight(7);

const baseInput = {
  medicationName: 'Paracetamol',
  dosage: '500mg',
  startDate: tomorrow, // tomorrow so all doses are future
  endDate: in7Days,
  // Doses are wall-clock times and now need a zone to become instants.
  // Timezone behaviour itself is covered in medications.timezone.test.ts;
  // these cases are about dose counts and shape.
  timeZone: 'Africa/Lagos',
};

describe('generateMedicationSchedule', () => {
  it('generates correct dose count for ONCE_DAILY over 7 days', () => {
    const result = generateMedicationSchedule({ ...baseInput, frequency: 'ONCE_DAILY' });
    // 7 days inclusive: tomorrow through in7Days = 7 doses
    expect(result.length).toBeGreaterThanOrEqual(6);
    expect(result.length).toBeLessThanOrEqual(7);
  });

  it('generates double the doses for TWICE_DAILY', () => {
    const once = generateMedicationSchedule({ ...baseInput, frequency: 'ONCE_DAILY' });
    const twice = generateMedicationSchedule({ ...baseInput, frequency: 'TWICE_DAILY' });
    expect(twice.length).toBe(once.length * 2);
  });

  it('uses custom times when provided', () => {
    const result = generateMedicationSchedule({
      ...baseInput,
      frequency: 'TWICE_DAILY',
      customTimes: ['09:00', '21:00'],
    });

    // Read back through the schedule's own zone, not the server's. Using
    // getHours() here asserted that a dose lands at the configured hour *on
    // the machine running the test*, which is the bug the timezone fix
    // removed: it passed only while the server happened to sit in the same
    // zone as the user.
    const hours = result.map((d) =>
      Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: baseInput.timeZone,
          hour12: false,
          hour: '2-digit',
        }).format(d.scheduledFor),
      ),
    );

    expect(hours).toContain(9);
    expect(hours).toContain(21);
  });

  it('all generated doses have MEDICATION_DOSE event type', () => {
    const result = generateMedicationSchedule({ ...baseInput, frequency: 'ONCE_DAILY' });
    result.forEach((dose) => expect(dose.eventType).toBe('MEDICATION_DOSE'));
  });

  it('all generated doses have correct title', () => {
    const result = generateMedicationSchedule({ ...baseInput, frequency: 'ONCE_DAILY' });
    result.forEach((dose) => expect(dose.title).toBe('Take Paracetamol'));
  });

  it('clamps to MAX_SCHEDULE_DAYS for very long durations', () => {
    const farFuture = new Date(tomorrow);
    farFuture.setFullYear(farFuture.getFullYear() + 5);

    const result = generateMedicationSchedule({
      ...baseInput,
      frequency: 'ONCE_DAILY',
      endDate: farFuture,
    });

    expect(result.length).toBe(MAX_SCHEDULE_DAYS);
  });

  it('all scheduled doses are in the future', () => {
    const now = new Date();
    const result = generateMedicationSchedule({ ...baseInput, frequency: 'TWICE_DAILY' });
    result.forEach((dose) => {
      expect(dose.scheduledFor.getTime()).toBeGreaterThan(now.getTime());
    });
  });
});
