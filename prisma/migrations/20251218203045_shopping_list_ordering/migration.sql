-- Add sort order column for manual shopping list reordering
ALTER TABLE "ShoppingListEntry"
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Seed existing rows with a stable per-user order based on creation time
WITH numbered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "createdAt") - 1 AS position
  FROM "ShoppingListEntry"
)
UPDATE "ShoppingListEntry" AS s
SET "sortOrder" = numbered.position
FROM numbered
WHERE numbered.id = s.id;
