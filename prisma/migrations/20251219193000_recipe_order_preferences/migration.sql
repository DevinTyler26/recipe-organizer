-- Create per-user recipe ordering table
CREATE TABLE "RecipeOrderPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecipeOrderPreference_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RecipeOrderPreference"
  ADD CONSTRAINT "RecipeOrderPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecipeOrderPreference"
  ADD CONSTRAINT "RecipeOrderPreference_recipeId_fkey"
  FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "RecipeOrderPreference_userId_recipeId_key"
  ON "RecipeOrderPreference" ("userId", "recipeId");

CREATE INDEX "RecipeOrderPreference_recipeId_idx"
  ON "RecipeOrderPreference" ("recipeId");

CREATE INDEX "RecipeOrderPreference_userId_sortOrder_idx"
  ON "RecipeOrderPreference" ("userId", "sortOrder");
