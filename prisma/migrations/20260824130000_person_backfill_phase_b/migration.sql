-- Person / Account separation — PHASE B (backfill).
--
-- The first DML migration in this project. Every statement is written to be
-- re-runnable: inserts are guarded by ON CONFLICT DO NOTHING or NOT EXISTS,
-- and updates are guarded by "personId" IS NULL. Running it twice changes
-- nothing the second time.
--
-- What it does, in order:
--   1. one self-Person per account (ownerUserId = users.id, claimedAt = createdAt)
--   2. one OWNER / ACTIVE membership per self-Person, receivesNotifications = true
--   3. copy the clinical columns out of profiles into person_health_profiles
--   4. set personId on every clinical row from its existing userId
--
-- What it does NOT do:
--   * userId is left populated and authoritative on every clinical row
--   * profiles keeps its clinical columns; they remain the source of truth
--   * no column is dropped, no constraint is tightened, no cascade is swapped
--   * activity_logs."actorUserId" is deliberately left NULL — see the report
--
-- Rollback at this stage is a code revert, not a data operation, because
-- nothing reads "personId" yet. To undo the data as well:
--   UPDATE "care_plans"        SET "personId" = NULL;
--   UPDATE "symptom_logs"      SET "personId" = NULL;
--   UPDATE "mood_logs"         SET "personId" = NULL;
--   UPDATE "drug_detections"   SET "personId" = NULL;
--   UPDATE "medication_drafts" SET "personId" = NULL;
--   UPDATE "activity_logs"     SET "personId" = NULL;
--   DELETE FROM "person_health_profiles";
--   DELETE FROM "person_memberships";
--   DELETE FROM "persons";

-- ─────────────────────────────────────────────────────────────
-- 1. One self-Person per account.
--
-- A self-Person owns itself: ownerUserId points back at the account, so by the
-- capacity rule (managed = OWNER membership over a Person with ownerUserId
-- IS NULL) it consumes no managed slot. claimedAt is the account's createdAt —
-- the account has always been its own subject; separation only names it.
--
-- Guarded by NOT EXISTS rather than ON CONFLICT because there is no unique
-- index on persons."ownerUserId". See the report: adding a partial unique
-- index would enforce this structurally and is recommended.
-- ─────────────────────────────────────────────────────────────
INSERT INTO "persons" (
  "id", "displayName", "dateOfBirth", "gender",
  "ownerUserId", "claimedAt", "createdByUserId", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  COALESCE(
    NULLIF(TRIM(CONCAT_WS(' ', u."firstName", u."lastName")), ''),
    u."email"
  ),
  p."dateOfBirth",
  p."gender",
  u."id",
  u."createdAt",
  u."id",
  u."createdAt",
  NOW()
FROM "users" u
LEFT JOIN "profiles" p ON p."userId" = u."id"
WHERE NOT EXISTS (
  SELECT 1 FROM "persons" ex WHERE ex."ownerUserId" = u."id"
);

-- ─────────────────────────────────────────────────────────────
-- 2. One OWNER / ACTIVE membership per self-Person.
--
-- receivesNotifications = true only here: for a managed Person the managing
-- account receives delivery, and a self-Person's managing account is itself.
-- Connected-account routing is modelled but not built, so no other membership
-- is ever created with this flag set in phase B.
-- ─────────────────────────────────────────────────────────────
INSERT INTO "person_memberships" (
  "id", "personId", "userId", "role", "status",
  "receivesNotifications", "invitedAt", "acceptedAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  p."id",
  p."ownerUserId",
  'OWNER'::"PersonRole",
  'ACTIVE'::"MembershipStatus",
  TRUE,
  u."createdAt",
  u."createdAt",
  u."createdAt",
  NOW()
FROM "persons" p
JOIN "users" u ON u."id" = p."ownerUserId"
WHERE p."ownerUserId" IS NOT NULL
ON CONFLICT ("personId", "userId") DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 3. Copy the clinical columns out of profiles.
--
-- A copy, not a move. profiles keeps every column and stays the source of
-- truth until the compatibility window closes; nothing reads this table yet.
-- ─────────────────────────────────────────────────────────────
INSERT INTO "person_health_profiles" (
  "id", "personId",
  "bloodGroup", "genotype", "heightCm", "weightKg",
  "allergies", "existingConditions", "currentMedications", "disabilities",
  "smokingStatus", "alcoholUse", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  p."id",
  pr."bloodGroup",
  pr."genotype",
  pr."heightCm",
  pr."weightKg",
  pr."allergies",
  pr."existingConditions",
  pr."currentMedications",
  pr."disabilities",
  pr."smokingStatus",
  pr."alcoholUse",
  NOW(),
  NOW()
FROM "persons" p
JOIN "profiles" pr ON pr."userId" = p."ownerUserId"
WHERE p."ownerUserId" IS NOT NULL
ON CONFLICT ("personId") DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 4. Point every clinical row at its subject.
--
-- Each row's existing userId identifies the account; that account's
-- self-Person is the subject. CareEvent, Reminder, NotificationAttempt,
-- Medication and PregnancyProfile are absent on purpose — they reach the
-- subject transitively through care_plans and must not gain a column.
-- ─────────────────────────────────────────────────────────────
UPDATE "care_plans" c
   SET "personId" = p."id"
  FROM "persons" p
 WHERE p."ownerUserId" = c."userId"
   AND c."personId" IS NULL;

UPDATE "symptom_logs" s
   SET "personId" = p."id"
  FROM "persons" p
 WHERE p."ownerUserId" = s."userId"
   AND s."personId" IS NULL;

UPDATE "mood_logs" m
   SET "personId" = p."id"
  FROM "persons" p
 WHERE p."ownerUserId" = m."userId"
   AND m."personId" IS NULL;

UPDATE "drug_detections" d
   SET "personId" = p."id"
  FROM "persons" p
 WHERE p."ownerUserId" = d."userId"
   AND d."personId" IS NULL;

UPDATE "medication_drafts" md
   SET "personId" = p."id"
  FROM "persons" p
 WHERE p."ownerUserId" = md."userId"
   AND md."personId" IS NULL;

UPDATE "activity_logs" a
   SET "personId" = p."id"
  FROM "persons" p
 WHERE p."ownerUserId" = a."userId"
   AND a."personId" IS NULL;
