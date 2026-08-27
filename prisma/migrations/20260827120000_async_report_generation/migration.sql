-- Health summaries become asynchronous, with a document that expires.
--
-- This reverses a decision the previous migration stated deliberately: "there
-- is no file column, no path, no blob and no URL, and that is deliberate
-- rather than deferred." That reasoning still holds and is not being
-- abandoned. What changed is the machine, not the principle.
--
-- Rendering runs on a 1 GB instance where the API and the worker share one
-- Node process, so a PDF rendered inside a request competes with every other
-- request for the same event loop. The escape hatch was named at the time, in
-- reports.service.ts: "the answer is to stream it in pages, or to accept a job
-- whose output is deleted on a timer. It is not to quietly start storing
-- health records." This is that second option, taken deliberately and with the
-- timer built in rather than promised.
--
-- The principle is kept by construction:
--   * expiresAt is set when the file is written, never left null on a READY row
--   * the sweep deletes the file and moves the row to EXPIRED
--   * the row outlives the document — the consent ledger records that a copy
--     left the system, which is a permanent fact about a Person's data
--   * downloads are authorised through the API on every request, so a
--     membership revoked after generation stops the download. A signed storage
--     URL would not have — it would still resolve.
--
-- Purely additive. No column is dropped, narrowed or renamed, and no clinical
-- row is rewritten. Existing rows are historical synchronous generations: the
-- document was delivered inside the same request and no file was ever stored,
-- so they land as EXPIRED with completedAt and downloadedAt equal to
-- generatedAt — which is what the old contract meant by recording them.
--
-- Idempotent: every statement is guarded, and the backfill is written so a
-- second run matches nothing.
--
-- ── Verification ────────────────────────────────────────────────────────
--
--   SELECT status, COUNT(*) AS rows,
--          COUNT(*) FILTER (WHERE "completedAt"  IS NULL) AS null_completed,
--          COUNT(*) FILTER (WHERE "downloadedAt" IS NULL) AS null_downloaded,
--          COUNT(*) FILTER (WHERE "storageKey"   IS NOT NULL) AS with_file
--     FROM "report_generations"
--    GROUP BY status
--    ORDER BY status;
--
--   Expected after this migration: every pre-existing row is EXPIRED, with no
--   null completedAt or downloadedAt and no storageKey. No READY row may ever
--   have a null expiresAt:
--
--   SELECT COUNT(*) AS ready_without_expiry
--     FROM "report_generations"
--    WHERE status = 'READY' AND "expiresAt" IS NULL;   -- must be 0
--
-- ── Rollback ────────────────────────────────────────────────────────────
--
--   DROP INDEX IF EXISTS "report_generations_status_expiresAt_idx";
--   ALTER TABLE "report_generations"
--     DROP COLUMN IF EXISTS "status",
--     DROP COLUMN IF EXISTS "storageKey",
--     DROP COLUMN IF EXISTS "completedAt",
--     DROP COLUMN IF EXISTS "expiresAt",
--     DROP COLUMN IF EXISTS "downloadedAt",
--     DROP COLUMN IF EXISTS "failureReason";
--   DROP TYPE IF EXISTS "ReportStatus";
--
--   Rolling back drops the lifecycle, not the ledger: personId,
--   generatedByUserId, period and generatedAt are untouched, so the record of
--   who took a copy survives the rollback intact. Any file still on disk is
--   orphaned by it — clear REPORT_STORAGE_DIR by hand afterwards.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
--
-- status arrives defaulted to EXPIRED so that every existing row is classified
-- correctly by the ADD itself, then the default moves to PENDING for rows
-- inserted from here on. Doing it this way means the backfill needs no UPDATE
-- over the table and cannot half-apply.
ALTER TABLE "report_generations" ADD COLUMN IF NOT EXISTS "status" "ReportStatus" NOT NULL DEFAULT 'EXPIRED';
ALTER TABLE "report_generations" ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TABLE "report_generations" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;
ALTER TABLE "report_generations" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
ALTER TABLE "report_generations" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "report_generations" ADD COLUMN IF NOT EXISTS "downloadedAt" TIMESTAMP(3);
ALTER TABLE "report_generations" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;

-- Backfill the historical rows.
--
-- Under the synchronous contract the row was written immediately before the
-- document was streamed, so generatedAt is both when it was asked for and when
-- the copy left. Recording it as both preserves what the ledger already meant.
-- Guarded on IS NULL, so re-running matches nothing.
UPDATE "report_generations"
   SET "completedAt"  = COALESCE("completedAt",  "generatedAt"),
       "downloadedAt" = COALESCE("downloadedAt", "generatedAt")
 WHERE "status" = 'EXPIRED'
   AND ("completedAt" IS NULL OR "downloadedAt" IS NULL);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "report_generations_status_expiresAt_idx" ON "report_generations"("status", "expiresAt");
