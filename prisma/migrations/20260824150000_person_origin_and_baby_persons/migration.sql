-- Person origin — provenance for the entitlement rule.
--
-- A baby is a Person, including when the baby has no Vitals account. That
-- makes the mother-baby journey create managed Persons, and the free tier is
-- managedPersonLimit = 0 — so without an exemption the journey would be
-- gated, which it must not be.
--
-- The exemption is derived, not stored: "the earliest baby Person this
-- account owns" is computed from origin plus createdAt. There is no
-- "this one is free" flag to drift out of step with reality, consistent with
-- managed-versus-connected being derived from ownerUserId IS NULL.
--
-- Origin is immutable, like createdByUserId. It is never read for
-- authorization.

-- CreateEnum
CREATE TYPE "PersonOrigin" AS ENUM ('SELF', 'DELIVERY', 'BABY_PROFILE', 'MANAGED');

-- AlterTable
ALTER TABLE "persons" ADD COLUMN     "origin" "PersonOrigin" NOT NULL DEFAULT 'MANAGED';

-- CreateIndex
CREATE INDEX "persons_origin_createdAt_idx" ON "persons"("origin", "createdAt");



-- Existing Persons predate this column and would otherwise all read MANAGED.
-- Anything owning itself is a self-Person by definition; that is every row
-- created by the phase B backfill and by signup so far.
--
-- Idempotent: re-running matches nothing once applied.
UPDATE "persons"
   SET "origin" = 'SELF'
 WHERE "ownerUserId" IS NOT NULL
   AND "origin" = 'MANAGED';
