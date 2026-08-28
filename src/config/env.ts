import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z
  .object({
    // Server
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3000),
    API_PREFIX: z.string().default('/api/v1'),

    // Database
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // Redis
    UPSTASH_REDIS_URL: z.string().optional(),
    REDIS_HOST: z.string().optional(),
    REDIS_PORT: z.coerce.number().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_TLS: z.coerce.boolean().default(true),

    // JWT
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

    // Email
    BREVO_API_KEY: z.string().min(1, 'BREVO_API_KEY is required'),
    BREVO_FROM_EMAIL: z.string().email('BREVO_FROM_EMAIL must be a valid email'),
    BREVO_FROM_NAME: z.string().min(1, 'BREVO_FROM_NAME is required'),

    // URLs
    FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL'),
    API_URL: z.string().url('API_URL must be a valid URL'),
    CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN is required'),

    // AI - Gemini
    GEMINI_API_KEY: z.string().optional(),

    // AI (AssemblyAI)
    ASSEMBLYAI_API_KEY: z.string().optional(),
    ASSEMBLYAI_BASE_URL: z.string().url().default('https://api.assemblyai.com'),

    // Storage
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),

    // Firebase FCM
    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),
    VAPID_PUBLIC_KEY: z.string().optional(),

    // Rate limiting
    RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
    RATE_LIMIT_MAX: z.coerce.number().default(100),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().default(10),

    // AI Quotas
    FREE_SYMPTOM_CHECKS_PER_DAY: z.coerce.number().default(3),
    FREE_DRUG_DETECTIONS_PER_DAY: z.coerce.number().default(3),
    PREMIUM_SYMPTOM_CHECKS_PER_DAY: z.coerce.number().default(20),
    PREMIUM_DRUG_DETECTIONS_PER_DAY: z.coerce.number().default(20),

    // Paystack. Optional: the adapter only registers when a key is present,
    // so an environment without one simply has no provider configured.
    PAYSTACK_SECRET_KEY: z.string().optional(),
    PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
    /// Failed billing events older than this are dead-lettered.
    BILLING_EVENT_MAX_ATTEMPTS: z.coerce.number().default(5),

    // Worker concurrency
    //
    // How many jobs each worker runs at once, in a process that also serves the
    // API. The defaults suit a multi-core host and are deliberately unchanged;
    // the reason they are settings at all is the 1 OCPU deployment target,
    // where 15 concurrent job slots on one core means jobs competing with
    // requests for the only event loop there is.
    //
    // Lower these together with nothing else: they do not change what runs,
    // only how much of it runs at once.
    WORKER_CONCURRENCY_NOTIFICATIONS: z.coerce.number().int().positive().default(5),
    WORKER_CONCURRENCY_BILLING: z.coerce.number().int().positive().default(5),
    WORKER_CONCURRENCY_ADHERENCE: z.coerce.number().int().positive().default(3),
    /// Rendering is the most CPU-hungry job there is. Raising this above 1 on a
    /// shared-process deployment is how you stall the API.
    WORKER_CONCURRENCY_REPORTS: z.coerce.number().int().positive().default(1),

    // Reports
    //
    // Health summaries are rendered by a worker and held as a file until the
    // reader fetches them. Both settings bound how long one Person's whole
    // record sits outside the tables that own it, so they are deliberately
    // short: the document is a hand-off, not an archive.
    //
    // The directory is not persisted across container restarts on purpose. A
    // lost file costs a regeneration; a file surviving a restart is a health
    // record outliving the process that was accountable for deleting it.
    REPORT_STORAGE_DIR: z.string().default('/tmp/vitals-reports'),
    /// How long a rendered summary stays fetchable before the sweep deletes it.
    REPORT_TTL_MINUTES: z.coerce.number().int().positive().default(60),
    /// How often the sweep looks for expired documents.
    REPORT_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(300000),

    // Billing
    // How long a failed renewal keeps Premium. Runs from the failed charge,
    // not from the period end.
    SUBSCRIPTION_PAST_DUE_GRACE_DAYS: z.coerce.number().default(7),
    // How often reconciliation compares our state against the provider's.
    BILLING_RECONCILE_INTERVAL_MS: z.coerce.number().default(3600000),

    // Reminder settings
    ADHERENCE_CHECK_DELAY_MS: z.coerce.number().default(1800000),
    MISSED_WINDOW_MS: z.coerce.number().default(7200000),

    /**
     * How long after an appointment has finished before it counts as missed.
     *
     * Measured from the end — `startsAt` plus its own duration — not from the
     * start, because an appointment in progress has not been missed and a long
     * one would otherwise be marked missed while the patient was still in the
     * room. Two hours past the end, by default.
     */
    APPOINTMENT_MISSED_GRACE_MS: z.coerce.number().default(7200000),
    /** How often the sweep runs. */
    APPOINTMENT_SWEEP_INTERVAL_MS: z.coerce.number().default(900000),

    // Token expiry
    EMAIL_VERIFICATION_TOKEN_EXPIRES_HOURS: z.coerce.number().default(24),
    PASSWORD_RESET_TOKEN_EXPIRES_HOURS: z.coerce.number().default(1),

    // Google OAuth (for calendar integration)
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_REDIRECT_URI: z.string().url(),
  })
  .superRefine((data, ctx) => {
    const hasUpstashUrl = !!data.UPSTASH_REDIS_URL;
    const hasManualRedis =
      !!data.REDIS_HOST &&
      !!data.REDIS_PORT &&
      !!data.REDIS_PASSWORD;

    if (!hasUpstashUrl && !hasManualRedis) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide either UPSTASH_REDIS_URL or REDIS_HOST + REDIS_PORT + REDIS_PASSWORD',
        path: ['UPSTASH_REDIS_URL'],
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;