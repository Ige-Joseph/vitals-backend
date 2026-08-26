-- A record that a report was generated. Not the report.
--
-- Purely additive: one new table and one new enum. No existing row is read,
-- rewritten or moved, so there is no clinical data to backfill and nothing
-- this migration can orphan.
--
-- There is no file column, no path, no blob and no URL, and that is deliberate
-- rather than deferred. The document is rendered and streamed inside the
-- request; no copy is kept anywhere. A stored PDF holding one Person's entire
-- health record would be that record duplicated outside the tables that own it
-- and outside every access check that guards them.
--
-- What is kept answers one question: who has taken a copy of this Person's
-- history out of the system, and for what period.
--
--   personId          RESTRICT — the subject's own record of the fact.
--   generatedByUserId SET NULL — erasing the account that generated a report
--                                must not erase that it happened.
--
-- Rollback:
--   DROP TABLE "report_generations";
--   DROP TYPE "ReportKind";

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('HEALTH_SUMMARY');

-- CreateTable
CREATE TABLE "report_generations" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "generatedByUserId" TEXT,
    "kind" "ReportKind" NOT NULL DEFAULT 'HEALTH_SUMMARY',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_generations_personId_generatedAt_idx" ON "report_generations"("personId", "generatedAt");

-- CreateIndex
CREATE INDEX "report_generations_generatedByUserId_generatedAt_idx" ON "report_generations"("generatedByUserId", "generatedAt");

-- AddForeignKey
ALTER TABLE "report_generations" ADD CONSTRAINT "report_generations_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_generations" ADD CONSTRAINT "report_generations_generatedByUserId_fkey" FOREIGN KEY ("generatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

