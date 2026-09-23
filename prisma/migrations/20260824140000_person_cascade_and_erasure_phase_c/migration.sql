-- Person / Account separation — PHASE C (cascade swap, constraints, erasure).
--
-- Deliberately run while every Person is still self-owned and no account
-- manages another, so Restrict cannot block anything real yet. Doing this
-- later means flipping constraints on a live family graph.
--
-- What it does:
--   1. clinical relations to users: CASCADE -> RESTRICT. Health data must
--      outlive an attempt to delete the account that recorded it. Archive
--      (users.isActive) becomes the only removal path.
--   2. every personId foreign key: SET NULL -> RESTRICT. A clinical row must
--      never lose its subject. SET NULL was Prisma's default for optional
--      relations, not a decision.
--   3. persons."ownerUserId" gains a UNIQUE index. Postgres treats NULLs as
--      distinct, so any number of unclaimed Persons coexist while an account
--      can own at most one — "exactly one self-Person per account" becomes a
--      constraint rather than something a verification query notices later.
--   4. person_access_events: the append-only consent ledger.
--   5. users gains erasedAt / erasureStatus / erasureBlockedReason.
--   6. backfills activity_logs."actorUserId" from "userId".
--
-- Note for production: each ADD CONSTRAINT ... FOREIGN KEY validates with a
-- full scan of the referencing table and holds a lock while it does. On a
-- large table, split it — ADD CONSTRAINT ... NOT VALID first, then
-- VALIDATE CONSTRAINT separately, which takes a weaker lock.
--
-- Rollback: re-run the phase B schema state. The constraint changes are
-- reversible by swapping the referential actions back; the ledger table and
-- the three users columns drop cleanly; the actorUserId backfill is
-- reversible with UPDATE "activity_logs" SET "actorUserId" = NULL.

-- CreateEnum
CREATE TYPE "AccessAction" AS ENUM ('GRANTED', 'ACCEPTED', 'CLAIMED', 'REVOKED', 'TRANSFERRED', 'ARCHIVED', 'ERASED');

-- CreateEnum
CREATE TYPE "ErasureStatus" AS ENUM ('REQUESTED', 'BLOCKED', 'READY', 'EXECUTED', 'CANCELLED');

-- DropForeignKey
ALTER TABLE "activity_logs" DROP CONSTRAINT "activity_logs_personId_fkey";

-- DropForeignKey
ALTER TABLE "activity_logs" DROP CONSTRAINT "activity_logs_userId_fkey";

-- DropForeignKey
ALTER TABLE "care_plans" DROP CONSTRAINT "care_plans_personId_fkey";

-- DropForeignKey
ALTER TABLE "care_plans" DROP CONSTRAINT "care_plans_userId_fkey";

-- DropForeignKey
ALTER TABLE "drug_detections" DROP CONSTRAINT "drug_detections_personId_fkey";

-- DropForeignKey
ALTER TABLE "drug_detections" DROP CONSTRAINT "drug_detections_userId_fkey";

-- DropForeignKey
ALTER TABLE "medication_drafts" DROP CONSTRAINT "medication_drafts_personId_fkey";

-- DropForeignKey
ALTER TABLE "medication_drafts" DROP CONSTRAINT "medication_drafts_userId_fkey";

-- DropForeignKey
ALTER TABLE "mood_logs" DROP CONSTRAINT "mood_logs_personId_fkey";

-- DropForeignKey
ALTER TABLE "mood_logs" DROP CONSTRAINT "mood_logs_userId_fkey";

-- DropForeignKey
ALTER TABLE "symptom_logs" DROP CONSTRAINT "symptom_logs_personId_fkey";

-- DropForeignKey
ALTER TABLE "symptom_logs" DROP CONSTRAINT "symptom_logs_userId_fkey";

-- DropIndex
DROP INDEX "persons_ownerUserId_idx";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "erasedAt" TIMESTAMP(3),
ADD COLUMN     "erasureBlockedReason" TEXT,
ADD COLUMN     "erasureStatus" "ErasureStatus";

-- CreateTable
CREATE TABLE "person_access_events" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "actorUserId" TEXT,
    "action" "AccessAction" NOT NULL,
    "role" "PersonRole",
    "basis" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_access_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "person_access_events_personId_occurredAt_idx" ON "person_access_events"("personId", "occurredAt");

-- CreateIndex
CREATE INDEX "person_access_events_subjectUserId_occurredAt_idx" ON "person_access_events"("subjectUserId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "persons_ownerUserId_key" ON "persons"("ownerUserId");

-- AddForeignKey
ALTER TABLE "person_access_events" ADD CONSTRAINT "person_access_events_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_drafts" ADD CONSTRAINT "medication_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_drafts" ADD CONSTRAINT "medication_drafts_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mood_logs" ADD CONSTRAINT "mood_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mood_logs" ADD CONSTRAINT "mood_logs_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "symptom_logs" ADD CONSTRAINT "symptom_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "symptom_logs" ADD CONSTRAINT "symptom_logs_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_detections" ADD CONSTRAINT "drug_detections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_detections" ADD CONSTRAINT "drug_detections_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ─────────────────────────────────────────────────────────────
-- 6. Backfill activity_logs."actorUserId".
--
-- Before separation the actor is always the owning account, so this is
-- derivable now and unrecoverable once mixed data exists: after a caregiver
-- can act for someone else, "who did this" can no longer be inferred from
-- "whose history is this".
--
-- Idempotent via the IS NULL guard.
-- ─────────────────────────────────────────────────────────────
UPDATE "activity_logs"
   SET "actorUserId" = "userId"
 WHERE "actorUserId" IS NULL;
