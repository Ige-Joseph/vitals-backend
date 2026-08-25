-- Move gender and date of birth onto the Person.
--
-- They describe a body, not a login. Person already carries both columns —
-- babies get a date of birth from the delivery date — so this is a backfill,
-- not a schema change. Nothing is added and nothing is dropped.
--
-- Profile keeps both columns, retained and unread, exactly as its clinical
-- columns are. They stop being the source of truth here; they are removed
-- when the compatibility window closes, together with the clinical ones.
--
-- Idempotent twice over: only self-Persons are touched, and only where the
-- Person's own value is still NULL. Re-running matches nothing, and a value
-- already recorded against the Person is never overwritten by the older copy
-- on Profile.
--
-- Rollback: UPDATE "persons" SET "gender" = NULL, "dateOfBirth" = NULL
--           WHERE "origin" = 'SELF';
--   ...which is safe only because Profile still holds the originals. That
--   stops being true once the window closes.

UPDATE "persons" p
   SET "gender" = pr."gender"
  FROM "profiles" pr
 WHERE pr."userId" = p."ownerUserId"
   AND p."ownerUserId" IS NOT NULL
   AND p."gender" IS NULL
   AND pr."gender" IS NOT NULL;

UPDATE "persons" p
   SET "dateOfBirth" = pr."dateOfBirth"
  FROM "profiles" pr
 WHERE pr."userId" = p."ownerUserId"
   AND p."ownerUserId" IS NOT NULL
   AND p."dateOfBirth" IS NULL
   AND pr."dateOfBirth" IS NOT NULL;
