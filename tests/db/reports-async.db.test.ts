import { readdir, rm } from 'fs/promises';
import path from 'path';

import request from 'supertest';

import { createApp } from '@/app';
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { reportsService } from '@/modules/reports/reports.service';
import { enqueuedJobs, clearEnqueuedJobs } from './stubs/queues.stub';
import { createUser, authHeader, type TestUser } from './helpers/factories';

/**
 * Asynchronous health summaries, against real rows and real files.
 *
 * The interesting properties are not "a job was queued". They are the ones a
 * stored artefact introduces, which the streaming design did not have:
 *
 *   * a document is authorised on every download, not once when it was asked
 *     for — so access revoked in between stops the fetch
 *   * a document expires, and the file actually leaves the disk
 *   * the ledger outlives the document: the record that a copy was taken is
 *     permanent, the file is not
 *   * a replayed job cannot render the same health record twice
 *
 * These run against real Postgres and a real temporary directory, because a
 * mocked filesystem would prove nothing about the thing being guarded.
 */

const app = createApp();

const grant = (
  personId: string,
  userId: string,
  role: 'OWNER' | 'CAREGIVER' | 'VIEWER',
) =>
  prisma.personMembership.create({
    data: { personId, userId, role, status: 'ACTIVE', acceptedAt: new Date() },
  });

const premium = () => createUser({ planType: 'PREMIUM' });

const selfPersonOf = async (user: TestUser) => {
  const person = await prisma.person.findFirstOrThrow({
    where: { ownerUserId: user.id },
  });
  return person.id;
};

const filesOnDisk = async (): Promise<string[]> => {
  try {
    return (await readdir(path.resolve(env.REPORT_STORAGE_DIR))).filter((n) =>
      n.endsWith('.pdf'),
    );
  } catch {
    return [];
  }
};

/** Ask for a summary and render it, leaving a READY row with a real file. */
const generateReady = async (user: TestUser, personId?: string) => {
  const generation = await reportsService.requestHealthSummary(user.id, personId, {
    start: new Date(Date.now() - 30 * 86_400_000),
    end: new Date(),
  });
  await reportsService.renderPending(generation.id);
  return generation.id;
};

/**
 * The database lifecycle truncates every table between cases; the filesystem
 * needs the same treatment. Without it a document written by one test is still
 * on disk during the next, and assertions about what the sweep left behind
 * measure the previous test rather than this one.
 */
beforeEach(async () => {
  clearEnqueuedJobs();
  for (const name of await filesOnDisk()) {
    await rm(path.join(path.resolve(env.REPORT_STORAGE_DIR), name), { force: true });
  }
});

describe('accepting a request', () => {
  it('returns 202 with a PENDING row and queues the row id, rendering nothing', async () => {
    const user = await premium();

    const res = await request(app)
      .post('/api/v1/reports/health-summary')
      .set(...authHeader(user))
      .send({});

    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.completedAt).toBeNull();
    expect(res.body.data.expiresAt).toBeNull();

    // The payload carries the row id and nothing about the subject: the worker
    // re-reads who asked and re-resolves their access.
    expect(enqueuedJobs).toEqual([
      {
        queue: 'reports',
        name: 'GENERATE_HEALTH_SUMMARY',
        payload: { reportGenerationId: res.body.data.id },
      },
    ]);

    // Nothing is on disk yet, and no key is exposed to the caller.
    expect(await filesOnDisk()).toHaveLength(0);
    expect(res.body.data.storageKey).toBeUndefined();
  });

  it('refuses a free account before queuing anything', async () => {
    const user = await createUser();

    const res = await request(app)
      .post('/api/v1/reports/health-summary')
      .set(...authHeader(user))
      .send({});

    expect(res.status).toBe(403);
    expect(enqueuedJobs).toHaveLength(0);
    expect(await prisma.reportGeneration.count()).toBe(0);
  });

  it('refuses a stranger for lack of access, not for lack of Premium', async () => {
    const stranger = await premium();
    const other = await premium();
    const theirPerson = await selfPersonOf(other);

    const res = await request(app)
      .post('/api/v1/reports/health-summary')
      .set(...authHeader(stranger))
      .send({ personId: theirPerson });

    expect(res.status).toBe(403);
    // Access is resolved first, so a Premium stranger is told about access.
    expect(res.body.message).not.toMatch(/premium/i);
    expect(enqueuedJobs).toHaveLength(0);
  });
});

