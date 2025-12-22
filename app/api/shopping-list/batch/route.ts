import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { canAccessShoppingListOwner } from "@/lib/collaboration";
import {
  collectSourceTitles,
  IncomingIngredient,
  normalizeLabel,
  parseIngredient,
} from "@/lib/shopping-list";

const MAX_BATCH_OPERATIONS = 250;

class BatchOperationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type ParsedIngredientEntry = {
  parsed: ReturnType<typeof parseIngredient>;
  meta: {
    recipeId?: string;
    recipeTitle?: string;
  };
};

type ParsedBatchOperation =
  | {
      kind: "ADD_ITEMS";
      ownerId: string;
      position: "start" | "end";
      entries: ParsedIngredientEntry[];
    }
  | { kind: "REMOVE_ITEM"; ownerId: string; normalizedLabel: string }
  | { kind: "CLEAR_LIST"; ownerId: string }
  | { kind: "REORDER_ITEMS"; ownerId: string; order: string[] }
  | { kind: "UPDATE_QUANTITY"; ownerId: string; label: string; quantity: string }
  | {
      kind: "SET_CROSSED_OFF";
      ownerId: string;
      normalizedLabel: string;
      crossedOffAt: Date | null;
    };

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

  const rawOperations = (payload as { operations?: unknown })?.operations;
  let operations: ParsedBatchOperation[];
  try {
    operations = parseBatchOperations(rawOperations, user.id);
  } catch (error) {
    if (error instanceof BatchOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const uniqueOwnerIds = Array.from(
    new Set(operations.map((operation) => operation.ownerId))
  );

  for (const ownerId of uniqueOwnerIds) {
    const hasAccess = await canAccessShoppingListOwner(user.id, ownerId);
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (let index = 0; index < operations.length; index += 1) {
        await applyOperation(tx, operations[index], user.id, index);
      }
    });
    return NextResponse.json({ success: true, applied: operations.length });
  } catch (error) {
    if (error instanceof BatchOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Failed to apply batch shopping list updates", error);
    return NextResponse.json(
      { error: "Failed to apply shopping list updates" },
      { status: 500 }
    );
  }
}

function parseBatchOperations(
  rawOperations: unknown,
  fallbackOwnerId: string
): ParsedBatchOperation[] {
  if (!Array.isArray(rawOperations)) {
    throw new BatchOperationError("operations must be an array");
  }
  if (!rawOperations.length) {
    throw new BatchOperationError("operations cannot be empty");
  }
  if (rawOperations.length > MAX_BATCH_OPERATIONS) {
    throw new BatchOperationError(
      `operations cannot exceed ${MAX_BATCH_OPERATIONS}`
    );
  }
  return rawOperations.map((entry, index) =>
    parseOperation(entry, index, fallbackOwnerId)
  );
}

function parseOperation(
  rawOperation: unknown,
  index: number,
  fallbackOwnerId: string
): ParsedBatchOperation {
  if (!rawOperation || typeof rawOperation !== "object") {
    throw new BatchOperationError(
      `Operation ${index + 1} must be an object`
    );
  }

  const operationRecord = rawOperation as Record<string, unknown>;
  const { kind } = operationRecord as { kind?: unknown };
  if (typeof kind !== "string") {
    throw new BatchOperationError(
      `Operation ${index + 1} is missing a kind`
    );
  }

  switch (kind) {
    case "ADD_ITEMS":
      return parseAddItemsOperation(operationRecord, index, fallbackOwnerId);
    case "REMOVE_ITEM":
      return parseRemoveItemOperation(operationRecord, index, fallbackOwnerId);
    case "CLEAR_LIST":
      return parseClearListOperation(operationRecord, index, fallbackOwnerId);
    case "REORDER_ITEMS":
      return parseReorderOperation(operationRecord, index, fallbackOwnerId);
    case "UPDATE_QUANTITY":
      return parseUpdateQuantityOperation(
        operationRecord,
        index,
        fallbackOwnerId
      );
    case "SET_CROSSED_OFF":
      return parseSetCrossedOffOperation(
        operationRecord,
        index,
        fallbackOwnerId
      );
    default:
      throw new BatchOperationError(
        `Operation ${index + 1} has an unsupported kind: ${kind}`
      );
  }
}

