import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';

import { env } from '@/config/env';
import { swaggerSpec } from '@/config/swagger';
import { globalRateLimiter } from '@/middleware/rate-limit.middleware';
import { globalErrorHandler, notFoundHandler } from '@/middleware/error.middleware';
import { createLogger } from '@/lib/logger';

// Route imports
import authRoutes from '@/modules/auth/auth.routes';
import healthRoutes from '@/modules/health/health.routes';
import userRoutes from '@/modules/user/user.routes';
import careRoutes from '@/modules/care/care.routes';
import dashboardRoutes from '@/modules/dashboard/dashboard.routes';
import pushRoutes from '@/modules/push/push.routes';
import medicationRoutes from '@/modules/medications/medications.routes';
import moodRoutes from '@/modules/mood/mood.routes';
import symptomRoutes from '@/modules/symptoms/symptoms.routes';
import drugDetectionRoutes from '@/modules/drug-detection/drug-detection.routes';
import usageRoutes from '@/modules/usage/usage.routes';
import motherBabyRoutes from '@/modules/mother-baby/mother-baby.routes';
import articleRoutes from '@/modules/articles/articles.routes';

const log = createLogger('app');

export const createApp = () => {
  const app = express();

  // Trust Fly.io / reverse proxy so rate limiting and client IPs work correctly
  app.set('trust proxy', 1);

  // ─────────────────────────────────────────────
  // Security middleware
  // ─────────────────────────────────────────────
  app.use(helmet());

  const corsOrigin =
    env.CORS_ORIGIN === '*'
      ? '*'
      : env.CORS_ORIGIN.split(',').map((origin) => origin.trim());

  app.use(
    cors({
      origin: corsOrigin,
      credentials: env.CORS_ORIGIN === '*' ? false : true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  // ─────────────────────────────────────────────
  // Body parsing
  // ─────────────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ─────────────────────────────────────────────
  // Global rate limiting
  // ─────────────────────────────────────────────
  app.use(globalRateLimiter);

  // ─────────────────────────────────────────────
  // Root route
  // ─────────────────────────────────────────────
  app.get('/', (_req, res) => {
    return res.status(200).json({
      success: true,
      data: {
        name: 'Vitals API',
        version: '1.0.0',
        docs: '/api-docs',
        prefix: env.API_PREFIX,
        health: `${env.API_PREFIX}/health`,
      },
      message: 'Vitals API is running',
      errorCode: null,
    });
  });

  // ─────────────────────────────────────────────
  // Swagger docs
  // ─────────────────────────────────────────────
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: 'Vitals API Docs',
      customCss: '.swagger-ui .topbar { display: none }',
    }),
  );

  log.info('Swagger docs available at /api-docs');

  // ─────────────────────────────────────────────
  // Routes
  // ─────────────────────────────────────────────
  const prefix = env.API_PREFIX;

  app.use(`${prefix}/health`, healthRoutes);
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/users`, userRoutes);
  app.use(`${prefix}/care`, careRoutes);
  app.use(`${prefix}/dashboard`, dashboardRoutes);
  app.use(`${prefix}/push`, pushRoutes);
  app.use(`${prefix}/medications`, medicationRoutes);
  app.use(`${prefix}/mood`, moodRoutes);
  app.use(`${prefix}/symptoms`, symptomRoutes);
  app.use(`${prefix}/drug-detection`, drugDetectionRoutes);
  app.use(`${prefix}/usage`, usageRoutes);
  app.use(`${prefix}/mother-baby`, motherBabyRoutes);
  app.use(`${prefix}/articles`, articleRoutes);

  // ─────────────────────────────────────────────
  // Error handling — must be last
  // ─────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(globalErrorHandler);

  return app;
};