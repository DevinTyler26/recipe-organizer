import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  IncomingIngredient,
  QuantityEntry,
  ShoppingListState,
  normalizeLabel,
  parseIngredient,
} from "@/lib/shopping-list";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const entries = await prisma.shoppingListEntry.findMany({
    where: { userId: user.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const grouped: ShoppingListState = {};
  entries.forEach((entry) => {
    const key = entry.normalizedLabel;
    const record = grouped[key];
    const quantityEntry: QuantityEntry = {
      id: entry.id,
      quantityText: entry.quantityText,
      amountValue: entry.amountValue ?? null,
      measureText: entry.measureText ?? "",
      sourceRecipeId: entry.sourceRecipeId ?? undefined,
      sourceRecipeTitle: entry.sourceRecipeTitle ?? undefined,
    };
    if (record) {
      record.entries.push(quantityEntry);
      record.order = Math.min(record.order, entry.sortOrder ?? 0);
    } else {
      grouped[key] = {
        label: entry.label,
        entries: [quantityEntry],
        order: entry.sortOrder ?? 0,
      };
    }
  });

  return NextResponse.json({ state: grouped });
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

  const { ingredients } = (payload ?? {}) as {
    ingredients?: unknown;
  };

  if (!Array.isArray(ingredients)) {
    return NextResponse.json(
      { error: "ingredients must be an array" },
      { status: 400 }
    );
  }

  const parsedEntries = ingredients
    .map((incoming) => incoming as IncomingIngredient)
    .filter((item): item is IncomingIngredient => typeof item?.value === "string")
    .map((item) => ({
      parsed: parseIngredient(item.value),
      meta: {
        recipeId: item.recipeId,
        recipeTitle: item.recipeTitle,
      },
    }))
    .filter(({ parsed }) => Boolean(parsed.label && parsed.normalizedLabel))
    .map(({ parsed, meta }) => ({ parsed, meta }));

  if (!parsedEntries.length) {
    return NextResponse.json(
      { error: "No valid ingredients provided" },
      { status: 400 }
    );
  }

  const uniqueLabels = Array.from(
    new Set(parsedEntries.map(({ parsed }) => parsed.normalizedLabel))
  );

  const existingOrders = uniqueLabels.length
    ? await prisma.shoppingListEntry.findMany({
        where: { userId: user.id, normalizedLabel: { in: uniqueLabels } },
        select: { normalizedLabel: true, sortOrder: true },
        orderBy: { sortOrder: "asc" },
      })
    : [];

  const orderAssignments = new Map<string, number>();
  existingOrders.forEach((entry) => {
    if (!orderAssignments.has(entry.normalizedLabel)) {
      orderAssignments.set(entry.normalizedLabel, entry.sortOrder ?? 0);
    }
  });

  const maxOrderAggregate = await prisma.shoppingListEntry.aggregate({
    where: { userId: user.id },
    _max: { sortOrder: true },
  });
  let orderCursor = maxOrderAggregate._max.sortOrder ?? -1;

  uniqueLabels.forEach((label) => {
    if (!orderAssignments.has(label)) {
      orderCursor += 1;
      orderAssignments.set(label, orderCursor);
    }
  });

  const entriesToCreate = parsedEntries.map(({ parsed, meta }) => ({
    userId: user.id,
    label: parsed.label,
    normalizedLabel: parsed.normalizedLabel,
    quantityText: parsed.quantityText || "As listed",
    amountValue: parsed.amountValue,
    measureText: parsed.measureText || null,
    sourceRecipeId: meta.recipeId,
    sourceRecipeTitle: meta.recipeTitle,
    sortOrder: orderAssignments.get(parsed.normalizedLabel) ?? 0,
  }));

  try {
    await prisma.shoppingListEntry.createMany({ data: entriesToCreate });
    return NextResponse.json({ inserted: entriesToCreate.length }, { status: 201 });
  } catch (error) {
    console.error("Failed to persist shopping list entries", error);
    return NextResponse.json(
      { error: "Failed to save shopping list entries" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const labelParam = searchParams.get("label");
  const normalizedLabel = labelParam
    ? (() => {
        const parsed = parseIngredient(labelParam);
        return parsed.normalizedLabel || normalizeLabel(labelParam);
      })()
    : null;

  try {
    if (normalizedLabel) {
      await prisma.shoppingListEntry.deleteMany({
        where: { userId: user.id, normalizedLabel },
      });
    } else {
      await prisma.shoppingListEntry.deleteMany({ where: { userId: user.id } });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete shopping list entries", error);
    return NextResponse.json(
      { error: "Failed to delete shopping list entries" },
      { status: 500 }
    );
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

  const { order } = (payload ?? {}) as { order?: unknown };
  if (!Array.isArray(order) || order.some((item) => typeof item !== "string")) {
    return NextResponse.json(
      { error: "order must be an array of labels" },
      { status: 400 }
    );
  }

  const normalizedOrder = order
    .map((label) => {
      const parsed = parseIngredient(label);
      return parsed.normalizedLabel || normalizeLabel(label);
    })
    .filter((label) => Boolean(label)) as string[];

  if (!normalizedOrder.length) {
    return NextResponse.json(
      { error: "order must include at least one valid label" },
      { status: 400 }
    );
  }

  const seen = new Set<string>();
  const deduped = normalizedOrder.filter((label) => {
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });

  try {
    await prisma.$transaction(
      deduped.map((label, index) =>
        prisma.shoppingListEntry.updateMany({
          where: { userId: user.id, normalizedLabel: label },
          data: { sortOrder: index },
        })
      )
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to reorder shopping list", error);
    return NextResponse.json(
      { error: "Failed to reorder shopping list" },
      { status: 500 }
    );
  }
}
