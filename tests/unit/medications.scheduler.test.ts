import { generateMedicationSchedule } from '@/modules/medications/medications.scheduler';
import { MAX_SCHEDULE_DAYS } from '@/config/medication.config';

const today = new Date();
today.setHours(0, 0, 0, 0);

const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);

const in7Days = new Date(today);
in7Days.setDate(in7Days.getDate() + 7);

const baseInput = {
  medicationName: 'Paracetamol',
  dosage: '500mg',
  startDate: tomorrow, // tomorrow so all doses are future
  endDate: in7Days,
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

    const hours = result.map((d) => d.scheduledFor.getHours());
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
