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

export async function GET() {
  const guard = await ensureAdmin();
  if (guard) {
    return guard;
  }

  const allowedEmails = await prisma.allowedEmail.findMany({
    orderBy: [{ email: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ allowedEmails });
}

export async function POST(request: Request) {
  const guard = await ensureAdmin();
  if (guard) {
    return guard;
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { email } = (payload ?? {}) as { email?: unknown };
  if (typeof email !== "string") {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return NextResponse.json({ error: "Provide a valid email" }, { status: 400 });
  }

  try {
    const allowedEmail = await prisma.allowedEmail.create({
      data: { email: normalizedEmail },
    });
    return NextResponse.json({ allowedEmail }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "That email is already on the whitelist" },
        { status: 409 }
      );
    }
    console.error("Failed to add whitelist entry", error);
    return NextResponse.json(
      { error: "Unable to add whitelist entry" },
      { status: 500 }
    );
  }
}
