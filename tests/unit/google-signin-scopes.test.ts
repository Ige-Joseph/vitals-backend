/**
 * The scope boundary between the two Google flows.
 *
 * This is the test that would catch the failure mode worth caring about: a
 * sign-in that quietly comes back holding calendar write access, because
 * somebody reused the calendar client or copied its scope array. It exercises
 * the real provider rather than a mock — a mocked `generateAuthUrl` would
 * happily assert whatever it was told to return.
 */

process.env.GOOGLE_AUTH_REDIRECT_URI =
  process.env.GOOGLE_AUTH_REDIRECT_URI ?? 'http://localhost:3000/api/v1/auth/google/callback';

import {
  googleIdentityProvider,
  FORBIDDEN_SIGN_IN_SCOPES,
} from '@/providers/auth/google-identity.provider';
import { googleCalendarProvider } from '@/providers/calendar/google-calendar.provider';

const scopesIn = (url: string): string[] => {
  const scope = new URL(url).searchParams.get('scope') ?? '';
  return scope.split(/[\s+]+/).filter(Boolean);
};

describe('Google Sign-In scopes', () => {
  const url = googleIdentityProvider.generateAuthUrl('state-token');

  it('requests only identity scopes', () => {
    expect(scopesIn(url).sort()).toEqual(['email', 'openid', 'profile']);
  });

  it.each(FORBIDDEN_SIGN_IN_SCOPES)('never requests %s', (forbidden) => {
    expect(url).not.toContain(encodeURIComponent(forbidden));
    expect(scopesIn(url)).not.toContain(forbidden);
  });

  it('does not ask for offline access — nothing calls Google again after login', () => {
    expect(new URL(url).searchParams.get('access_type')).not.toBe('offline');
  });

  it('carries the state it was given', () => {
    expect(new URL(url).searchParams.get('state')).toBe('state-token');
  });
});

describe('Google Calendar authorization is unchanged', () => {
  const url = googleCalendarProvider.generateAuthUrl('calendar-state');

  it('still requests calendar.events', () => {
    expect(scopesIn(url)).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it('still requests offline access so it can sync later', () => {
    expect(new URL(url).searchParams.get('access_type')).toBe('offline');
  });

  it('uses a different redirect URI from sign-in', () => {
    const calendarRedirect = new URL(url).searchParams.get('redirect_uri');
    const signInRedirect = new URL(
      googleIdentityProvider.generateAuthUrl('x'),
    ).searchParams.get('redirect_uri');

    expect(calendarRedirect).not.toBe(signInRedirect);
  });
});
