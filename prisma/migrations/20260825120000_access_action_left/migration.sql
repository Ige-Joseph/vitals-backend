-- A member leaving is not the same fact as an owner removing them.
--
-- The consent ledger has to be able to say who ended a relationship: "they
-- took my access away" and "I walked away" answer different questions about
-- consent, and collapsing both into REVOKED loses that.
--
-- Adding an enum value is catalog-only and rewrites nothing. Postgres 12+
-- permits it inside a transaction; the value simply cannot be *used* until
-- that transaction commits, which is why nothing here writes it.
--
-- Rollback: Postgres cannot drop an enum value. Reverting means leaving the
-- value in place unused, which is harmless.

-- AlterEnum
ALTER TYPE "AccessAction" ADD VALUE 'LEFT';

