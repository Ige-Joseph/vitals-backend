-- Replace single-purpose indexes with composites that match the API's
-- equality filters followed by its range/order columns.
--
-- Each replacement index is created BEFORE its predecessor is dropped so no
-- query is left without index support at any point during the migration.
--
-- These are plain (non-concurrent) index builds. Prisma runs each migration
-- inside a transaction and CREATE INDEX CONCURRENTLY cannot run there, so a
-- build takes a SHARE lock and blocks writes to its table until it completes.
-- That is fine at current table sizes. If "care_events" grows large enough for
-- the lock to matter, apply that index separately with CONCURRENTLY outside
-- Prisma and mark this migration as applied.

-- Care plan lookups commonly filter by user, type, and active status.
CREATE INDEX IF NOT EXISTS "care_plans_userId_type_status_idx"
ON "care_plans"("userId", "type", "status");
DROP INDEX IF EXISTS "care_plans_userId_type_idx";

-- Care event list/dashboard queries join through a plan, filter by status,
-- and then range or order by scheduled time. The worker also scans pending
-- events by scheduled time across plans.
CREATE INDEX IF NOT EXISTS "care_events_carePlanId_status_scheduledFor_idx"
ON "care_events"("carePlanId", "status", "scheduledFor");
CREATE INDEX IF NOT EXISTS "care_events_status_scheduledFor_idx"
ON "care_events"("status", "scheduledFor");
DROP INDEX IF EXISTS "care_events_carePlanId_status_idx";

-- The reminder worker filters by status before applying a send-time range.
CREATE INDEX IF NOT EXISTS "reminders_status_sendAt_idx"
ON "reminders"("status", "sendAt");
DROP INDEX IF EXISTS "reminders_sendAt_status_idx";

-- User histories filter by user and return newest rows first.
CREATE INDEX IF NOT EXISTS "activity_logs_userId_createdAt_idx"
ON "activity_logs"("userId", "createdAt");
DROP INDEX IF EXISTS "activity_logs_userId_idx";
DROP INDEX IF EXISTS "activity_logs_createdAt_idx";

CREATE INDEX IF NOT EXISTS "symptom_logs_userId_createdAt_idx"
ON "symptom_logs"("userId", "createdAt");
DROP INDEX IF EXISTS "symptom_logs_userId_idx";

CREATE INDEX IF NOT EXISTS "drug_detections_userId_createdAt_idx"
ON "drug_detections"("userId", "createdAt");
DROP INDEX IF EXISTS "drug_detections_userId_idx";