describe('rendering', () => {
  it('writes a file, marks the row READY and gives it an expiry', async () => {
    const user = await premium();
    const id = await generateReady(user);

    const row = await prisma.reportGeneration.findUniqueOrThrow({ where: { id } });

    expect(row.status).toBe('READY');
    expect(row.storageKey).toMatch(/^[0-9a-f]{32}\.pdf$/);
    expect(row.completedAt).not.toBeNull();
    expect(row.expiresAt).not.toBeNull();
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    // No READY row may exist without an expiry — that is the whole guarantee.
    expect(await filesOnDisk()).toContain(row.storageKey);
  });

  it('cannot render the same request twice', async () => {
    const user = await premium();
    const generation = await reportsService.requestHealthSummary(user.id, undefined, {
      start: new Date(Date.now() - 30 * 86_400_000),
      end: new Date(),
    });

    const first = await reportsService.renderPending(generation.id);
    const second = await reportsService.renderPending(generation.id);

    expect(first).toBe(true);
    // A replayed job finds the row already claimed and does nothing, rather
    // than rendering a second copy of someone's health record.
    expect(second).toBe(false);
    expect(await filesOnDisk()).toHaveLength(1);
  });

  it('fails the row rather than rendering when access was lost while queued', async () => {
    const owner = await premium();
    const caregiver = await premium();
    const personId = await selfPersonOf(owner);
    const membership = await grant(personId, caregiver.id, 'CAREGIVER');

    const generation = await reportsService.requestHealthSummary(
      caregiver.id,
      personId,
      { start: new Date(Date.now() - 30 * 86_400_000), end: new Date() },
    );

    // Revoked after the request was accepted, before the worker ran.
    await prisma.personMembership.update({
      where: { id: membership.id },
      data: { status: 'REVOKED' },
    });

    await expect(reportsService.renderPending(generation.id)).rejects.toThrow();

    const row = await prisma.reportGeneration.findUniqueOrThrow({
      where: { id: generation.id },
    });
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).not.toBeNull();
    expect(await filesOnDisk()).toHaveLength(0);
  });
});

