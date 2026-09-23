import { prisma } from '@/lib/prisma';
import { personAccess } from '@/modules/person/person.access';
import { createUser } from './helpers/factories';

/**
 * The authorization layer, against real rows.
 *
 * These cases are the reason the database-backed harness exists. A mocked
 * Prisma cannot catch a cross-person leak, because the leak lives in the query
 * scoping that the mock replaces.
 */

async function makePerson(displayName = 'Subject') {
  return prisma.person.create({ data: { displayName } });
}

async function grant(
  personId: string,
  userId: string,
  role: 'OWNER' | 'CAREGIVER' | 'VIEWER',
  status: 'INVITED' | 'ACTIVE' | 'REVOKED' = 'ACTIVE',
) {
  return prisma.personMembership.create({
    data: { personId, userId, role, status, acceptedAt: new Date() },
  });
}

const CAPABILITIES = ['read', 'write', 'manage'] as const;

describe('a stranger gets nothing', () => {
  it('denies every capability to an account with no membership', async () => {
    const stranger = await createUser();
    const person = await makePerson('Someone Else');

    for (const capability of CAPABILITIES) {
      await expect(
        personAccess.assertPersonAccess(stranger.id, person.id, capability),
      ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
    }
  });

  it('does not distinguish "no such person" from "you were removed"', async () => {
    const stranger = await createUser();
    const person = await makePerson();

    const missing = await personAccess
      .assertPersonAccess(stranger.id, 'no-such-person-id', 'read')
      .catch((e) => e);
    const removed = await personAccess
      .assertPersonAccess(stranger.id, person.id, 'read')
      .catch((e) => e);

    // Same code and same message: a caller must not be able to probe for the
    // existence of a record they have no relationship with.
    expect(missing.errorCode).toBe(removed.errorCode);
    expect(missing.message).toBe(removed.message);
  });
});

describe('roles carry exactly their capabilities', () => {
  it('OWNER may read, write and manage', async () => {
    const user = await createUser();
    const person = await makePerson();
    await grant(person.id, user.id, 'OWNER');

    for (const capability of CAPABILITIES) {
      await expect(
        personAccess.assertPersonAccess(user.id, person.id, capability),
      ).resolves.toMatchObject({ role: 'OWNER' });
    }
  });

  it('CAREGIVER may read and write but not manage', async () => {
    const user = await createUser();
    const person = await makePerson();
    await grant(person.id, user.id, 'CAREGIVER');

    await expect(
      personAccess.assertPersonAccess(user.id, person.id, 'read'),
    ).resolves.toBeTruthy();
    await expect(
      personAccess.assertPersonAccess(user.id, person.id, 'write'),
    ).resolves.toBeTruthy();
    await expect(
      personAccess.assertPersonAccess(user.id, person.id, 'manage'),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
  });

  it('VIEWER may read but never write', async () => {
    const user = await createUser();
    const person = await makePerson();
    await grant(person.id, user.id, 'VIEWER');

    await expect(
      personAccess.assertPersonAccess(user.id, person.id, 'read'),
    ).resolves.toBeTruthy();

    for (const capability of ['write', 'manage'] as const) {
      await expect(
        personAccess.assertPersonAccess(user.id, person.id, capability),
      ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
    }
  });
});

describe('membership state gates access, and revocation is immediate', () => {
  it('an INVITED membership grants nothing until accepted', async () => {
    const user = await createUser();
    const person = await makePerson();
    await grant(person.id, user.id, 'OWNER', 'INVITED');

    await expect(
      personAccess.assertPersonAccess(user.id, person.id, 'read'),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
  });

  it('a REVOKED membership grants nothing, even at OWNER', async () => {
    const user = await createUser();
    const person = await makePerson();
    const membership = await grant(person.id, user.id, 'OWNER');

    await expect(
      personAccess.assertPersonAccess(user.id, person.id, 'read'),
    ).resolves.toBeTruthy();

    await prisma.personMembership.update({
      where: { id: membership.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    // No token refresh, no cache expiry — the next call is already denied.
    // This is why memberships are looked up rather than carried in the JWT.
    for (const capability of CAPABILITIES) {
      await expect(
        personAccess.assertPersonAccess(user.id, person.id, capability),
      ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
    }

    // And the revocation is still on the record rather than erased.
    const after = await prisma.personMembership.findUnique({
      where: { id: membership.id },
    });
    expect(after?.status).toBe('REVOKED');
    expect(after?.revokedAt).not.toBeNull();
  });

  it('an archived Person is unreachable even by its owner', async () => {
    const user = await createUser();
    const person = await makePerson();
    await grant(person.id, user.id, 'OWNER');
    await prisma.person.update({
      where: { id: person.id },
      data: { archivedAt: new Date() },
    });

    await expect(
      personAccess.assertPersonAccess(user.id, person.id, 'read'),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
  });
});

describe('resolveSubject is the only way in', () => {
  it('defaults to the caller’s own Person when none is named', async () => {
    const user = await createUser();

    await expect(personAccess.resolveSubject(user.id, undefined, 'write')).resolves.toBe(
      user.personId,
    );
  });

  it('refuses a named Person the caller has no relationship with', async () => {
    const user = await createUser();
    const someoneElse = await makePerson('Not Yours');

    // Taking personId straight from the request without going through here is
    // the whole class of bug this layer exists to prevent.
    await expect(
      personAccess.resolveSubject(user.id, someoneElse.id, 'read'),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
  });
});
