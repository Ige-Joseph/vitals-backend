-- Session 7 — invitations, acceptance, claiming, unlinking.
--
-- Additive only. No existing column changes type, no existing column is
-- dropped, and no existing row is rewritten, so every live endpoint keeps
-- working unchanged across the deploy. `POST /persons/:id/members` still
-- creates an INVITED membership; this migration only gives that offer a
-- record of its own so it can also be addressed to someone who has no
-- account yet.
--
-- Rollback:
--   DROP TABLE "person_invitations";
--   DROP TYPE "InvitationStatus";
-- The two enum additions cannot be removed in place — Postgres has no
-- DROP VALUE — but both are inert if unused: CLAIM_REFUSED is only ever
-- written by the claim path, PERSON_INVITATION only by the invitation path,
-- and dropping the table removes the only producer of either. Leaving them is
-- safe. If a hard revert is required, rebuild both types with the old label
-- lists and re-point the columns; there is no data to preserve because the
-- rows that would use them cannot exist before this migration.

-- ── Ledger: a refusal is an event, not a silence ────────────────────────
ALTER TYPE "AccessAction" ADD VALUE IF NOT EXISTS 'CLAIM_REFUSED';

-- ── Delivery ────────────────────────────────────────────────────────────
ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'PERSON_INVITATION';

-- ── The offer ───────────────────────────────────────────────────────────
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED');

CREATE TABLE "person_invitations" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "PersonRole" NOT NULL DEFAULT 'VIEWER',
    "claimable" BOOLEAN NOT NULL DEFAULT false,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "person_invitations_tokenHash_key" ON "person_invitations"("tokenHash");
CREATE INDEX "person_invitations_email_status_idx" ON "person_invitations"("email", "status");
CREATE INDEX "person_invitations_personId_status_idx" ON "person_invitations"("personId", "status");

-- At most one *live* offer per address per record. Partial, because a settled
-- offer must not block a fresh one: re-inviting after a decline is ordinary,
-- and the declined row stays as history. Not expressible in the Prisma schema,
-- which is why it is written here and only here.
CREATE UNIQUE INDEX "person_invitations_live_offer_key"
    ON "person_invitations"("personId", "email")
 WHERE "status" = 'PENDING';

-- Cascade from Person: an offer is not clinical data. It describes access that
-- was proposed and never taken up, and it has no meaning once the record it
-- points at is gone. The consent ledger is what survives — and it is Restrict,
-- unchanged by this migration.
ALTER TABLE "person_invitations"
    ADD CONSTRAINT "person_invitations_personId_fkey"
    FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, matching PersonAccessEvent.actorUserId: erasing the inviter's
-- account must not destroy the record of an offer made to somebody else.
ALTER TABLE "person_invitations"
    ADD CONSTRAINT "person_invitations_invitedByUserId_fkey"
    FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
