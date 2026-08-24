import { google } from 'googleapis';
import { env } from '@/config/env';

const oauth2Client = new google.auth.OAuth2(
  String(env.GOOGLE_CLIENT_ID),
  String(env.GOOGLE_CLIENT_SECRET),
  String(env.GOOGLE_REDIRECT_URI),
);

export const googleCalendarProvider = {
  generateAuthUrl(state: string) {
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
            scope: [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/calendar.events',
        ],
      state,
    });
  },

  /**
   * Revoke the grant at Google, not just locally.
   *
   * Deleting a CalendarIntegration row removes our copy of the tokens but
   * leaves the authorisation standing on the user's Google account — a live
   * refresh token we no longer track. Erasure and disconnect must both call
   * this. Revoking a refresh token invalidates the whole grant, including any
   * access tokens issued from it.
   *
   * Returns false rather than throwing: a grant that is already gone, or a
   * Google outage, must not block the erasure it is part of.
   */
  async revokeGrant(refreshToken: string): Promise<boolean> {
    if (!refreshToken) return false;

    try {
      await oauth2Client.revokeToken(refreshToken);
      return true;
    } catch {
      return false;
    }
  },

  async exchangeCodeForTokens(code: string) {
    const { tokens } = await oauth2Client.getToken(code);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    };
  },


    createOAuthClient(tokens: {
    accessToken: string;
    refreshToken: string;
    expiryDate: Date;
    }) {
    const client = new google.auth.OAuth2(
        String(env.GOOGLE_CLIENT_ID),
        String(env.GOOGLE_CLIENT_SECRET),
        String(env.GOOGLE_REDIRECT_URI),
    );

    client.setCredentials({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expiry_date: tokens.expiryDate.getTime(),
    });

    return client;
    },

    async createEvent(
    tokens: {
        accessToken: string;
        refreshToken: string;
        expiryDate: Date;
    },
    event: {
        title: string;
        description?: string | null;
        startsAt: Date;
        endsAt: Date;
    },
    ) {
    const auth = this.createOAuthClient(tokens);
    const calendar = google.calendar({ version: 'v3', auth });

    const response = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
        summary: event.title,
        description: event.description ?? undefined,
        start: {
            dateTime: event.startsAt.toISOString(),
        },
        end: {
            dateTime: event.endsAt.toISOString(),
        },
        reminders: {
            useDefault: true,
        },
        },
    });

    return {
        externalEventId: response.data.id!,
    };
    },


        async deleteEvent(
    tokens: {
        accessToken: string;
        refreshToken: string;
        expiryDate: Date;
    },
    externalEventId: string,
    ) {
    const auth = this.createOAuthClient(tokens);
    const calendar = google.calendar({ version: 'v3', auth });

    await calendar.events.delete({
        calendarId: 'primary',
        eventId: externalEventId,
    });

    return { deleted: true };
    },



    async getAccountEmail(accessToken: string): Promise<string | null> {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
        Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) return null;

    const data = await res.json() as { email?: string };

    return data.email ?? null;
    }

};