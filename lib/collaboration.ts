import { CollaborationResourceType, type Recipe } from "@prisma/client";
import { prisma } from "./prisma";

export async function getSharedRecipeIds(userId: string) {
  const rows = await prisma.collaboration.findMany({
    where: {
      collaboratorId: userId,
      resourceType: CollaborationResourceType.RECIPE,
    },
    select: { resourceId: true },
  });
  return rows.map((row) => row.resourceId);
}

export async function getSharedShoppingListOwnerIds(userId: string) {
  const rows = await prisma.collaboration.findMany({
    where: {
      collaboratorId: userId,
      resourceType: CollaborationResourceType.SHOPPING_LIST,
    },
    select: { resourceId: true },
  });
  return rows.map((row) => row.resourceId);
}

export async function getRecipeAccessibleToUser(
  userId: string,
  recipeId: string
): Promise<Recipe | null> {
  if (!recipeId) {
    return null;
  }
  const recipe = await prisma.recipe.findUnique({ where: { id: recipeId } });
  if (!recipe) {
    return null;
  }
  if (recipe.ownerId === userId) {
    return recipe;
  }
  const collaboration = await prisma.collaboration.findFirst({
    where: {
      collaboratorId: userId,
      resourceType: CollaborationResourceType.RECIPE,
      resourceId: recipeId,
    },
  });
  return collaboration ? recipe : null;
}

export async function canAccessShoppingListOwner(
  userId: string,
  ownerId: string
) {
  if (!ownerId) {
    return false;
  }
  if (ownerId === userId) {
    return true;
  }
  const collaboration = await prisma.collaboration.findFirst({
    where: {
      collaboratorId: userId,
      resourceType: CollaborationResourceType.SHOPPING_LIST,
      resourceId: ownerId,
    },
  });
  return Boolean(collaboration);
}
