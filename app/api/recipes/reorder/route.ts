import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSharedRecipeIds } from "@/lib/collaboration";

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

  const { order } = (payload ?? {}) as { order?: unknown };
  if (!Array.isArray(order) || order.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "order must be an array of ids" }, { status: 400 });
  }

  const [ownedRecipes, sharedRecipeIds] = await Promise.all([
    prisma.recipe.findMany({
      where: { ownerId: user.id },
      select: { id: true },
      orderBy: [
        { sortOrder: "asc" },
        { createdAt: "asc" },
      ],
    }),
    getSharedRecipeIds(user.id),
  ]);

  const sharedRecipes = sharedRecipeIds.length
    ? await prisma.recipe.findMany({
        where: { id: { in: sharedRecipeIds } },
        select: { id: true },
        orderBy: [
          { sortOrder: "asc" },
          { createdAt: "asc" },
        ],
      })
    : [];

  const ownedIds = ownedRecipes.map((recipe) => recipe.id);
  const sharedIds = sharedRecipes.map((recipe) => recipe.id);
  const accessibleIds = Array.from(new Set([...ownedIds, ...sharedIds]));
  if (accessibleIds.length === 0) {
    return NextResponse.json({ success: true });
  }

  const accessibleIdSet = new Set(accessibleIds);
  const sanitizedOrder: string[] = [];
  const usedIds = new Set<string>();
  for (const id of order as string[]) {
    if (!accessibleIdSet.has(id) || usedIds.has(id)) {
      continue;
    }
    sanitizedOrder.push(id);
    usedIds.add(id);
  }

  const sanitizedSet = new Set(sanitizedOrder);
  const finalOrder = [
    ...sanitizedOrder,
    ...accessibleIds.filter((id) => !sanitizedSet.has(id)),
  ];

  if (!finalOrder.length) {
    return NextResponse.json({ success: true });
  }

  await prisma.$transaction(async (tx) => {
    const existingPreferences = await tx.recipeOrderPreference.findMany({
      where: { userId: user.id },
      select: { recipeId: true },
    });
    const finalOrderSet = new Set(finalOrder);

    for (let index = 0; index < finalOrder.length; index += 1) {
      const recipeId = finalOrder[index];
      await tx.recipeOrderPreference.upsert({
        where: {
          userId_recipeId: {
            userId: user.id,
            recipeId,
          },
        },
        update: { sortOrder: index },
        create: { userId: user.id, recipeId, sortOrder: index },
      });
    }

    const staleRecipeIds = existingPreferences
      .map((preference) => preference.recipeId)
      .filter((recipeId) => !finalOrderSet.has(recipeId));
    if (staleRecipeIds.length) {
      await tx.recipeOrderPreference.deleteMany({
        where: { userId: user.id, recipeId: { in: staleRecipeIds } },
      });
    }
  });

  return NextResponse.json({ success: true });
}
