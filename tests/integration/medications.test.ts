import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import jwt from 'jsonwebtoken';

jest.mock('@/lib/prisma', () => ({
  prisma: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
    user: { findUnique: jest.fn() },
    carePlan: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    medication: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    careEvent: { createMany: jest.fn() },
    // The authorization layer resolves the caller's own Person and checks the
    // membership before any clinical query runs.
    person: { findFirst: jest.fn().mockResolvedValue({ id: 'person-1' }) },
    personMembership: {
      findUnique: jest.fn().mockResolvedValue({
        role: 'OWNER',
        status: 'ACTIVE',
        person: { archivedAt: null },
      }),
    },
    reminder: { createMany: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}));

jest.mock('@/lib/redis', () => ({
  redisConnection: { ping: jest.fn(), on: jest.fn(), disconnect: jest.fn() },
}));

const app = createApp();

// Helper: generate a valid test access token
const makeToken = (overrides = {}) =>
  jwt.sign(
    {
      sub: 'user-123',
      email: 'test@example.com',
      role: 'USER',
      planType: 'FREE',
      emailVerified: true,
      ...overrides,
    },
    process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-minimum-32-characters-long',
    { expiresIn: '15m' },
  );

describe('POST /api/v1/medications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/v1/medications').send({});
    expect(res.status).toBe(401);
  });

  it('returns 422 for missing required fields', async () => {
    const res = await request(app)
      .post('/api/v1/medications')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Paracetamol' }); // missing dosage, frequency, startDate

    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when neither endDate nor durationDays provided', async () => {
    const res = await request(app)
      .post('/api/v1/medications')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        name: 'Paracetamol',
        dosage: '500mg',
        frequency: 'TWICE_DAILY',
        startDate: new Date().toISOString(),
        // Missing endDate and durationDays
      });

    expect(res.status).toBe(422);
  });

  it('returns 201 for valid medication creation', async () => {
    const mockCarePlan = {
      id: 'plan-1',
      userId: 'user-123',
      type: 'MEDICATION',
      title: 'Paracetamol — 500mg',
      status: 'ACTIVE',
    };

    (prisma.$transaction as jest.Mock).mockImplementation(async (fn) =>
      fn({
        carePlan: { create: jest.fn().mockResolvedValue(mockCarePlan) },
        medication: { create: jest.fn().mockResolvedValue({ ...mockCarePlan, id: 'med-1' }) },
        careEvent: { createMany: jest.fn().mockResolvedValue({ count: 14 }) },
        reminder: { createMany: jest.fn().mockResolvedValue({ count: 14 }) },
        activityLog: { create: jest.fn() },
      }),
    );

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const res = await request(app)
      .post('/api/v1/medications')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        name: 'Paracetamol',
        dosage: '500mg',
        frequency: 'TWICE_DAILY',
        startDate: tomorrow.toISOString().slice(0, 10), // schema wants YYYY-MM-DD
        durationDays: 7,
        customTimes: ['08:00', '20:00'], // TWICE_DAILY requires exactly two
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/v1/medications', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/v1/medications');
    expect(res.status).toBe(401);
  });

  it('returns 200 with medication list', async () => {
    (prisma.medication.findMany as jest.Mock).mockResolvedValue([
      { id: 'med-1', name: 'Paracetamol', carePlan: { id: 'plan-1', status: 'ACTIVE' } },
    ]);

    const res = await request(app)
      .get('/api/v1/medications')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
