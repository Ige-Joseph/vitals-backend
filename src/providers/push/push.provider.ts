import { createLogger } from '@/lib/logger';
import { env } from '@/config/env';
import { getFirebaseAdmin } from '@/lib/firebase';

const log = createLogger('push-provider');

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * FCM push provider — sends notifications via Firebase Admin SDK.
 * Replaces the previous web-push/VAPID stub.
 *
 * Flow: BullMQ reminder job → reminderEngine → pushProvider → Firebase Admin → FCM → device
 */
export const pushProvider = {
  /**
   * Send a push notification to a single FCM token.
   * Returns true on success, false if the token is invalid/expired (caller should delete it).
   */
  async send(fcmToken: string, payload: PushPayload): Promise<boolean> {
    const admin = getFirebaseAdmin();

    if (!admin) {
      log.warn('Firebase Admin not initialised — push skipped');
      return false;
    }

    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        webpush: {
          notification: {
            title: payload.title,
            body: payload.body,
            icon: '/icons/icon-192x192.png',
          },
          fcmOptions: {
            // Deep-link into the app when notification is tapped
            link: payload.url ?? '/',
          },
        },
      });

      return true;
    } catch (err: any) {
      // FCM error codes that mean the token is permanently invalid
      const invalidTokenCodes = [
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered',
        'messaging/invalid-argument',
      ];

      if (invalidTokenCodes.includes(err.errorInfo?.code)) {
        log.warn('FCM token invalid — should be removed', {
          code: err.errorInfo?.code,
          token: fcmToken.slice(0, 20),
        });
        return false; // Signals caller to delete this token
      }

      log.error('FCM send failed', {
        error: err.message,
        code: err.errorInfo?.code,
        token: fcmToken.slice(0, 20),
      });
      return false;
    }
  },

  /**
   * Send to all FCM tokens for a user.
   * Removes invalid tokens from DB automatically.
   * Returns counts for logging.
   */
  async sendToUserTokens(
    tokens: Array<{ id: string; token: string }>,
    payload: PushPayload,
  ): Promise<{ sent: number; failed: number; invalidTokenIds: string[] }> {
    let sent = 0;
    let failed = 0;
    const invalidTokenIds: string[] = [];

    for (const { id, token } of tokens) {
      const ok = await pushProvider.send(token, payload);
      if (ok) {
        sent++;
      } else {
        failed++;
        // Collect invalid token IDs — reminder engine will delete them
        invalidTokenIds.push(id);
      }
    }

    return { sent, failed, invalidTokenIds };
  },
};
