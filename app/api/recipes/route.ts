import { NextResponse } from "next/server";
import { CollaborationResourceType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
  canAccessShoppingListOwner,
  getRecipeAccessibleToUser,
  getSharedRecipeIds,
} from "@/lib/collaboration";

const ownerSelect = { id: true, name: true, email: true } as const;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sharedRecipeIds = await getSharedRecipeIds(user.id);
  const visibilityFilters: Prisma.RecipeWhereInput[] = [{ ownerId: user.id }];
  if (sharedRecipeIds.length) {
    visibilityFilters.push({ id: { in: sharedRecipeIds } });
  }

  const recipes = await prisma.recipe.findMany({
    where:
      visibilityFilters.length === 1
        ? visibilityFilters[0]
        : { OR: visibilityFilters },
    orderBy: [
      { sortOrder: "asc" },
      { createdAt: "asc" },
    ],
    include: {
      owner: { select: ownerSelect },
      favorites: { select: { userId: true } },
    },
  });

  const hydrated = recipes.map((recipe) => {
    const { favorites, ...rest } = recipe;
    return {
      ...rest,
      isFavorite: favorites.some((favorite) => favorite.userId === user.id),
    };
  });

  return NextResponse.json({ recipes: hydrated });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    title,
    summary,
    ingredients,
    tags,
    shareWithOwnerId,
    collaboratorIds,
  } = (payload ?? {}) as {
    title?: unknown;
    summary?: unknown;
    ingredients?: unknown;
    tags?: unknown;
    shareWithOwnerId?: unknown;
    collaboratorIds?: unknown;
  };

  if (typeof title !== "string" || !title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  if (!Array.isArray(ingredients) || ingredients.some((item) => typeof item !== "string")) {
    return NextResponse.json(
      { error: "Ingredients must be an array of strings" },
      { status: 400 }
    );
  }

  let normalizedTags: string[] = [];
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((item) => typeof item !== "string")) {
      return NextResponse.json(
        { error: "Tags must be an array of strings" },
        { status: 400 }
      );
    }
    normalizedTags = Array.from(
      new Set(tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean))
    );
  }

  let shareTargetUser:
    | {
        id: string;
        email: string | null;
      }
    | null = null;
  if (shareWithOwnerId !== undefined) {
    if (typeof shareWithOwnerId !== "string" || !shareWithOwnerId.trim()) {
      return NextResponse.json(
        { error: "shareWithOwnerId must be a non-empty string" },
        { status: 400 }
      );
    }
    const trimmedShareTarget = shareWithOwnerId.trim();
    if (trimmedShareTarget !== user.id) {
      const canShare = await canAccessShoppingListOwner(
        user.id,
        trimmedShareTarget
      );
      if (!canShare) {
        return NextResponse.json(
          { error: "You do not have access to share with that user" },
          { status: 403 }
        );
      }
      const targetUser = await prisma.user.findUnique({
        where: { id: trimmedShareTarget },
        select: { id: true, email: true },
      });
      if (!targetUser) {
        return NextResponse.json(
          { error: "Unable to find that collaborator" },
          { status: 404 }
        );
      }
      shareTargetUser = targetUser;
    }
  }

  let collaboratorTargets: {
    id: string;
    email: string | null;
  }[] = [];
  if (collaboratorIds !== undefined) {
    if (!Array.isArray(collaboratorIds)) {
      return NextResponse.json(
        { error: "collaboratorIds must be an array of strings" },
        { status: 400 }
      );
    }
    const normalized = collaboratorIds
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    if (normalized.length) {
      const collaborators = await prisma.user.findMany({
        where: { id: { in: normalized } },
        select: { id: true, email: true },
      });
      collaboratorTargets = collaborators.filter(
        (entry) => entry.id !== user.id
      );
    }
  }

  try {
    const lowestOrder = await prisma.recipe.aggregate({
      where: { ownerId: user.id },
      _min: { sortOrder: true },
    });
    const nextSortOrder =
      typeof lowestOrder._min.sortOrder === "number"
        ? lowestOrder._min.sortOrder - 1
        : 0;

    const recipe = await prisma.recipe.create({
      data: {
        ownerId: user.id,
        createdById: user.id,
        updatedById: user.id,
        title: title.trim(),
        summary:
          typeof summary === "string" && summary.trim().length
            ? summary.trim()
            : null,
        ingredients,
        tags: normalizedTags,
        sortOrder: nextSortOrder,
      },
      include: { owner: { select: ownerSelect } },
    });

    const collaboratorList = shareTargetUser
      ? [shareTargetUser, ...collaboratorTargets]
      : collaboratorTargets;
    if (collaboratorList.length) {
      await Promise.all(
        collaboratorList.map((target) =>
          prisma.collaboration.upsert({
            where: {
              resourceType_resourceId_collaboratorId: {
                resourceType: CollaborationResourceType.RECIPE,
                resourceId: recipe.id,
                collaboratorId: target.id,
              },
            },
            update: {
              acceptedAt: new Date(),
              invitedEmail: target.email?.toLowerCase() ?? "",
            },
            create: {
              resourceType: CollaborationResourceType.RECIPE,
              resourceId: recipe.id,
              ownerId: user.id,
              collaboratorId: target.id,
              invitedEmail: target.email?.toLowerCase() ?? "",
              acceptedAt: new Date(),
            },
          })
        )
      ).catch((shareError) => {
        console.error("Failed to auto-share recipe", shareError);
      });
    }
    return NextResponse.json({ recipe }, { status: 201 });
  } catch (error) {
    console.error("Failed to create recipe", error);
    return NextResponse.json({ error: "Failed to create recipe" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { id, title, summary, ingredients, tags } = (payload ?? {}) as {
    id?: unknown;
    title?: unknown;
    summary?: unknown;
    ingredients?: unknown;
    tags?: unknown;
  };

  if (typeof id !== "string" || !id.trim()) {
    return NextResponse.json({ error: "Recipe id is required" }, { status: 400 });
  }
  if (typeof title !== "string" || !title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (!Array.isArray(ingredients) || ingredients.some((item) => typeof item !== "string")) {
    return NextResponse.json(
      { error: "Ingredients must be an array of strings" },
      { status: 400 }
    );
  }

  let normalizedTags: string[] = [];
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((item) => typeof item !== "string")) {
      return NextResponse.json(
        { error: "Tags must be an array of strings" },
        { status: 400 }
      );
    }
    normalizedTags = Array.from(
      new Set(tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean))
    );
  }

  try {
    const recipe = await getRecipeAccessibleToUser(user.id, id);
    if (!recipe) {
      return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
    }

    const updatedRecipe = await prisma.recipe.update({
      where: { id: recipe.id },
      data: {
        title: title.trim(),
        summary:
          typeof summary === "string" && summary.trim().length
            ? summary.trim()
            : null,
        ingredients,
        tags: normalizedTags,
        updatedById: user.id,
      },
      include: { owner: { select: ownerSelect } },
    });

    return NextResponse.json({ recipe: updatedRecipe });
  } catch (error) {
    console.error("Failed to update recipe", error);
    return NextResponse.json({ error: "Failed to update recipe" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { id, isFavorite } = (payload ?? {}) as {
    id?: unknown;
    isFavorite?: unknown;
  };

  if (typeof id !== "string" || !id.trim()) {
    return NextResponse.json({ error: "Recipe id is required" }, { status: 400 });
  }
  if (typeof isFavorite !== "boolean") {
    return NextResponse.json(
      { error: "isFavorite must be provided as a boolean" },
      { status: 400 }
    );
  }

  const recipe = await getRecipeAccessibleToUser(user.id, id);
  if (!recipe) {
    return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
  }

  if (recipe.ownerId === user.id) {
    await prisma.recipe.update({
      where: { id: recipe.id },
      data: { updatedById: user.id },
    });
  }

  if (isFavorite) {
    await prisma.recipeFavorite.upsert({
      where: { recipeId_userId: { recipeId: recipe.id, userId: user.id } },
      update: {},
      create: { recipeId: recipe.id, userId: user.id },
    });
  } else {
    await prisma.recipeFavorite.deleteMany({
      where: { recipeId: recipe.id, userId: user.id },
    });
  }

  const updatedRecipe = await prisma.recipe.findUnique({
    where: { id: recipe.id },
    include: { owner: { select: ownerSelect } },
  });

  if (!updatedRecipe) {
    return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
  }

  const isFavoriteForUser = await prisma.recipeFavorite.findFirst({
    where: { recipeId: recipe.id, userId: user.id },
  });

  return NextResponse.json({
    recipe: {
      ...updatedRecipe,
      isFavorite: Boolean(isFavoriteForUser),
    },
  });
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { id } = (payload ?? {}) as { id?: unknown };

  if (typeof id !== "string" || !id.trim()) {
    return NextResponse.json({ error: "Recipe id is required" }, { status: 400 });
  }

  try {
    const recipe = await getRecipeAccessibleToUser(user.id, id);
    if (!recipe) {
      return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
    }

    await prisma.recipe.delete({ where: { id: recipe.id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete recipe", error);
    return NextResponse.json({ error: "Failed to delete recipe" }, { status: 500 });
  }
}
