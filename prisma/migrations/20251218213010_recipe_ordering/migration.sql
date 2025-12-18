-- Add sortOrder column to recipes for manual ordering
ALTER TABLE "Recipe" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Seed existing rows with sequential sortOrder values per user
WITH ordered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "createdAt" ASC) - 1 AS row_index
  FROM "Recipe"
)
UPDATE "Recipe" AS r
SET "sortOrder" = ordered.row_index
FROM ordered
WHERE r."id" = ordered."id";

-- Support queries that look up recipes by user order
CREATE INDEX "Recipe_userId_sortOrder_idx" ON "Recipe" ("userId", "sortOrder");