describe('downloading is authorised every time', () => {
  it('serves the PDF to someone who may read the Person, and stamps the ledger once', async () => {
    const user = await premium();
    const id = await generateReady(user);

    const res = await request(app)
      .get(`/api/v1/reports/health-summary/${id}/download`)
      .set(...authHeader(user));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF');

    const first = await prisma.reportGeneration.findUniqueOrThrow({ where: { id } });
    expect(first.downloadedAt).not.toBeNull();

    await request(app)
      .get(`/api/v1/reports/health-summary/${id}/download`)
      .set(...authHeader(user));

    const second = await prisma.reportGeneration.findUniqueOrThrow({ where: { id } });
    // The ledger records that a copy left, not how many times it was fetched.
    expect(second.downloadedAt).toEqual(first.downloadedAt);
  });

  it('refuses a download after the membership that justified it was revoked', async () => {
    const owner = await premium();
    const caregiver = await premium();
    const personId = await selfPersonOf(owner);
    const membership = await grant(personId, caregiver.id, 'CAREGIVER');

    const id = await generateReady(caregiver, personId);

    // It downloads while the membership stands.
    const before = await request(app)
      .get(`/api/v1/reports/health-summary/${id}/download`)
      .set(...authHeader(caregiver));
    expect(before.status).toBe(200);

    await prisma.personMembership.update({
      where: { id: membership.id },
      data: { status: 'REVOKED' },
    });

    // And stops the moment it does not. This is the property a signed storage
    // URL would not have had: the URL would still resolve.
    const after = await request(app)
      .get(`/api/v1/reports/health-summary/${id}/download`)
      .set(...authHeader(caregiver));
    expect(after.status).toBe(403);
  });

  it('refuses a download after Premium lapses', async () => {
    const user = await premium();
    const id = await generateReady(user);

    await prisma.user.update({ where: { id: user.id }, data: { planType: 'FREE' } });

    const res = await request(app)
      .get(`/api/v1/reports/health-summary/${id}/download`)
      .set(...authHeader(user));

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/premium/i);
  });

  it('refuses a stranger even with the report id in hand', async () => {
    const user = await premium();
    const stranger = await premium();
    const id = await generateReady(user);

    const res = await request(app)
      .get(`/api/v1/reports/health-summary/${id}/download`)
      .set(...authHeader(stranger));

    expect(res.status).toBe(403);
  });

  it('answers 400 while it is still being prepared', async () => {
    const user = await premium();
    const generation = await reportsService.requestHealthSummary(user.id, undefined, {
      start: new Date(Date.now() - 30 * 86_400_000),
      end: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/reports/health-summary/${generation.id}/download`)
      .set(...authHeader(user));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/still being prepared/i);
  });
});

describe('expiry', () => {
  it('answers 410 once the expiry has passed, before any sweep has run', async () => {
    const user = await premium();
    const id = await generateReady(user);

    await prisma.reportGeneration.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .get(`/api/v1/reports/health-summary/${id}/download`)
      .set(...authHeader(user));

    // A sweep running late must not extend anyone's access.
    expect(res.status).toBe(410);
  });

  it('deletes the file, marks the row EXPIRED and keeps the ledger entry', async () => {
    const user = await premium();
    const id = await generateReady(user);

    await prisma.reportGeneration.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await reportsService.sweepExpiredDocuments();
    expect(result.expired).toBe(1);

    const row = await prisma.reportGeneration.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('EXPIRED');
    expect(row.storageKey).toBeNull();
    expect(await filesOnDisk()).toHaveLength(0);

    // The document is gone; the record that it was taken is not.
    expect(row.personId).not.toBeNull();
    expect(row.generatedByUserId).toBe(user.id);
    expect(row.periodStart).not.toBeNull();
  });

  it('treats a file that vanished as expired rather than serving a 500', async () => {
    const user = await premium();
    const id = await generateReady(user);

    // A restart cleared the directory while the row still says READY.
    const row = await prisma.reportGeneration.findUniqueOrThrow({ where: { id } });
    const { deleteFile } = await import('@/modules/reports/reports.storage');
    await deleteFile(row.storageKey!);

    const res = await request(app)
      .get(`/api/v1/reports/health-summary/${id}/download`)
      .set(...authHeader(user));

    expect(res.status).toBe(410);

    const corrected = await prisma.reportGeneration.findUniqueOrThrow({ where: { id } });
    expect(corrected.status).toBe('EXPIRED');
  });

  it('sweeps a file that no row owns', async () => {
    const { newStorageKey, openWriteStream } = await import(
      '@/modules/reports/reports.storage'
    );

    // What a crash between writing a document and committing its row leaves:
    // a health record on disk that no expiry covers.
    const orphan = newStorageKey();
    const stream = await openWriteStream(orphan);
    await new Promise<void>((resolve) => {
      stream.end('not really a pdf', () => resolve());
    });

    expect(await filesOnDisk()).toContain(orphan);

    const result = await reportsService.sweepExpiredDocuments();

    expect(result.orphans).toBe(1);
    expect(await filesOnDisk()).not.toContain(orphan);
  });

  it('leaves a live document alone', async () => {
    const user = await premium();
    const id = await generateReady(user);

    const result = await reportsService.sweepExpiredDocuments();

    expect(result.expired).toBe(0);
    expect(result.orphans).toBe(0);

    const row = await prisma.reportGeneration.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('READY');
    expect(await filesOnDisk()).toHaveLength(1);
  });
});
