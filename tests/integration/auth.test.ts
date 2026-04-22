import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';

// Mock heavy infrastructure so tests run without real DB/Redis
jest.mock('@/lib/prisma', () => ({
  prisma: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    emailVerificationToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    outboxEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock('@/lib/redis', () => ({
  redisConnection: {
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
    disconnect: jest.fn(),
  },
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const app = createApp();

describe('POST /api/v1/auth/signup', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 422 for missing email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ password: 'Password1' });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 422 for weak password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'test@example.com', password: 'weak' });

    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 201 and tokens for valid input', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) =>
      fn({
        user: {
          create: jest.fn().mockResolvedValue({
            id: 'user-123',
            email: 'test@example.com',
            role: 'USER',
            planType: 'FREE',
            emailVerified: false,
            isActive: true,
          }),
        },
        emailVerificationToken: { create: jest.fn() },
        outboxEvent: { create: jest.fn() },
      }),
    );

    (mockPrisma.refreshToken.create as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'test@example.com', password: 'Password1' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data.user.emailVerified).toBe(false);
  });

  it('returns 409 for duplicate email', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'existing',
      email: 'test@example.com',
    });

    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'test@example.com', password: 'Password1' });

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('CONFLICT');
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns 401 for invalid credentials', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'Password1' });

    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/v1/health', () => {
  it('returns 200 with healthy status', async () => {
    (mockPrisma.$queryRaw as jest.Mock) = jest.fn().mockResolvedValue([]);

    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
