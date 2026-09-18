import {
  resolveOccurrence,
  targetInstantFor,
  resolveTimeZone,
} from '@/modules/medications/schedule-reconciliation';

/**
 * The occurrence-identity derivation, in isolation.
 *
 * This is the part of reconciliation that decides *what the user meant*, and
 * getting it wrong would move a dose to the wrong day. It reads only persisted
 * fields, so it is testable without a database — but note that passing here is
 * not evidence the reconciliation is safe to run. That needs the Postgres
 * suite in tests/db, which asserts the actual writes.
 */

const event = (isoString: string, metadata: unknown) => ({
  scheduledFor: new Date(isoString),
  metadata,
});

const clockAt = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);

describe('resolveOccurrence — recovering what the user asked for', () => {
  it('recovers date and time from a UTC-generated row', () => {
    // A UTC server wrote "08:00" as 08:00Z.
    const result = resolveOccurrence(event('2026-06-15T08:00:00.000Z', { time: '08:00' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.identity.time).toBe('08:00');
    expect(result.identity.localDate).toEqual({ year: 2026, month: 6, day: 15 });
    expect(result.identity.generatedOffsetMinutes).toBe(0);
  });

  it('recovers date and time from a Lagos-generated row', () => {
    // A Lagos server (UTC+1) wrote "08:00" as 07:00Z.
    const result = resolveOccurrence(event('2026-06-15T07:00:00.000Z', { time: '08:00' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.identity.localDate).toEqual({ year: 2026, month: 6, day: 15 });
    expect(result.identity.generatedOffsetMinutes).toBe(60);
  });

  it('recovers the date when the generating zone was behind UTC', () => {
    // New York in summer (UTC-4) wrote "08:00" as 12:00Z.
    const result = resolveOccurrence(event('2026-06-15T12:00:00.000Z', { time: '08:00' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.identity.localDate).toEqual({ year: 2026, month: 6, day: 15 });
    expect(result.identity.generatedOffsetMinutes).toBe(-240);
  });

  it('keeps the right calendar day for a late dose that crosses midnight in UTC', () => {
    // 23:00 on a UTC-5 server is 04:00Z the *next* day. The date must come
    // back as the 15th, not the 16th.
    const result = resolveOccurrence(event('2026-06-16T04:00:00.000Z', { time: '23:00' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.identity.localDate).toEqual({ year: 2026, month: 6, day: 15 });
    expect(result.identity.generatedOffsetMinutes).toBe(-300);
  });

  it('keeps the right calendar day for an early dose on a zone ahead of UTC', () => {
    // 06:00 on a UTC+8 server is 22:00Z the *previous* day.
    const result = resolveOccurrence(event('2026-06-14T22:00:00.000Z', { time: '06:00' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.identity.localDate).toEqual({ year: 2026, month: 6, day: 15 });
    expect(result.identity.generatedOffsetMinutes).toBe(480);
  });

  it('handles a non-default custom time', () => {
    const result = resolveOccurrence(event('2026-06-15T21:45:00.000Z', { time: '22:45' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.identity.time).toBe('22:45');
    expect(result.identity.generatedOffsetMinutes).toBe(60);
  });

  it('normalises a single-digit hour', () => {
    const result = resolveOccurrence(event('2026-06-15T09:00:00.000Z', { time: '9:00' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.time).toBe('09:00');
  });
});

describe('resolveOccurrence — refuses rather than guesses', () => {
  it('skips a row with no time in metadata', () => {
    const result = resolveOccurrence(
      event('2026-06-15T08:00:00.000Z', { medicationName: 'Metformin' }),
    );

    expect(result).toEqual({ ok: false, reason: 'NO_METADATA_TIME' });
  });

  it('skips a row with empty metadata', () => {
    expect(resolveOccurrence(event('2026-06-15T08:00:00.000Z', {}))).toEqual({
      ok: false,
      reason: 'NO_METADATA_TIME',
    });
  });

  it('skips a row with null metadata', () => {
    expect(resolveOccurrence(event('2026-06-15T08:00:00.000Z', null))).toEqual({
      ok: false,
      reason: 'NO_METADATA_TIME',
    });
  });

  it.each([['8am'], ['25:00'], ['08:99'], [''], [123], [null]])(
    'skips malformed time %p',
    (time) => {
      const result = resolveOccurrence(event('2026-06-15T08:00:00.000Z', { time }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(['MALFORMED_TIME', 'NO_METADATA_TIME']).toContain(result.reason);
    },
  );

  it('refuses a residue that two real zones could both explain', () => {
    // Residue +13:00: a Pacific server at UTC+13, or one at UTC-11. The two
    // imply different calendar dates, so the occurrence is not recoverable.
    const result = resolveOccurrence(event('2026-06-15T19:00:00.000Z', { time: '08:00' }));

    expect(result).toEqual({ ok: false, reason: 'AMBIGUOUS_OFFSET' });
  });

  it('accepts the boundary just outside the ambiguous band', () => {
    // Residue +11:00 — only one real zone fits.
    const result = resolveOccurrence(event('2026-06-15T21:00:00.000Z', { time: '08:00' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.generatedOffsetMinutes).toBe(660);
  });
});

describe('targetInstantFor — where the dose belongs now', () => {
  const identity = {
    time: '08:00',
    localDate: { year: 2026, month: 6, day: 15 },
    generatedOffsetMinutes: 0,
  };

  it('resolves against Lagos', () => {
    const target = targetInstantFor(identity, 'Africa/Lagos');
    expect(target.toISOString()).toBe('2026-06-15T07:00:00.000Z');
    expect(clockAt(target, 'Africa/Lagos')).toBe('08:00');
  });

  it('resolves against a DST zone in summer', () => {
    const target = targetInstantFor(identity, 'America/New_York');
    expect(target.toISOString()).toBe('2026-06-15T12:00:00.000Z');
    expect(clockAt(target, 'America/New_York')).toBe('08:00');
  });

  it('resolves against the same DST zone in winter', () => {
    const target = targetInstantFor(
      { ...identity, localDate: { year: 2026, month: 1, day: 15 } },
      'America/New_York',
    );

    expect(target.toISOString()).toBe('2026-01-15T13:00:00.000Z');
    expect(clockAt(target, 'America/New_York')).toBe('08:00');
  });
});

describe('round trip is idempotent', () => {
  it.each([
    ['Africa/Lagos', '08:00'],
    ['Africa/Lagos', '23:30'],
    ['America/New_York', '08:00'],
    ['America/New_York', '00:15'],
  ])('%s @ %s settles after one pass', (timeZone, time) => {
    // Start from a UTC-server row — the shape the bug produced.
    const first = resolveOccurrence(
      event(`2026-06-15T${time}:00.000Z`, { time }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const corrected = targetInstantFor(first.identity, timeZone);

    // Feed the corrected row back in, exactly as a second run would.
    const second = resolveOccurrence({
      scheduledFor: corrected,
      metadata: { time },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.identity.localDate).toEqual(first.identity.localDate);
    expect(targetInstantFor(second.identity, timeZone).getTime()).toBe(
      corrected.getTime(),
    );
  });

  it('a row already correct is left exactly where it is', () => {
    const already = new Date('2026-06-15T07:00:00.000Z'); // 08:00 Lagos
    const result = resolveOccurrence({ scheduledFor: already, metadata: { time: '08:00' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(targetInstantFor(result.identity, 'Africa/Lagos').getTime()).toBe(
      already.getTime(),
    );
  });
});

describe('resolveTimeZone', () => {
  it('takes a valid zone as given', () => {
    expect(resolveTimeZone('America/New_York')).toBe('America/New_York');
  });

  it.each([[null], [undefined], [''], ['   '], ['Not/AZone']])(
    'falls back to the column default for %p',
    (raw) => {
      expect(resolveTimeZone(raw as any)).toBe('Africa/Lagos');
    },
  );
});
