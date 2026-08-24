import request from 'supertest';
import { createApp } from '@/app';
import { createUser, createMoodLog, authHeader } from './helpers/factories';

/**
 * Scoping shape under test: **direct filter with a paired aggregate**.
 *
 * `/mood/history` runs two queries — a `findMany` and a `count` — each with
 * its own `where: { userId }`. They are written separately, so they can drift
 * apart: a correct page of rows next to a total that counted everyone. That
 * particular bug is invisible to a mock and invisible to a single-user test.
 */

const app = createApp();

describe('mood history — direct scoping and pagination totals', () => {
  it('counts and returns only the caller’s entries', async () => {
    const alice = await createUser();
    const bob = await createUser();

    await createMoodLog(alice.id, 'good');
    await createMoodLog(alice.id, 'okay');
    await createMoodLog(alice.id, 'low');
    await createMoodLog(bob.id, 'very_good');
    await createMoodLog(bob.id, 'very_low');

    const res = await request(app)
      .get('/api/v1/mood/history')
      .set(...authHeader(alice));

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(3);

    // The aggregate has to agree with the rows. If `count` lost its filter this
    // would read 5 while the page still showed 3 — a plausible, quiet bug.
    expect(res.body.data.pagination.total).toBe(3);

    for (const entry of res.body.data.entries) {
      expect(entry.userId).toBe(alice.id);
    }
  });

  it('paginates within the caller’s own rows', async () => {
    const alice = await createUser();
    const bob = await createUser();

    await createMoodLog(alice.id, 'good');
    await createMoodLog(alice.id, 'okay');
    await createMoodLog(alice.id, 'low');
    for (let i = 0; i < 10; i += 1) await createMoodLog(bob.id, 'good');

    const res = await request(app)
      .get('/api/v1/mood/history?page=1&limit=2')
      .set(...authHeader(alice));

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(2);
    expect(res.body.data.pagination).toMatchObject({
      page: 1,
      limit: 2,
      total: 3,
      pages: 2,
    });

    const second = await request(app)
      .get('/api/v1/mood/history?page=2&limit=2')
      .set(...authHeader(alice));

    expect(second.body.data.entries).toHaveLength(1);
    expect(second.body.data.entries[0].userId).toBe(alice.id);
  });

  it('returns an empty history rather than someone else’s', async () => {
    const alice = await createUser();
    const bob = await createUser();
    await createMoodLog(bob.id, 'good');

    const res = await request(app)
      .get('/api/v1/mood/history')
      .set(...authHeader(alice));

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(0);
    expect(res.body.data.pagination.total).toBe(0);
  });
});
