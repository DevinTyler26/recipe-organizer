import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

  const recipes = await prisma.recipe.findMany({
    where: { userId: user.id },
    select: { id: true },
    orderBy: [
      { sortOrder: "asc" },
      { createdAt: "asc" },
    ],
  });

  if (recipes.length === 0) {
    return NextResponse.json({ success: true });
  }

  const existingIds = recipes.map((recipe) => recipe.id);
  const existingIdSet = new Set(existingIds);
  const sanitizedOrder: string[] = [];
  const usedIds = new Set<string>();
  for (const id of order as string[]) {
    if (!existingIdSet.has(id) || usedIds.has(id)) {
      continue;
    }
    sanitizedOrder.push(id);
    usedIds.add(id);
  }

  const sanitizedSet = new Set(sanitizedOrder);
  const finalOrder = [
    ...sanitizedOrder,
    ...existingIds.filter((id) => !sanitizedSet.has(id)),
  ];

  await prisma.$transaction(
    finalOrder.map((id, index) =>
      prisma.recipe.updateMany({
        where: { id, userId: user.id },
        data: { sortOrder: index },
      })
    )
  );

  return NextResponse.json({ success: true });
}
