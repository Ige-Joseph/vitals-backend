-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('IN_PROGRESS', 'READY_FOR_REVIEW', 'NEEDS_MANUAL_REVIEW', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DraftSource" AS ENUM ('TEXT', 'AUDIO');

-- CreateTable
CREATE TABLE "medication_drafts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "extractedData" JSONB NOT NULL DEFAULT '{}',
    "missingFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "turnCount" INTEGER NOT NULL DEFAULT 1,
    "status" "DraftStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "confidence" DOUBLE PRECISION,
    "source" "DraftSource" NOT NULL DEFAULT 'TEXT',
    "transcript" TEXT,
    "lastQuestion" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medication_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medication_drafts_userId_status_idx" ON "medication_drafts"("userId", "status");

-- CreateIndex
CREATE INDEX "medication_drafts_status_idx" ON "medication_drafts"("status");

-- CreateIndex
CREATE INDEX "medication_drafts_expiresAt_idx" ON "medication_drafts"("expiresAt");

-- AddForeignKey
ALTER TABLE "medication_drafts" ADD CONSTRAINT "medication_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
