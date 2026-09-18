import { generateMedicationSchedule } from '@/modules/medications/medications.scheduler';
import { zonedWallClockToUtc, isValidTimeZone } from '@/lib/timezone';

/**
 * Doses are written in wall-clock terms and stored as instants.
 *
 * Every assertion below reads the stored instant *back* through the target
 * zone and checks the clock reading, because that is the thing the user set.
 * Asserting on the UTC hour instead would encode one particular server zone
 * into the tests and pass for the wrong reason.
 */

/** What a clock in `timeZone` reads at `instant`, as "HH:MM". */
const clockAt = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);

/** The calendar date a clock in `timeZone` shows at `instant`, as YYYY-MM-DD. */
const dateAt = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

const base = {
  medicationName: 'Metformin',
  dosage: '500mg',
  instructions: undefined,
};

describe('zonedWallClockToUtc', () => {
  it('resolves a Lagos wall clock to the right instant (UTC+1, no DST)', () => {
    const instant = zonedWallClockToUtc(
      { year: 2026, month: 6, day: 15, hour: 8, minute: 0 },
      'Africa/Lagos',
    );

    expect(instant.toISOString()).toBe('2026-06-15T07:00:00.000Z');
    expect(clockAt(instant, 'Africa/Lagos')).toBe('08:00');
  });

  it('resolves New York in winter (EST, UTC-5)', () => {
    const instant = zonedWallClockToUtc(
      { year: 2026, month: 1, day: 15, hour: 8, minute: 0 },
      'America/New_York',
    );

    expect(instant.toISOString()).toBe('2026-01-15T13:00:00.000Z');
    expect(clockAt(instant, 'America/New_York')).toBe('08:00');
  });

  it('resolves New York in summer (EDT, UTC-4)', () => {
    const instant = zonedWallClockToUtc(
      { year: 2026, month: 7, day: 15, hour: 8, minute: 0 },
      'America/New_York',
    );

    expect(instant.toISOString()).toBe('2026-07-15T12:00:00.000Z');
    expect(clockAt(instant, 'America/New_York')).toBe('08:00');
  });

  it('pushes a time inside the spring-forward gap forward rather than dropping it', () => {
    // 2026-03-08: New York skips 02:00 → 03:00. 02:30 never happens.
    const instant = zonedWallClockToUtc(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      'America/New_York',
    );

    // The dose still exists, an hour later by the clock. For a medication
    // reminder, firing late beats not firing.
    expect(clockAt(instant, 'America/New_York')).toBe('03:30');
  });

  it('takes the first of an ambiguous fall-back hour', () => {
    // 2026-11-01: New York repeats 01:00–02:00. 01:30 happens twice.
    const instant = zonedWallClockToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      'America/New_York',
    );

    expect(clockAt(instant, 'America/New_York')).toBe('01:30');
    // The earlier of the two, i.e. still on EDT (UTC-4).
    expect(instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('recognises real zones and rejects nonsense', () => {
    expect(isValidTimeZone('Africa/Lagos')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('generateMedicationSchedule — Africa/Lagos', () => {
  const schedule = generateMedicationSchedule({
    ...base,
    frequency: 'TWICE_DAILY',
    startDate: new Date('2026-06-15'),
    endDate: new Date('2026-06-17'),
    timeZone: 'Africa/Lagos',
  });

  it('produces two doses per day across the range', () => {
    expect(schedule).toHaveLength(6);
  });

  it('keeps 08:00 and 20:00 on the Lagos clock regardless of server zone', () => {
    const clocks = schedule.map((d) => clockAt(d.scheduledFor, 'Africa/Lagos'));
    expect(new Set(clocks)).toEqual(new Set(['08:00', '20:00']));
  });

  it('stores 08:00 Lagos as 07:00Z, not 08:00Z', () => {
    const first = schedule[0].scheduledFor;
    expect(first.toISOString()).toBe('2026-06-15T07:00:00.000Z');
  });

  it('keeps each dose on the calendar day the user chose', () => {
    const days = schedule.map((d) => dateAt(d.scheduledFor, 'Africa/Lagos'));
    expect(new Set(days)).toEqual(
      new Set(['2026-06-15', '2026-06-16', '2026-06-17']),
    );
  });
});

describe('generateMedicationSchedule — DST boundary in America/New_York', () => {
  // 2026-03-08 is the spring-forward date. The range brackets it.
  const schedule = generateMedicationSchedule({
    ...base,
    frequency: 'ONCE_DAILY',
    startDate: new Date('2026-03-06'),
    endDate: new Date('2026-03-10'),
    timeZone: 'America/New_York',
  });

  it('holds the local clock time constant across the transition', () => {
    const clocks = schedule.map((d) => clockAt(d.scheduledFor, 'America/New_York'));
    expect(clocks).toEqual(['08:00', '08:00', '08:00', '08:00', '08:00']);
  });

  it('shifts the underlying UTC instant by an hour once DST begins', () => {
    const utcHours = schedule.map((d) => d.scheduledFor.getUTCHours());

    // 6th and 7th are EST (UTC-5) → 13:00Z. 8th onward are EDT (UTC-4) → 12:00Z.
    expect(utcHours).toEqual([13, 13, 12, 12, 12]);
  });

  it('does not skip or duplicate a day across the transition', () => {
    const days = schedule.map((d) => dateAt(d.scheduledFor, 'America/New_York'));
    expect(days).toEqual([
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
  });

  it('holds across the autumn transition too', () => {
    // 2026-11-01 is the fall-back date.
    const autumn = generateMedicationSchedule({
      ...base,
      frequency: 'ONCE_DAILY',
      startDate: new Date('2026-10-30'),
      endDate: new Date('2026-11-03'),
      timeZone: 'America/New_York',
    });

    const clocks = autumn.map((d) => clockAt(d.scheduledFor, 'America/New_York'));
    expect(clocks).toEqual(['08:00', '08:00', '08:00', '08:00', '08:00']);

    // EDT (UTC-4) → 12:00Z, then EST (UTC-5) → 13:00Z from 1 November.
    expect(autumn.map((d) => d.scheduledFor.getUTCHours())).toEqual([12, 12, 13, 13, 13]);
  });
});

describe('generateMedicationSchedule — configured times are preserved', () => {
  it('uses the ONCE_DAILY default of 08:00', () => {
    const [dose] = generateMedicationSchedule({
      ...base,
      frequency: 'ONCE_DAILY',
      startDate: new Date('2026-06-15'),
      endDate: new Date('2026-06-15'),
      timeZone: 'Africa/Lagos',
    });

    expect(clockAt(dose.scheduledFor, 'Africa/Lagos')).toBe('08:00');
  });

  it('uses the THREE_TIMES_DAILY defaults of 08:00 / 14:00 / 20:00', () => {
    const doses = generateMedicationSchedule({
      ...base,
      frequency: 'THREE_TIMES_DAILY',
      startDate: new Date('2026-06-15'),
      endDate: new Date('2026-06-15'),
      timeZone: 'Africa/Lagos',
    });

    expect(doses.map((d) => clockAt(d.scheduledFor, 'Africa/Lagos'))).toEqual([
      '08:00',
      '14:00',
      '20:00',
    ]);
  });

  it('uses customTimes exactly, in the subject zone', () => {
    const doses = generateMedicationSchedule({
      ...base,
      frequency: 'TWICE_DAILY',
      customTimes: ['06:45', '22:15'],
      startDate: new Date('2026-06-15'),
      endDate: new Date('2026-06-15'),
      timeZone: 'America/New_York',
    });

    expect(doses.map((d) => clockAt(d.scheduledFor, 'America/New_York'))).toEqual([
      '06:45',
      '22:15',
    ]);
  });

  it('does not shift the start date for a zone behind UTC', () => {
    // The classic off-by-one: YYYY-MM-DD parsed to UTC midnight, then read
    // with local getters on a machine behind UTC, lands on the previous day.
    const [dose] = generateMedicationSchedule({
      ...base,
      frequency: 'ONCE_DAILY',
      startDate: new Date('2026-06-15'),
      endDate: new Date('2026-06-15'),
      timeZone: 'America/New_York',
    });

    expect(dateAt(dose.scheduledFor, 'America/New_York')).toBe('2026-06-15');
  });
});
