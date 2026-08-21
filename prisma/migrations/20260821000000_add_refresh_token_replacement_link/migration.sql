-- Records which token superseded a rotated refresh token.
--
-- Adding a nullable column with no default is a catalog-only change in
-- PostgreSQL, so this takes a brief ACCESS EXCLUSIVE lock and rewrites nothing.
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "replacedByTokenHash" TEXT;
