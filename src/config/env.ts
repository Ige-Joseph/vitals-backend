import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_PREFIX: z.string().default('/api/v1'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis
  UPSTASH_REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().min(1, 'REDIS_HOST is required'),
  REDIS_PORT: z.coerce.number().default(6380),
  REDIS_PASSWORD: z.string().min(1, 'REDIS_PASSWORD is required'),
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

  // AI
  GEMINI_API_KEY: z.string().optional(),

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

  // Reminder settings
  ADHERENCE_CHECK_DELAY_MS: z.coerce.number().default(1800000),
  MISSED_WINDOW_MS: z.coerce.number().default(7200000),

  // Token expiry
  EMAIL_VERIFICATION_TOKEN_EXPIRES_HOURS: z.coerce.number().default(24),
  PASSWORD_RESET_TOKEN_EXPIRES_HOURS: z.coerce.number().default(1),
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