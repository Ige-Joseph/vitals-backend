import swaggerJsdoc from 'swagger-jsdoc';
import path from 'path';
import { env } from './env';

const isProd = env.NODE_ENV === 'production';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Vitals API',
      version: '1.0.0',
      description: 'Vitals health companion backend API documentation',
    },
    servers: [
      {
        url: `${env.API_URL}${env.API_PREFIX}`,
        description: 'Current environment',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ApiResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'Request successful' },
            data: {
              type: 'object',
              nullable: true,
            },
            errorCode: {
              type: 'string',
              nullable: true,
              example: null,
            },
          },
        },

        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'Validation error' },
            data: {
              type: 'object',
              nullable: true,
              example: null,
            },
            errorCode: {
              type: 'string',
              nullable: true,
              example: 'VALIDATION_ERROR',
            },
          },
        },

        SignupRequest: {
          type: 'object',
          required: ['firstName', 'lastName', 'email', 'password'],
          properties: {
            firstName: { type: 'string', example: 'Joseph' },
            lastName: { type: 'string', example: 'Ige' },
            email: { type: 'string', format: 'email', example: 'email@example.com' },
            password: { type: 'string', minLength: 8, example: 'Password1' },
            gender: {
              type: 'string',
              enum: ['MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY'],
              example: 'MALE',
            },
            country: { type: 'string', example: 'Nigeria' },
          },
        },

        LoginRequest: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', example: 'email@example.com' },
            password: { type: 'string', example: 'Password1' },
          },
        },

        RefreshRequest: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string', example: 'opaque-refresh-token' },
          },
        },

        AuthUser: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'uuid-string' },
            email: { type: 'string', format: 'email', example: 'email@example.com' },
            firstName: { type: 'string', example: 'Joseph' },
            lastName: { type: 'string', example: 'Ige' },
            role: { type: 'string', enum: ['USER', 'ADMIN'], example: 'USER' },
            planType: { type: 'string', enum: ['FREE', 'PREMIUM'], example: 'FREE' },
            emailVerified: { type: 'boolean', example: false },
          },
        },

        AuthResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'Login successful' },
            data: {
              type: 'object',
              properties: {
                user: { $ref: '#/components/schemas/AuthUser' },
                accessToken: { type: 'string', example: 'jwt-access-token' },
                refreshToken: { type: 'string', example: 'opaque-refresh-token' },
              },
            },
            errorCode: {
              type: 'string',
              nullable: true,
              example: null,
            },
          },
        },

        UserProfile: {
          type: 'object',
          properties: {
            gender: {
              type: 'string',
              enum: ['MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY'],
              nullable: true,
            },
            country: { type: 'string', nullable: true, example: 'Nigeria' },
            timezone: { type: 'string', example: 'Africa/Lagos' },
            selectedJourney: {
              type: 'string',
              enum: ['MEDICATION', 'PREGNANCY', 'VACCINATION'],
              nullable: true,
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: isProd
    ? [path.join(process.cwd(), 'dist/modules/**/*.routes.js')]
    : [path.join(process.cwd(), 'src/modules/**/*.routes.ts')],
};

export const swaggerSpec = swaggerJsdoc(options);