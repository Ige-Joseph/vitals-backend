import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { personAccess } from './person.access';

const log = createLogger('person-health-service');

/**
 * The clinical half of what used to be Profile.
 *
 * Profile pinned blood group, genotype, allergies, conditions and medications
 * to an *account*, behind a `userId @unique` — so a second person's allergies
 * were unrepresentable by any workaround. Those attributes describe a body and
 * now live on the Person.
 *
 * Profile keeps its clinical columns during the compatibility window. They are
 * no longer read: PersonHealthProfile is the source of truth from here.
 */

export interface PersonHealthInput {
  bloodGroup?: string | null;
  genotype?: string | null;
  heightCm?: number | null;
  weightKg?: number | null;
  allergies?: string[];
  existingConditions?: string[];
  currentMedications?: string[];
  disabilities?: string[];
  smokingStatus?: string | null;
  alcoholUse?: string | null;
}

const EMPTY = {
  bloodGroup: null,
  genotype: null,
  heightCm: null,
  weightKg: null,
  allergies: [] as string[],
  existingConditions: [] as string[],
  currentMedications: [] as string[],
  disabilities: [] as string[],
  smokingStatus: null,
  alcoholUse: null,
};

export const personHealthService = {
  async get(userId: string, requestedPersonId?: string) {
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'read');

    const record = await prisma.personHealthProfile.findUnique({
      where: { personId },
    });

    // A Person created after the phase B copy has no row yet. An absent record
    // is an empty one, not an error — the alternative is every caller handling
    // a 404 that means "nothing recorded".
    if (!record) return { personId, ...EMPTY };

    return {
      personId,
      bloodGroup: record.bloodGroup,
      genotype: record.genotype,
      heightCm: record.heightCm,
      weightKg: record.weightKg,
      allergies: record.allergies,
      existingConditions: record.existingConditions,
      currentMedications: record.currentMedications,
      disabilities: record.disabilities,
      smokingStatus: record.smokingStatus,
      alcoholUse: record.alcoholUse,
    };
  },

  async update(userId: string, input: PersonHealthInput, requestedPersonId?: string) {
    // Recording someone's allergies is a write on their record, so a VIEWER
    // is refused here even though they can read it.
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'write');

    const data = Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    );

    const record = await prisma.personHealthProfile.upsert({
      where: { personId },
      create: { personId, ...data },
      update: data,
    });

    log.info('Person health profile updated', { personId, actorUserId: userId });

    const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = record;
    return fields;
  },
};
