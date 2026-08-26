-- Appointments.
--
-- Purely additive: one new table, one new enum, one new value on an existing
-- enum. No existing row is read, rewritten or moved, and no existing column
-- changes type or nullability — so there is no clinical data to backfill and
-- nothing that can be orphaned by this migration. The verification query in
-- the session report confirms zero appointments rows with a null or orphaned
-- personId, which is trivially true on an empty table and is the invariant
-- worth asserting from the first row onward.
--
-- appointments.personId is NOT NULL from creation. Appointments are
-- person-native rather than account-scoped, so there is no "phase A" nullable
-- column here to tighten later.
--
-- Deletion rules are deliberate and differ per parent:
--   * carePlanId    CASCADE  — the plan row is this appointment's engine root
--                              and exists only to carry it.
--   * personId      RESTRICT — health records must not vanish as a side
--                              effect of removing anything else.
--   * createdByUserId SET NULL — provenance only. Erasing the account that
--                              booked an appointment must leave the
--                              dependent's appointment standing.
--
-- Adding a value to CarePlanType is catalog-only. It is not used by any DDL in
-- this migration, so it is safe inside the transaction Prisma runs this in.
--
-- Rollback:
--   DROP TABLE "appointments";
--   DROP TYPE "AppointmentStatus";
--   -- CarePlanType keeps APPOINTMENT: Postgres cannot drop an enum value, and
--   -- an unused one is inert. Rolling back with plans of that type already
--   -- written would need those rows resolved first.

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'MISSED');

-- AlterEnum
ALTER TYPE "CarePlanType" ADD VALUE 'APPOINTMENT';

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "carePlanId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "clinician" TEXT,
    "specialty" TEXT,
    "location" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "reminderLeadMinutes" INTEGER[] DEFAULT ARRAY[1440, 60]::INTEGER[],
    "createdByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointments_carePlanId_key" ON "appointments"("carePlanId");

-- CreateIndex
CREATE INDEX "appointments_personId_startsAt_idx" ON "appointments"("personId", "startsAt");

-- CreateIndex
CREATE INDEX "appointments_personId_status_startsAt_idx" ON "appointments"("personId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "appointments_status_startsAt_idx" ON "appointments"("status", "startsAt");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_carePlanId_fkey" FOREIGN KEY ("carePlanId") REFERENCES "care_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

