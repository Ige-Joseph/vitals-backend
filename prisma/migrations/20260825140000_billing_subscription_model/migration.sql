-- Billing: subscriptions, prices and money movements.
--
-- Purely additive. Three new tables and four enums; nothing existing is
-- altered, so rollback is dropping them.
--
-- Two design points worth reading before changing any of this:
--
--  * A price row is immutable once anyone may have bought it. Repricing means
--    inserting a new row and retiring the old one, never editing amountMinor.
--    A subscription points at its price row, so that is what keeps an existing
--    subscriber on the price they signed up at.
--
--  * payment_transactions."userId" and ."subscriptionId" are both nullable on
--    purpose. A refund or chargeback can arrive after the account has been
--    erased, and it still has to land somewhere. Erasure nulls the user link
--    and keeps the row: a financial record has its own basis for retention,
--    and providerReference / providerCustomerRef carry no personal data.
--
-- subscriptions."userId" is RESTRICT like every other account-owned record, so
-- a subscription outlives an attempt to hard-delete the account.

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('NONE', 'PAYSTACK', 'FLUTTERWAVE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentTransactionType" AS ENUM ('CHARGE', 'REFUND', 'CHARGEBACK');

-- CreateEnum
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "prices" (
    "id" TEXT NOT NULL,
    "tier" "PlanType" NOT NULL,
    "label" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "interval" TEXT NOT NULL,
    "intervalCount" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "provisional" BOOLEAN NOT NULL DEFAULT true,
    "providerPriceId" TEXT,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "priceId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'INCOMPLETE',
    "provider" "PaymentProvider" NOT NULL DEFAULT 'NONE',
    "providerSubscriptionId" TEXT,
    "providerCustomerRef" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "cancellationRequestedAt" TIMESTAMP(3),
    "cancellationConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "subscriptionId" TEXT,
    "provider" "PaymentProvider" NOT NULL,
    "providerReference" TEXT NOT NULL,
    "providerCustomerRef" TEXT,
    "type" "PaymentTransactionType" NOT NULL,
    "status" "PaymentTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prices_tier_active_idx" ON "prices"("tier", "active");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_providerSubscriptionId_key" ON "subscriptions"("providerSubscriptionId");

-- CreateIndex
CREATE INDEX "subscriptions_userId_status_idx" ON "subscriptions"("userId", "status");

-- CreateIndex
CREATE INDEX "subscriptions_status_currentPeriodEnd_idx" ON "subscriptions"("status", "currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_providerReference_key" ON "payment_transactions"("providerReference");

-- CreateIndex
CREATE INDEX "payment_transactions_userId_occurredAt_idx" ON "payment_transactions"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "payment_transactions_subscriptionId_occurredAt_idx" ON "payment_transactions"("subscriptionId", "occurredAt");

-- CreateIndex
CREATE INDEX "payment_transactions_providerCustomerRef_idx" ON "payment_transactions"("providerCustomerRef");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

