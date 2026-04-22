import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import jwt from 'jsonwebtoken';

jest.mock('@/lib/prisma', () => ({
  prisma: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
    moodLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    activityLog: { create: jest.fn() },
  },
}));

jest.mock('@/lib/redis', () => ({
  redisConnection: { ping: jest.fn(), on: jest.fn(), disconnect: jest.fn() },
}));

const app = createApp();

const makeToken = () =>
  jwt.sign(
    { sub: 'user-1', email: 'test@example.com', role: 'USER', planType: 'FREE', emailVerified: true },
    process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-minimum-32-characters-long',
    { expiresIn: '15m' },
  );

describe('GET /api/v1/mood/options', () => {
  it('returns mood and craving options', async () => {
    const res = await request(app)
      .get('/api/v1/mood/options')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('moods');
    expect(res.body.data).toHaveProperty('cravings');
    expect(Array.isArray(res.body.data.moods)).toBe(true);
    expect(res.body.data.moods.length).toBeGreaterThan(0);
  });
});

describe('POST /api/v1/mood/log', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 422 when neither mood nor craving provided', async () => {
    const res = await request(app)
      .post('/api/v1/mood/log')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 201 with insight for valid mood', async () => {
    const mockEntry = {
      id: 'log-1',
      userId: 'user-1',
      mood: 'HAPPY',
      craving: null,
      insight: 'Great to hear you are feeling good today.',
      loggedAt: new Date(),
    };

    (prisma.$transaction as jest.Mock).mockImplementation(async (fn) =>
      fn({
        moodLog: { create: jest.fn().mockResolvedValue(mockEntry) },
        activityLog: { create: jest.fn() },
      }),
    );

    const res = await request(app)
      .post('/api/v1/mood/log')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ mood: 'HAPPY' });

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('insight');
    expect(typeof res.body.data.insight).toBe('string');
  });

  it('accepts craving without mood', async () => {
    const mockEntry = {
      id: 'log-2',
      userId: 'user-1',
      mood: null,
      craving: 'SWEET',
      insight: 'Sweet cravings are common.',
      loggedAt: new Date(),
    };

    (prisma.$transaction as jest.Mock).mockImplementation(async (fn) =>
      fn({
        moodLog: { create: jest.fn().mockResolvedValue(mockEntry) },
        activityLog: { create: jest.fn() },
      }),
    );

    const res = await request(app)
      .post('/api/v1/mood/log')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ craving: 'SWEET' });

    expect(res.status).toBe(201);
  });

  it('returns 422 for invalid mood value', async () => {
    const res = await request(app)
      .post('/api/v1/mood/log')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ mood: 'INVALID_MOOD' });

    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/mood/history', () => {
  it('returns paginated history', async () => {
    (prisma.moodLog.findMany as jest.Mock).mockResolvedValue([
      { id: 'log-1', mood: 'HAPPY', craving: null, insight: 'Good.', loggedAt: new Date() },
    ]);
    (prisma.moodLog.count as jest.Mock).mockResolvedValue(1);

    const res = await request(app)
      .get('/api/v1/mood/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('entries');
    expect(res.body.data).toHaveProperty('pagination');
  });
});
