import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import jwt from 'jsonwebtoken';

jest.mock('@/lib/prisma', () => ({
  prisma: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    careEvent: { findMany: jest.fn().mockResolvedValue([]) },
    activityLog: { findMany: jest.fn().mockResolvedValue([]) },
    dailyUsage: { findUnique: jest.fn().mockResolvedValue(null) },
    moodLog: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}));

jest.mock('@/lib/redis', () => ({
  redisConnection: { ping: jest.fn(), on: jest.fn(), disconnect: jest.fn() },
}));

const app = createApp();

const makeToken = () =>
  jwt.sign(
    { sub: 'user-1', email: 'u@example.com', role: 'USER', planType: 'FREE', emailVerified: true },
    process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-minimum-32-characters-long',
    { expiresIn: '15m' },
  );

describe('GET /api/v1/dashboard', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/v1/dashboard');
    expect(res.status).toBe(401);
  });

  it('returns 200 with aggregated dashboard shape', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('todayTasks');
    expect(res.body.data).toHaveProperty('upcomingReminders');
    expect(res.body.data).toHaveProperty('recentActivity');
    expect(res.body.data).toHaveProperty('usageSummary');
    expect(res.body.data).toHaveProperty('latestMoodInsight');
  });

  it('usageSummary has correct structure', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard')
      .set('Authorization', `Bearer ${makeToken()}`);

    const { usageSummary } = res.body.data;
    expect(usageSummary).toHaveProperty('symptomChecksUsed');
    expect(usageSummary).toHaveProperty('symptomChecksLimit');
    expect(usageSummary).toHaveProperty('drugDetectionsUsed');
    expect(usageSummary).toHaveProperty('drugDetectionsLimit');
  });
});
