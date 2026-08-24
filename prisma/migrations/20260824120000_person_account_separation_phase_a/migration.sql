-- Person / Account separation — PHASE A (additive DDL only).
--
-- Creates the Person structures and adds nullable subject columns. Writes NO
-- data: every new table is empty and every new column is NULL on arrival.
-- userId stays on every clinical model, untouched and still authoritative.
--
-- Explicitly NOT in this phase:
--   * no backfill (phase B)
--   * no cascade swap on existing foreign keys (phase C)
--   * no NOT NULL on any personId, and no columns dropped from profiles
--
-- Reversal: drop the new objects. Because nothing is written and nothing
-- existing is altered in place, this is a clean rollback:
--
--   DROP TABLE IF EXISTS "person_health_profiles", "person_memberships", "persons" CASCADE;
--   DROP TYPE  IF EXISTS "PersonRole", "MembershipStatus";
--   ALTER TABLE "care_plans"        DROP COLUMN IF EXISTS "personId";
--   ALTER TABLE "symptom_logs"      DROP COLUMN IF EXISTS "personId";
--   ALTER TABLE "mood_logs"         DROP COLUMN IF EXISTS "personId";
--   ALTER TABLE "drug_detections"   DROP COLUMN IF EXISTS "personId";
--   ALTER TABLE "medication_drafts" DROP COLUMN IF EXISTS "personId";
--   ALTER TABLE "activity_logs"     DROP COLUMN IF EXISTS "personId", DROP COLUMN IF EXISTS "actorUserId";
--   ALTER TABLE "users"             DROP COLUMN IF EXISTS "managedPersonLimit", DROP COLUMN IF EXISTS "connectionLimit";
--   DROP INDEX IF EXISTS "calendar_event_links_careEventId_provider_userId_key";
--   CREATE UNIQUE INDEX "calendar_event_links_careEventId_provider_key"
--     ON "calendar_event_links"("careEventId", "provider");
--
-- The one non-additive statement is the calendar unique-index swap below. It
-- widens [careEventId, provider] to [careEventId, provider, userId] so two
-- accounts can each hold their own link to one care event. Widening never
-- rejects rows the narrower key accepted, so it cannot fail on existing data.

-- CreateEnum
CREATE TYPE "PersonRole" AS ENUM ('OWNER', 'CAREGIVER', 'VIEWER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'REVOKED');

-- DropIndex
DROP INDEX "calendar_event_links_careEventId_provider_key";

-- AlterTable
ALTER TABLE "activity_logs" ADD COLUMN     "actorUserId" TEXT,
ADD COLUMN     "personId" TEXT;

-- AlterTable
ALTER TABLE "care_plans" ADD COLUMN     "personId" TEXT;

-- AlterTable
ALTER TABLE "drug_detections" ADD COLUMN     "personId" TEXT;

-- AlterTable
ALTER TABLE "medication_drafts" ADD COLUMN     "personId" TEXT;

-- AlterTable
ALTER TABLE "mood_logs" ADD COLUMN     "personId" TEXT;

-- AlterTable
ALTER TABLE "symptom_logs" ADD COLUMN     "personId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "connectionLimit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "managedPersonLimit" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "persons" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "gender" "Gender",
    "ownerUserId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_memberships" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "PersonRole" NOT NULL DEFAULT 'VIEWER',
    "status" "MembershipStatus" NOT NULL DEFAULT 'INVITED',
    "receivesNotifications" BOOLEAN NOT NULL DEFAULT false,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_health_profiles" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "bloodGroup" TEXT,
    "genotype" TEXT,
    "heightCm" DOUBLE PRECISION,
    "weightKg" DOUBLE PRECISION,
    "allergies" TEXT[],
    "existingConditions" TEXT[],
    "currentMedications" TEXT[],
    "disabilities" TEXT[],
    "smokingStatus" TEXT,
    "alcoholUse" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_health_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "persons_ownerUserId_idx" ON "persons"("ownerUserId");

-- CreateIndex
CREATE INDEX "persons_createdByUserId_idx" ON "persons"("createdByUserId");

-- CreateIndex
CREATE INDEX "person_memberships_userId_status_idx" ON "person_memberships"("userId", "status");

-- CreateIndex
CREATE INDEX "person_memberships_personId_status_receivesNotifications_idx" ON "person_memberships"("personId", "status", "receivesNotifications");

-- CreateIndex
CREATE UNIQUE INDEX "person_memberships_personId_userId_key" ON "person_memberships"("personId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "person_health_profiles_personId_key" ON "person_health_profiles"("personId");

-- CreateIndex
CREATE INDEX "activity_logs_personId_createdAt_idx" ON "activity_logs"("personId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_links_careEventId_provider_userId_key" ON "calendar_event_links"("careEventId", "provider", "userId");

-- CreateIndex
CREATE INDEX "care_plans_personId_status_idx" ON "care_plans"("personId", "status");

-- CreateIndex
CREATE INDEX "drug_detections_personId_createdAt_idx" ON "drug_detections"("personId", "createdAt");

-- CreateIndex
CREATE INDEX "medication_drafts_personId_idx" ON "medication_drafts"("personId");

-- CreateIndex
CREATE INDEX "mood_logs_personId_loggedAt_idx" ON "mood_logs"("personId", "loggedAt");

-- CreateIndex
CREATE INDEX "symptom_logs_personId_createdAt_idx" ON "symptom_logs"("personId", "createdAt");

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_memberships" ADD CONSTRAINT "person_memberships_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_memberships" ADD CONSTRAINT "person_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_health_profiles" ADD CONSTRAINT "person_health_profiles_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_drafts" ADD CONSTRAINT "medication_drafts_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mood_logs" ADD CONSTRAINT "mood_logs_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "symptom_logs" ADD CONSTRAINT "symptom_logs_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_detections" ADD CONSTRAINT "drug_detections_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

