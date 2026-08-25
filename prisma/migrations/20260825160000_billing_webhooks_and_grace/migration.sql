-- Inbound provider events, and the columns that make them safe to apply.
--
-- Additive. Nothing existing is altered.
--
--  * billing_webhook_events is the outbox pattern pointed inward: persist,
--    acknowledge, then process. Unique on (provider, providerEventId) so a
--    replay loses the insert and applies nothing — keyed on the provider's id
--    rather than the payload, because a resend may be byte-identical or
--    re-serialised and neither should matter.
--
--  * subscriptions."providerUpdatedAt" is the high-water mark for out-of-order
--    protection. Webhooks arrive out of order; arrival order is not event
--    order, so an event older than this is stale and must not overwrite newer
--    state.
--
--  * subscriptions."pastDueSince" starts the grace window at the failed
--    charge rather than at period end — otherwise one subscriber gets weeks
--    and another gets minutes, depending on when in the cycle the card failed.

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "lastReconciledAt" TIMESTAMP(3),
ADD COLUMN     "pastDueSince" TIMESTAMP(3),
ADD COLUMN     "providerUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "billing_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_webhook_events_status_receivedAt_idx" ON "billing_webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_webhook_events_provider_providerEventId_key" ON "billing_webhook_events"("provider", "providerEventId");