function parseAddItemsOperation(
  rawOperation: Record<string, unknown>,
  index: number,
  fallbackOwnerId: string
): ParsedBatchOperation {
  const ownerId = resolveOwnerId(rawOperation.ownerId, fallbackOwnerId, index);
  const ingredients = rawOperation.ingredients;
  if (!Array.isArray(ingredients)) {
    throw new BatchOperationError(
      `Operation ${index + 1} ingredients must be an array`
    );
  }

  const parsedEntries = ingredients
    .map((incoming) => incoming as IncomingIngredient)
    .filter((item): item is IncomingIngredient => typeof item?.value === "string")
    .map((item) => ({
      parsed: parseIngredient(item.value),
      meta: {
        recipeId: typeof item.recipeId === "string" ? item.recipeId : undefined,
        recipeTitle:
          typeof item.recipeTitle === "string" ? item.recipeTitle : undefined,
      },
    }))
    .filter(({ parsed }) => Boolean(parsed.label && parsed.normalizedLabel));

  if (!parsedEntries.length) {
    throw new BatchOperationError(
      `Operation ${index + 1} did not include any valid ingredients`
    );
  }

  const requestedPosition =
    typeof rawOperation.position === "string" &&
    rawOperation.position.toLowerCase() === "start"
      ? "start"
      : "end";

  return {
    kind: "ADD_ITEMS",
    ownerId,
    position: requestedPosition,
    entries: parsedEntries,
  };
}

function parseRemoveItemOperation(
  rawOperation: Record<string, unknown>,
  index: number,
  fallbackOwnerId: string
): ParsedBatchOperation {
  const ownerId = resolveOwnerId(rawOperation.ownerId, fallbackOwnerId, index);
  const normalizedLabel = normalizeLabelInput(rawOperation.label, index);
  return { kind: "REMOVE_ITEM", ownerId, normalizedLabel };
}

function parseClearListOperation(
  rawOperation: Record<string, unknown>,
  index: number,
  fallbackOwnerId: string
): ParsedBatchOperation {
  const ownerId = resolveOwnerId(rawOperation.ownerId, fallbackOwnerId, index);
  return { kind: "CLEAR_LIST", ownerId };
}

function parseReorderOperation(
  rawOperation: Record<string, unknown>,
  index: number,
  fallbackOwnerId: string
): ParsedBatchOperation {
  const ownerId = resolveOwnerId(rawOperation.ownerId, fallbackOwnerId, index);
  const order = rawOperation.order;
  if (!Array.isArray(order) || order.some((entry) => typeof entry !== "string")) {
    throw new BatchOperationError(
      `Operation ${index + 1} order must be an array of strings`
    );
  }
  const normalizedOrder = order
    .map((entry) => {
      const parsed = parseIngredient(entry);
      return parsed.normalizedLabel || normalizeLabel(entry);
    })
    .filter((entry): entry is string => Boolean(entry));
  if (!normalizedOrder.length) {
    throw new BatchOperationError(
      `Operation ${index + 1} order must include at least one label`
    );
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  normalizedOrder.forEach((entry) => {
    if (seen.has(entry)) {
      return;
    }
    seen.add(entry);
    deduped.push(entry);
  });
  return { kind: "REORDER_ITEMS", ownerId, order: deduped };
}

function parseUpdateQuantityOperation(
  rawOperation: Record<string, unknown>,
  index: number,
  fallbackOwnerId: string
): ParsedBatchOperation {
  const ownerId = resolveOwnerId(rawOperation.ownerId, fallbackOwnerId, index);
  if (typeof rawOperation.label !== "string" || !rawOperation.label.trim()) {
    throw new BatchOperationError(
      `Operation ${index + 1} label is required for quantity updates`
    );
  }
  const quantity =
    typeof rawOperation.quantity === "string" ? rawOperation.quantity : "";
  return {
    kind: "UPDATE_QUANTITY",
    ownerId,
    label: rawOperation.label.trim(),
    quantity,
  };
}

function parseSetCrossedOffOperation(
  rawOperation: Record<string, unknown>,
  index: number,
  fallbackOwnerId: string
): ParsedBatchOperation {
  const ownerId = resolveOwnerId(rawOperation.ownerId, fallbackOwnerId, index);
  const normalizedLabel = normalizeLabelInput(rawOperation.label, index);
  const crossedOffAt = normalizeCrossedOffInput(rawOperation.crossedOffAt, index);
  return {
    kind: "SET_CROSSED_OFF",
    ownerId,
    normalizedLabel,
    crossedOffAt,
  };
}

function resolveOwnerId(
  ownerId: unknown,
  fallbackOwnerId: string,
  index: number
): string {
  if (typeof ownerId === "string" && ownerId.trim().length) {
    return ownerId.trim();
  }
  if (fallbackOwnerId) {
    return fallbackOwnerId;
  }
  throw new BatchOperationError(
    `Operation ${index + 1} is missing owner context`
  );
}

function normalizeLabelInput(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim().length) {
    throw new BatchOperationError(
      `Operation ${index + 1} label is required`
    );
  }
  const parsed = parseIngredient(value);
  const normalized = parsed.normalizedLabel || normalizeLabel(value);
  if (!normalized) {
    throw new BatchOperationError(
      `Operation ${index + 1} label could not be normalized`
    );
  }
  return normalized;
}

