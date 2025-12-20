import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";

const MAX_LABEL_LENGTH = 60;

export async function PUT(request: Request) {
  const user = await requireUser();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawLabel =
    typeof (payload as { label?: unknown })?.label === "string"
      ? ((payload as { label?: string }).label ?? "")
      : "";
  const trimmed = rawLabel.trim();
  if (!trimmed) {
    return NextResponse.json(
      { error: "List name cannot be empty" },
      { status: 400 }
    );
  }

  const normalized = trimmed.slice(0, MAX_LABEL_LENGTH);

  try {
    const result = await prisma.user.update({
      where: { id: user.id },
      data: { shoppingListLabel: normalized },
      select: { shoppingListLabel: true },
    });
    return NextResponse.json({ label: result.shoppingListLabel ?? normalized });
  } catch (error) {
    console.error("Failed to update shopping list label", error);
    return NextResponse.json(
      { error: "Unable to rename list right now" },
      { status: 500 }
    );
  }
}
