import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  collectSourceTitles,
  IncomingIngredient,
  QuantityEntry,
  ShoppingListState,
  normalizeLabel,
  parseIngredient,
} from "@/lib/shopping-list";
import { getCurrentUser } from "@/lib/auth";
import {
  canAccessShoppingListOwner,
  getSharedShoppingListOwnerIds,
} from "@/lib/collaboration";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sharedOwnerIds = await getSharedShoppingListOwnerIds(user.id);
  const ownerScope = Array.from(new Set([user.id, ...sharedOwnerIds]));

  const entries = await prisma.shoppingListEntry.findMany({
    where: { ownerId: { in: ownerScope } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const ownerRecords = await prisma.user.findMany({
    where: { id: { in: ownerScope } },
    select: { id: true, name: true, email: true, shoppingListLabel: true },
  });
  const ownerLookup = new Map(ownerRecords.map((record) => [record.id, record]));

  const groupedByOwner: Record<string, ShoppingListState> = {};
  const ensureOwnerState = (ownerId: string) => {
    if (!groupedByOwner[ownerId]) {
      groupedByOwner[ownerId] = {};
    }
    return groupedByOwner[ownerId];
  };

  entries.forEach((entry) => {
    const ownerState = ensureOwnerState(entry.ownerId);
    const key = entry.normalizedLabel;
    const record = ownerState[key];
    const quantityEntry: QuantityEntry = {
      id: entry.id,
      quantityText: entry.quantityText,
      amountValue: entry.amountValue ?? null,
      measureText: entry.measureText ?? "",
      sourceRecipeId: entry.sourceRecipeId ?? undefined,
      sourceRecipeTitle: entry.sourceRecipeTitle ?? undefined,
    };
    const crossedOffAt = entry.crossedOffAt
      ? entry.crossedOffAt.getTime()
      : null;
    if (record) {
      record.entries.push(quantityEntry);
      record.order = Math.min(record.order, entry.sortOrder ?? 0);
      if (crossedOffAt !== null) {
        const existingCrossedAt =
          typeof record.crossedOffAt === "number"
            ? record.crossedOffAt
            : null;
        record.crossedOffAt =
          existingCrossedAt === null
            ? crossedOffAt
            : Math.min(existingCrossedAt, crossedOffAt);
      }
    } else {
      ownerState[key] = {
        label: entry.label,
        entries: [quantityEntry],
        order: entry.sortOrder ?? 0,
        crossedOffAt,
      };
    }
  });

  const lists = ownerScope.map((ownerId) => {
    const ownerRecord = ownerLookup.get(ownerId);
    const fallbackLabel = ownerId === user.id ? "Your list" : "Shared list";
    const ownerDisplayName =
      ownerRecord?.name?.trim() ||
      ownerRecord?.email?.trim() ||
      (ownerId === user.id ? "You" : "Shared list owner");
    const ownerLabel =
      ownerRecord?.shoppingListLabel?.trim() || fallbackLabel;
    return {
      ownerId,
      ownerLabel,
      ownerDisplayName,
      isSelf: ownerId === user.id,
      state: groupedByOwner[ownerId] ?? {},
    };
  });

  return NextResponse.json({ lists });
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

  const { ingredients, ownerId } = (payload ?? {}) as {
    ingredients?: unknown;
    ownerId?: unknown;
  };

  const targetOwnerId =
    typeof ownerId === "string" && ownerId.trim().length
      ? ownerId.trim()
      : user.id;

  const hasAccess = await canAccessShoppingListOwner(user.id, targetOwnerId);
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
      where: { ownerId: targetOwnerId, normalizedLabel: { in: uniqueLabels } },
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
    where: { ownerId: targetOwnerId },
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
    ownerId: targetOwnerId,
    createdById: user.id,
    updatedById: user.id,
    label: parsed.label,
    normalizedLabel: parsed.normalizedLabel,
    quantityText: parsed.quantityText || "As listed",
    amountValue: parsed.amountValue,
    measureText: parsed.measureText || null,
    sourceRecipeId: meta.recipeId,
    sourceRecipeTitle: meta.recipeTitle,
    sortOrder: orderAssignments.get(parsed.normalizedLabel) ?? 0,
    crossedOffAt: null,
  }));

  try {
    const operations: Parameters<typeof prisma.$transaction>[0] = [];
    if (uniqueLabels.length) {
      operations.push(
        prisma.shoppingListEntry.updateMany({
          where: {
            ownerId: targetOwnerId,
            normalizedLabel: { in: uniqueLabels },
          },
          data: { crossedOffAt: null, updatedById: user.id },
        })
      );
    }
    operations.push(prisma.shoppingListEntry.createMany({ data: entriesToCreate }));
    await prisma.$transaction(operations);
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
  const ownerParam = searchParams.get("ownerId");
  const targetOwnerId = ownerParam?.trim()?.length ? ownerParam.trim() : user.id;
  const hasAccess = await canAccessShoppingListOwner(user.id, targetOwnerId);
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const normalizedLabel = labelParam
    ? (() => {
        const parsed = parseIngredient(labelParam);
        return parsed.normalizedLabel || normalizeLabel(labelParam);
      })()
    : null;

  try {
    if (normalizedLabel) {
      await prisma.shoppingListEntry.deleteMany({
        where: { ownerId: targetOwnerId, normalizedLabel },
      });
    } else {
      await prisma.shoppingListEntry.deleteMany({ where: { ownerId: targetOwnerId } });
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

  const { ownerId, label, quantity } = (payload ?? {}) as {
    ownerId?: unknown;
    label?: unknown;
    quantity?: unknown;
  };

  if (typeof label !== "string" || !label.trim()) {
    return NextResponse.json(
      { error: "label is required" },
      { status: 400 }
    );
  }

  const targetOwnerId =
    typeof ownerId === "string" && ownerId.trim().length
      ? ownerId.trim()
      : user.id;
  const hasAccess = await canAccessShoppingListOwner(user.id, targetOwnerId);
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const normalizedLabel = normalizeLabel(label);
  const existingEntries = await prisma.shoppingListEntry.findMany({
    where: { ownerId: targetOwnerId, normalizedLabel },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const preservedSources = collectSourceTitles(existingEntries);
  const manualSourceTitle = preservedSources.length
    ? preservedSources.join(" · ")
    : "Manual adjustment";

  const existingCrossedAt = existingEntries[0]?.crossedOffAt ?? null;

  if (!existingEntries.length) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const baseLabel = existingEntries[0].label;
  const sortOrder = existingEntries.reduce((minimum, entry) => {
    if (typeof entry.sortOrder === "number") {
      return Math.min(minimum, entry.sortOrder);
    }
    return minimum;
  }, existingEntries[0].sortOrder ?? 0);

  const quantityText = typeof quantity === "string" ? quantity.trim() : "";
  const parsed = parseIngredient(
    quantityText ? `${quantityText} ${baseLabel}`.trim() : baseLabel
  );

  try {
    await prisma.$transaction([
      prisma.shoppingListEntry.deleteMany({
        where: { ownerId: targetOwnerId, normalizedLabel },
      }),
      prisma.shoppingListEntry.create({
        data: {
          ownerId: targetOwnerId,
          createdById: user.id,
          updatedById: user.id,
          label: baseLabel,
          normalizedLabel,
          quantityText: quantityText || "As listed",
          amountValue:
            quantityText && parsed.quantityText ? parsed.amountValue : null,
          measureText: parsed.measureText || null,
          sourceRecipeId: null,
          sourceRecipeTitle: manualSourceTitle,
          sortOrder,
          crossedOffAt: existingCrossedAt,
        },
      }),
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to update shopping list quantity", error);
    return NextResponse.json(
      { error: "Failed to update quantity" },
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

  const { order, ownerId, label, storageKey, crossedOffAt } = (payload ?? {}) as {
    order?: unknown;
    ownerId?: unknown;
    label?: unknown;
    storageKey?: unknown;
    crossedOffAt?: unknown;
  };

  const targetOwnerId =
    typeof ownerId === "string" && ownerId.trim().length
      ? ownerId.trim()
      : user.id;
  const hasAccess = await canAccessShoppingListOwner(user.id, targetOwnerId);
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (order !== undefined) {
    if (!Array.isArray(order) || order.some((item) => typeof item !== "string")) {
      return NextResponse.json(
        { error: "order must be an array of labels" },
        { status: 400 }
      );
    }

    const normalizedOrder = order
      .map((entry) => {
        const parsed = parseIngredient(entry);
        return parsed.normalizedLabel || normalizeLabel(entry);
      })
      .filter((entry) => Boolean(entry)) as string[];

    if (!normalizedOrder.length) {
      return NextResponse.json(
        { error: "order must include at least one valid label" },
        { status: 400 }
      );
    }

    const seen = new Set<string>();
    const deduped = normalizedOrder.filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });

    try {
      await prisma.$transaction(
        deduped.map((entry, index) =>
          prisma.shoppingListEntry.updateMany({
            where: { ownerId: targetOwnerId, normalizedLabel: entry },
            data: { sortOrder: index, updatedById: user.id },
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

  const rawLabel =
    (typeof storageKey === "string" && storageKey.trim().length
      ? storageKey.trim()
      : null) ??
    (typeof label === "string" && label.trim().length
      ? label.trim()
      : null);

  if (!rawLabel) {
    return NextResponse.json(
      { error: "label is required when updating crossed-off state" },
      { status: 400 }
    );
  }

  const parsedLabel = parseIngredient(rawLabel);
  const normalizedLabel =
    parsedLabel.normalizedLabel || normalizeLabel(rawLabel);
  if (!normalizedLabel) {
    return NextResponse.json(
      { error: "Unable to resolve shopping list item" },
      { status: 400 }
    );
  }

  let nextCrossedAt: Date | null;
  if (crossedOffAt === null) {
    nextCrossedAt = null;
  } else if (
    typeof crossedOffAt === "number" &&
    Number.isFinite(crossedOffAt)
  ) {
    nextCrossedAt = new Date(crossedOffAt);
  } else if (
    typeof crossedOffAt === "string" &&
    crossedOffAt.trim().length
  ) {
    const parsedDate = new Date(crossedOffAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return NextResponse.json(
        { error: "Invalid crossedOffAt timestamp" },
        { status: 400 }
      );
    }
    nextCrossedAt = parsedDate;
  } else {
    return NextResponse.json(
      { error: "crossedOffAt must be a timestamp or null" },
      { status: 400 }
    );
  }

  try {
    const result = await prisma.shoppingListEntry.updateMany({
      where: { ownerId: targetOwnerId, normalizedLabel },
      data: { crossedOffAt: nextCrossedAt, updatedById: user.id },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to update crossed-off state", error);
    return NextResponse.json(
      { error: "Failed to update crossed-off state" },
      { status: 500 }
    );
  }
}
