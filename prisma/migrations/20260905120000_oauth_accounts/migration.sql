-- Federated sign-in: one enum and one table.
--
-- Purely additive. No existing column is dropped, narrowed or rewritten, no
-- row anywhere is modified, and nothing in the auth, calendar or person tables
-- is touched. There is deliberately no backfill: every account that exists
-- today authenticates with a password and holds no provider identity, so
-- synthesising oauth_accounts rows would be inventing links nobody made.
--
-- ── Why this is not CalendarIntegration ─────────────────────────────────
--
-- Both involve Google and neither is the other. CalendarIntegration stores an
-- access and refresh token for calendar.events, granted by an account that was
-- already signed in — a permission we later act with. This table stores no
-- tokens at all: authentication finishes the instant the identity is verified,
-- and nothing afterwards calls Google on the user's behalf. Merging them would
-- put a sign-in path inside a row whose presence currently means "this user
-- authorised calendar writes", and one Google grant would silently confer the
-- other.
--
-- ── Why the key is `sub` and not the email ──────────────────────────────
--
-- A Google account's email address can change, and an address released by one
-- owner can be reissued to another. `sub` is the only value Google promises is
-- stable and unique for the life of the account, so it is the identity. The
-- email column here is display and support context, never read to decide who
-- someone is.
--
-- ── The two unique constraints ──────────────────────────────────────────
--
--   (provider, providerAccountId)  one Google identity resolves to at most one
--                                  Vitals account — no forked identity.
--   (userId, provider)             one account holds at most one Google
--                                  identity — no ambiguity about which to use.
--
-- ── Referential behaviour ───────────────────────────────────────────────
--
--   userId CASCADE — the link is about this account and means nothing without
--                    it. Unlike clinical foreign keys, deleting it destroys no
--                    health data: it removes a way of logging in, and the
--                    account's own erasure path is what governs the rest.
--
-- ── Idempotence ─────────────────────────────────────────────────────────
--
-- Re-running this file changes nothing. The enum is guarded by a catalogue
-- check because CREATE TYPE has no IF NOT EXISTS; everything else uses it
-- directly.
--
-- ── Verification ────────────────────────────────────────────────────────
--
--   SELECT COUNT(*) AS accounts FROM "oauth_accounts";                    -- 0
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'oauth_accounts' ORDER BY indexname;
--     -- oauth_accounts_pkey
--     -- oauth_accounts_provider_providerAccountId_key
--     -- oauth_accounts_userId_provider_key
--
--   SELECT COUNT(*) AS unlinked_users FROM "users" u
--    WHERE NOT EXISTS (SELECT 1 FROM "oauth_accounts" o WHERE o."userId" = u.id);
--     -- equals the total user count: no existing account was altered
--
-- ── Rollback ────────────────────────────────────────────────────────────
--
--   DROP TABLE IF EXISTS "oauth_accounts";
--   DROP TYPE  IF EXISTS "AuthProvider";
--
-- Safe at any point: no other table references either object, and no existing
-- column was added or changed. An account that had linked Google loses the
-- link and signs in with its password, which every account still has.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AuthProvider') THEN
    CREATE TYPE "AuthProvider" AS ENUM ('GOOGLE');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "oauth_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "oauth_accounts_provider_providerAccountId_key"
    ON "oauth_accounts"("provider", "providerAccountId");

CREATE UNIQUE INDEX IF NOT EXISTS "oauth_accounts_userId_provider_key"
    ON "oauth_accounts"("userId", "provider");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oauth_accounts_userId_fkey'
  ) THEN
    ALTER TABLE "oauth_accounts"
      ADD CONSTRAINT "oauth_accounts_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
