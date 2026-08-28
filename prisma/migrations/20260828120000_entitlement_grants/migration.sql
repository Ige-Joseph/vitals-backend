-- Premium that was given rather than bought.
--
-- Purely additive: two enums and one table. No existing column is dropped,
-- narrowed or rewritten, nothing in the billing or subscription tables is
-- touched, and no row anywhere is modified. There is deliberately no backfill:
-- there are no paying subscribers and no granted accounts to migrate, so
-- synthesising historical grant rows would be inventing an audit trail rather
-- than preserving one.
--
-- ── Why this table exists ───────────────────────────────────────────────
--
-- Granting Premium meant setting `users.planType` and leaving it. That records
-- nothing: not who decided, not when, not why, not for how long, and no way to
-- tell a permanent decision from one somebody meant to reverse. It also made
-- planType a second source of truth competing with the subscription, which is
-- the specific bug that had an admin-granted account being told it was on the
-- free tier while the API served it Premium.
--
-- planType survives as a *projection* and nothing authorises against it. See
-- entitlement.service.ts, which is now the single calculation.
--
-- ── Expiry is not a status ──────────────────────────────────────────────
--
-- GrantStatus is ACTIVE or REVOKED — the states a person puts a grant into.
-- A grant with a past expiresAt stops granting the moment that time passes,
-- evaluated when entitlement is read. There is no sweep, and correctness does
-- not wait for one. An EXPIRED value would invite a reader to trust a column
-- that is only as current as the job writing it.
--
-- ── Referential behaviour, and why it differs per column ────────────────
--
--   userId          CASCADE  — the grant is about this account and means
--                              nothing without it.
--   grantedByUserId SET NULL — erasing the admin who made the decision must
--                              not erase that the decision was made.
--   revokedByUserId SET NULL — same, for whoever reversed it.
--
-- ── Verification ────────────────────────────────────────────────────────
--
--   SELECT COUNT(*) AS grants FROM "entitlement_grants";              -- 0
--
--   SELECT COUNT(*) AS premium_projections
--     FROM "users" WHERE "planType" = 'PREMIUM';
--   -- Whatever this returns, it is unchanged by this migration. Any account
--   -- it counts now resolves as FREE unless it has a subscription or a grant,
--   -- which is the intended consequence of planType no longer being read.
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'entitlement_grants';
--   -- expect entitlement_grants_userId_status_expiresAt_idx
--   --        entitlement_grants_userId_grantedAt_idx
--
-- ── Rollback ────────────────────────────────────────────────────────────
--
--   DROP TABLE IF EXISTS "entitlement_grants";
--   DROP TYPE IF EXISTS "GrantStatus";
--   DROP TYPE IF EXISTS "GrantSource";
--
--   Rolling back drops every grant. Nothing else is affected — subscriptions,
--   prices and users are untouched — but any account whose Premium came from a
--   grant reverts to FREE, because the record of the decision is what granted
--   it. Revoke-then-rollback is safe; rollback with live grants is not, and
--   the grants must be re-created by hand afterwards.
--
-- Idempotent: every statement is guarded, so re-running changes nothing.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "GrantSource" AS ENUM ('ADMIN', 'PROMOTION', 'SUPPORT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "GrantStatus" AS ENUM ('ACTIVE', 'REVOKED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "entitlement_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "PlanType" NOT NULL DEFAULT 'PREMIUM',
    "source" "GrantSource" NOT NULL DEFAULT 'ADMIN',
    "status" "GrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "entitlement_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "entitlement_grants_userId_status_expiresAt_idx"
  ON "entitlement_grants"("userId", "status", "expiresAt");

CREATE INDEX IF NOT EXISTS "entitlement_grants_userId_grantedAt_idx"
  ON "entitlement_grants"("userId", "grantedAt");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_grantedByUserId_fkey"
    FOREIGN KEY ("grantedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_revokedByUserId_fkey"
    FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