function normalizeCrossedOffInput(value: unknown, index: number): Date | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string" && value.trim().length) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BatchOperationError(
        `Operation ${index + 1} crossedOffAt is invalid`
      );
    }
    return parsed;
  }
  throw new BatchOperationError(
    `Operation ${index + 1} crossedOffAt must be a timestamp or null`
  );
}

async function applyOperation(
  tx: Prisma.TransactionClient,
  operation: ParsedBatchOperation,
  userId: string,
  index: number
) {
  switch (operation.kind) {
    case "ADD_ITEMS":
      await applyAddItems(tx, operation, userId);
      return;
    case "REMOVE_ITEM":
      await tx.shoppingListEntry.deleteMany({
        where: { ownerId: operation.ownerId, normalizedLabel: operation.normalizedLabel },
      });
      return;
    case "CLEAR_LIST":
      await tx.shoppingListEntry.deleteMany({ where: { ownerId: operation.ownerId } });
      return;
    case "REORDER_ITEMS":
      await applyReorder(tx, operation, userId);
      return;
    case "UPDATE_QUANTITY":
      await applyQuantityUpdate(tx, operation, userId, index);
      return;
    case "SET_CROSSED_OFF":
      await applyCrossedOffUpdate(tx, operation, userId, index);
      return;
  }
}

