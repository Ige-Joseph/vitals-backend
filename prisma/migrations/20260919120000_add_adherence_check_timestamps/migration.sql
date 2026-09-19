-- Add durable state for the delayed medication adherence check.
-- Existing rows remain NULL: no backfill is performed in Stage 1.
ALTER TABLE "reminders"
  ADD COLUMN "adherenceCheckDueAt" TIMESTAMP(3),
  ADD COLUMN "adherenceCheckProcessedAt" TIMESTAMP(3);

CREATE INDEX "reminders_adherence_due_idx"
  ON "reminders"("status", "adherenceCheckProcessedAt", "adherenceCheckDueAt");
