import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
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
    include: { owner: { select: ownerSelect } },
  });

  return NextResponse.json({ recipes });
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

  const { title, summary, ingredients, tags } = (payload ?? {}) as {
    title?: unknown;
    summary?: unknown;
    ingredients?: unknown;
    tags?: unknown;
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

  const updatedRecipe = await prisma.recipe.update({
    where: { id: recipe.id },
    data: { isFavorite, updatedById: user.id },
    include: { owner: { select: ownerSelect } },
  });

  return NextResponse.json({ recipe: updatedRecipe });
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