async function applyAddItems(
  tx: Prisma.TransactionClient,
  operation: Extract<ParsedBatchOperation, { kind: "ADD_ITEMS" }>,
  userId: string
) {
  const uniqueLabels = Array.from(
    new Set(operation.entries.map(({ parsed }) => parsed.normalizedLabel))
  );

  const orderAssignments = new Map<string, number>();
  if (uniqueLabels.length) {
    const existingOrders = await tx.shoppingListEntry.findMany({
      where: {
        ownerId: operation.ownerId,
        normalizedLabel: { in: uniqueLabels },
      },
      select: { normalizedLabel: true, sortOrder: true },
      orderBy: { sortOrder: "asc" },
    });
    existingOrders.forEach((entry) => {
      if (!orderAssignments.has(entry.normalizedLabel)) {
        orderAssignments.set(entry.normalizedLabel, entry.sortOrder ?? 0);
      }
    });
  }

  const orderBounds = await tx.shoppingListEntry.aggregate({
    where: { ownerId: operation.ownerId },
    _max: { sortOrder: true },
    _min: { sortOrder: true },
  });
  let appendCursor = orderBounds._max.sortOrder ?? -1;
  let prependCursor = (orderBounds._min.sortOrder ?? 0) - 1;

  uniqueLabels.forEach((label) => {
    if (orderAssignments.has(label)) {
      return;
    }
    if (operation.position === "start") {
      orderAssignments.set(label, prependCursor);
      prependCursor -= 1;
    } else {
      appendCursor += 1;
      orderAssignments.set(label, appendCursor);
    }
  });

  const entriesToCreate = operation.entries.map(({ parsed, meta }) => ({
    ownerId: operation.ownerId,
    createdById: userId,
    updatedById: userId,
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

  if (uniqueLabels.length) {
    await tx.shoppingListEntry.updateMany({
      where: {
        ownerId: operation.ownerId,
        normalizedLabel: { in: uniqueLabels },
      },
      data: { crossedOffAt: null, updatedById: userId },
    });
  }

  await tx.shoppingListEntry.createMany({ data: entriesToCreate });
}

async function applyReorder(
  tx: Prisma.TransactionClient,
  operation: Extract<ParsedBatchOperation, { kind: "REORDER_ITEMS" }>,
  userId: string
) {
  for (let index = 0; index < operation.order.length; index += 1) {
    const label = operation.order[index];
    await tx.shoppingListEntry.updateMany({
      where: { ownerId: operation.ownerId, normalizedLabel: label },
      data: { sortOrder: index, updatedById: userId },
    });
  }
}

async function applyQuantityUpdate(
  tx: Prisma.TransactionClient,
  operation: Extract<ParsedBatchOperation, { kind: "UPDATE_QUANTITY" }>,
  userId: string,
  index: number
) {
  const normalizedLabel = normalizeLabel(operation.label);
  if (!normalizedLabel) {
    throw new BatchOperationError(
      `Operation ${index + 1} label could not be normalized`
    );
  }

  const existingEntries = await tx.shoppingListEntry.findMany({
    where: { ownerId: operation.ownerId, normalizedLabel },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  if (!existingEntries.length) {
    throw new BatchOperationError(
      `Operation ${index + 1} item not found`,
      404
    );
  }

  const preservedSources = collectSourceTitles(existingEntries);
  const manualSourceTitle = preservedSources.length
    ? preservedSources.join(" · ")
    : "Manual adjustment";
  const existingCrossedAt = existingEntries[0]?.crossedOffAt ?? null;
  const baseLabel = existingEntries[0].label;
  const sortOrder = existingEntries.reduce((minimum, entry) => {
    if (typeof entry.sortOrder === "number") {
      return Math.min(minimum, entry.sortOrder);
    }
    return minimum;
  }, existingEntries[0].sortOrder ?? 0);

  const trimmedQuantity = operation.quantity.trim();
  const parsed = parseIngredient(
    trimmedQuantity ? `${trimmedQuantity} ${baseLabel}`.trim() : baseLabel
  );

  await tx.shoppingListEntry.deleteMany({
    where: { ownerId: operation.ownerId, normalizedLabel },
  });
  await tx.shoppingListEntry.create({
    data: {
      ownerId: operation.ownerId,
      createdById: userId,
      updatedById: userId,
      label: baseLabel,
      normalizedLabel,
      quantityText: trimmedQuantity || "As listed",
      amountValue:
        trimmedQuantity && parsed.quantityText ? parsed.amountValue : null,
      measureText: parsed.measureText || null,
      sourceRecipeId: null,
      sourceRecipeTitle: manualSourceTitle,
      sortOrder,
      crossedOffAt: existingCrossedAt,
    },
  });
}

async function applyCrossedOffUpdate(
  tx: Prisma.TransactionClient,
  operation: Extract<ParsedBatchOperation, { kind: "SET_CROSSED_OFF" }>,
  userId: string,
  index: number
) {
  const result = await tx.shoppingListEntry.updateMany({
    where: { ownerId: operation.ownerId, normalizedLabel: operation.normalizedLabel },
    data: { crossedOffAt: operation.crossedOffAt, updatedById: userId },
  });
  if (result.count === 0) {
    throw new BatchOperationError(
      `Operation ${index + 1} item not found`,
      404
    );
  }
}
