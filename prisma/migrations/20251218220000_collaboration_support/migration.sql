-- Remove old foreign keys tied to the previous ownership column names
ALTER TABLE "Recipe" DROP CONSTRAINT IF EXISTS "Recipe_userId_fkey";
ALTER TABLE "ShoppingListEntry" DROP CONSTRAINT IF EXISTS "ShoppingListEntry_userId_fkey";

-- Rename ownership columns to reflect collaboration support
ALTER TABLE "Recipe" RENAME COLUMN "userId" TO "ownerId";
ALTER TABLE "ShoppingListEntry" RENAME COLUMN "userId" TO "ownerId";

-- Add creator/updater tracking columns (temporarily nullable)
ALTER TABLE "Recipe"
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "updatedById" TEXT;

ALTER TABLE "ShoppingListEntry"
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "updatedById" TEXT;

-- Copy ownership data into the new fields
UPDATE "Recipe" SET "createdById" = "ownerId", "updatedById" = "ownerId";
UPDATE "ShoppingListEntry" SET "createdById" = "ownerId", "updatedById" = "ownerId";

-- Enforce not-null constraints now that data is populated
ALTER TABLE "Recipe"
  ALTER COLUMN "createdById" SET NOT NULL,
  ALTER COLUMN "updatedById" SET NOT NULL;

ALTER TABLE "ShoppingListEntry"
  ALTER COLUMN "createdById" SET NOT NULL,
  ALTER COLUMN "updatedById" SET NOT NULL;

-- Create supporting enum + collaboration table
CREATE TYPE "CollaborationResourceType" AS ENUM ('RECIPE', 'SHOPPING_LIST');

CREATE TABLE "Collaboration" (
  "id" TEXT NOT NULL,
  "resourceType" "CollaborationResourceType" NOT NULL,
  "resourceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "collaboratorId" TEXT NOT NULL,
  "invitedEmail" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Collaboration_pkey" PRIMARY KEY ("id")
);

-- Refresh indexes tied to ownership
DROP INDEX IF EXISTS "Recipe_userId_createdAt_idx";
DROP INDEX IF EXISTS "Recipe_userId_sortOrder_idx";
CREATE INDEX "Recipe_ownerId_createdAt_idx" ON "Recipe" ("ownerId", "createdAt");
CREATE INDEX "Recipe_ownerId_sortOrder_idx" ON "Recipe" ("ownerId", "sortOrder");

DROP INDEX IF EXISTS "ShoppingListEntry_userId_normalizedLabel_idx";
CREATE INDEX "ShoppingListEntry_ownerId_normalizedLabel_idx" ON "ShoppingListEntry" ("ownerId", "normalizedLabel");

-- Wire up foreign keys for the new tracking columns and collaboration table
ALTER TABLE "Recipe"
  ADD CONSTRAINT "Recipe_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Recipe_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Recipe_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShoppingListEntry"
  ADD CONSTRAINT "ShoppingListEntry_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ShoppingListEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ShoppingListEntry_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Collaboration"
  ADD CONSTRAINT "Collaboration_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Collaboration_collaboratorId_fkey" FOREIGN KEY ("collaboratorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Collaboration_resource_idx" ON "Collaboration" ("resourceType", "resourceId");
CREATE INDEX "Collaboration_collaboratorId_idx" ON "Collaboration" ("collaboratorId");
CREATE UNIQUE INDEX "Collaboration_unique_share_idx" ON "Collaboration" ("resourceType", "resourceId", "collaboratorId");
