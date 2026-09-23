/**
 * Wall-clock time in a named timezone, resolved to an instant.
 *
 * A medication schedule is written in wall-clock terms — "08:00 and 20:00" —
 * and stored as instants. Turning one into the other needs the offset that
 * applied *on that date in that place*, which is not a constant: it changes at
 * DST boundaries and, occasionally, when a country changes its rules.
 *
 * `new Date(y, m, d, hh, mm)` uses the offset of whatever machine happens to be
 * running, which is how a Lagos user's 08:00 dose became 09:00 on a UTC server.
 * A fixed offset stored per user would be no better: it would be right in
 * January and an hour wrong in July for every zone that observes DST.
 *
 * So the offset is looked up from the IANA database through `Intl`, which is
 * built into Node and always current with the host's tzdata. No dependency,
 * and nothing to keep in sync.
 */

/**
 * Used when an account has no Profile row at all — signup only creates one when
 * gender or country was supplied, so a bare account has none.
 *
 * This is the same value as `Profile.timezone`'s column default, deliberately:
 * an account without the row should be treated as if it had the row it would
 * have been given. Keep the two in step.
 */
export const DEFAULT_TIMEZONE = 'Africa/Lagos';

/**
 * How far ahead of UTC `timeZone` was at the given instant, in milliseconds.
 *
 * Works by asking Intl what the local wall-clock reading was at that instant,
 * reinterpreting those digits as if they were UTC, and taking the difference.
 */
const offsetMsAt = (instant: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): number => {
    const value = parts.find((p) => p.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };

  // Some ICU versions render midnight as hour 24 rather than 0.
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );

  return asIfUtc - instant.getTime();
};

/** Whether Intl recognises the zone. An unknown name makes the formatter throw. */
export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

/**
 * The instant at which the clock in `timeZone` reads the given local time.
 *
 * Two passes, because the offset depends on the answer we are computing. The
 * first guess uses the offset around the naive UTC reading; if the true instant
 * turns out to sit on the far side of a DST transition, the offset there is
 * different and the guess is corrected once. A second correction is never
 * needed — transitions are at least an hour apart and offsets shift by at most
 * a couple of hours.
 *
 * The two awkward cases, both handled by consequence rather than by a special
 * case:
 *
 *  - **Spring forward.** 02:30 does not exist on the day the clocks skip from
 *    02:00 to 03:00. This returns the instant that reads 03:30 — the dose
 *    happens, an hour later by the wall clock, rather than vanishing. For a
 *    medication reminder, firing late beats not firing.
 *  - **Fall back.** 01:30 happens twice. This returns the first, which is the
 *    earlier of the two instants. The dose fires once, on the first pass.
 */
export const zonedWallClockToUtc = (
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date => {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);

  // First guess: the offset in force around the naive reading.
  const firstGuess = naive - offsetMsAt(new Date(naive), timeZone);

  // Corrected guess: if the true instant sits on the far side of a transition,
  // the offset there is the one that actually applies.
  const corrected = naive - offsetMsAt(new Date(firstGuess), timeZone);

  // Does the corrected instant actually read back as the time we were asked
  // for? For every ordinary time it does. For a time inside a spring-forward
  // gap it cannot — no instant reads 02:30 on a day that skips 02:00 to 03:00 —
  // and the correction lands an hour *before* the gap instead of after it.
  //
  // So the round trip is the test for "this local time does not exist", and
  // the uncorrected first guess is the forward-shifted answer: 02:30 becomes
  // 03:30. A dose that happens an hour late beats one that silently does not
  // happen.
  const roundTrips = corrected + offsetMsAt(new Date(corrected), timeZone) === naive;

  return new Date(roundTrips ? corrected : firstGuess);
};

/**
 * The calendar date showing on a clock in `timeZone` at the given instant.
 *
 * Day boundaries belong to the subject's zone too: a plan that starts "today"
 * for a user in Lagos starts on Lagos's today, not the server's.
 */
export const zonedDateParts = (
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);

  return { year: read('year'), month: read('month'), day: read('day') };
};

/** Advance a calendar date by whole days, without touching a clock. */
export const addDays = (
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } => {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day));
  d.setUTCDate(d.getUTCDate() + days);

  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
};

/** Ordering helper for calendar dates, avoiding any instant conversion. */
export const compareDateParts = (
  a: { year: number; month: number; day: number },
  b: { year: number; month: number; day: number },
): number =>
  a.year - b.year || a.month - b.month || a.day - b.day;
