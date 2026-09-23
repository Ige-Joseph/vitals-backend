-- Provider handles, and a resting place for events that will never succeed.
--
-- Additive. Adding an enum value is catalog-only; the column has a default so
-- no row is rewritten.
--
--  * subscriptions."providerMetadata" is opaque to everything except the
--    adapter. Paystack will not accept a cancellation with the subscription
--    code alone — it also wants an email token issued at creation time — and
--    that token has to live somewhere without putting a Paystack field name
--    in our schema.
--
--  * DEAD_LETTERED is where an event lands once retries are exhausted. It is
--    never retried automatically and it is loud, because a billing event that
--    quietly stops being processed is money going wrong unobserved.

-- AlterEnum
ALTER TYPE "WebhookEventStatus" ADD VALUE 'DEAD_LETTERED';

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "providerMetadata" JSONB NOT NULL DEFAULT '{}';

