import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccessShoppingListOwner } from "@/lib/collaboration";
import { normalizeLabel, parseIngredient } from "@/lib/shopping-list";

const serializePantryItem = (item: {
  id: string;
  label: string;
  normalizedLabel: string;
  addedAt: Date;
  updatedAt: Date;
}) => ({
  id: item.id,
  label: item.label,
  normalizedLabel: item.normalizedLabel,
  addedAt: item.addedAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
});

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const ownerParam = searchParams.get("ownerId");
  const ownerId = ownerParam?.trim() || user.id;
  if (!(await canAccessShoppingListOwner(user.id, ownerId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const items = await prisma.pantryItem.findMany({
    where: { ownerId },
    orderBy: [{ updatedAt: "desc" }, { label: "asc" }],
  });

  return NextResponse.json({ items: items.map(serializePantryItem) });
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

  const { label, ownerId: ownerParam } = (payload ?? {}) as {
    label?: unknown;
    ownerId?: unknown;
  };

  if (typeof label !== "string" || !label.trim()) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }

  const ownerId =
    typeof ownerParam === "string" && ownerParam.trim().length
      ? ownerParam.trim()
      : user.id;
  if (!(await canAccessShoppingListOwner(user.id, ownerId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const parsed = parseIngredient(label);
  const normalizedLabel =
    parsed.normalizedLabel || normalizeLabel(parsed.label);
  if (!normalizedLabel) {
    return NextResponse.json(
      { error: "Unable to resolve pantry item" },
      { status: 400 }
    );
  }

  try {
    const item = await prisma.pantryItem.upsert({
      where: {
        ownerId_normalizedLabel: {
          ownerId,
          normalizedLabel,
        },
      },
      update: {
        label: parsed.label,
      },
      create: {
        ownerId,
        label: parsed.label,
        normalizedLabel,
      },
    });
    return NextResponse.json(
      { item: serializePantryItem(item) },
      { status: 201 }
    );
  } catch (error) {
    console.error("Failed to save pantry item", error);
    return NextResponse.json(
      { error: "Failed to save pantry item" },
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
  const idParam = searchParams.get("id");
  if (!idParam) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const ownerParam = searchParams.get("ownerId");
  const ownerId = ownerParam?.trim() || user.id;
  if (!(await canAccessShoppingListOwner(user.id, ownerId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  try {
    const result = await prisma.pantryItem.deleteMany({
      where: { id: idParam, ownerId },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete pantry item", error);
    return NextResponse.json(
      { error: "Failed to delete pantry item" },
      { status: 500 }
    );
  }
}
