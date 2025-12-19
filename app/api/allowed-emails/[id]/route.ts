import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

async function ensureAdmin() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id?: string }> }
) {
  const guard = await ensureAdmin();
  if (guard) {
    return guard;
  }

  const { id: rawId } = await context.params;
  const id = rawId?.trim();
  if (!id) {
    return NextResponse.json({ error: "Missing whitelist ID" }, { status: 400 });
  }

  try {
    await prisma.allowedEmail.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Whitelist entry not found" },
        { status: 404 }
      );
    }
    console.error("Failed to delete whitelist entry", error);
    return NextResponse.json(
      { error: "Unable to delete whitelist entry" },
      { status: 500 }
    );
  }
}
