import * as admin from 'firebase-admin';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('firebase');

let app: admin.app.App | null = null;

/**
 * Initialise Firebase Admin SDK once on startup.
 * Credentials come from environment variables — never hardcoded.
 * Call this from server.ts and worker.ts at startup.
 *
 * Required env vars:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY  (include the \n characters — paste the full private key)
 */
export const initFirebase = (): void => {
  if (app) return; // Already initialised

  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    log.warn(
      'Firebase credentials not configured — push notifications will be skipped. ' +
      'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY to enable.',
    );
    return;
  }

  try {
    app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        // FIREBASE_PRIVATE_KEY is stored with literal \n in env — replace them
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });

    log.info('Firebase Admin initialised', { projectId: env.FIREBASE_PROJECT_ID });
  } catch (err: any) {
    log.error('Firebase Admin initialisation failed', { error: err.message });
  }
};

/**
 * Returns the initialised Firebase Admin app, or null if not configured.
 * Used by push provider — null means push is silently skipped.
 */
export const getFirebaseAdmin = (): admin.app.App | null => app;
