import { NextResponse } from "next/server";
import { CollaborationResourceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

const collaboratorSelect = { id: true, name: true, email: true } as const;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const collaborations = await prisma.collaboration.findMany({
    where: { ownerId: user.id },
    include: { collaborator: { select: collaboratorSelect } },
    orderBy: [{ resourceType: "asc" }, { createdAt: "asc" }],
  });

  const recipeIds = collaborations
    .filter((entry) => entry.resourceType === CollaborationResourceType.RECIPE)
    .map((entry) => entry.resourceId);

  const recipes = recipeIds.length
    ? await prisma.recipe.findMany({
        where: { id: { in: recipeIds } },
        select: { id: true, title: true },
      })
    : [];
  const recipeLookup = new Map(recipes.map((recipe) => [recipe.id, recipe.title]));

  const recipeRoster = new Map<
    string,
    {
      resourceId: string;
      resourceLabel: string;
      collaborators: { id: string; name: string | null; email: string | null }[];
    }
  >();

  const shoppingListCollaborators: {
    id: string;
    name: string | null;
    email: string | null;
  }[] = [];

  collaborations.forEach((entry) => {
    const collaboratorSummary = {
      id: entry.collaborator.id,
      name: entry.collaborator.name,
      email: entry.collaborator.email,
    };
    if (entry.resourceType === CollaborationResourceType.RECIPE) {
      if (!recipeRoster.has(entry.resourceId)) {
        recipeRoster.set(entry.resourceId, {
          resourceId: entry.resourceId,
          resourceLabel:
            recipeLookup.get(entry.resourceId) ?? "Shared recipe",
          collaborators: [],
        });
      }
      recipeRoster.get(entry.resourceId)!.collaborators.push(collaboratorSummary);
      return;
    }

    if (entry.resourceType === CollaborationResourceType.SHOPPING_LIST) {
      if (entry.resourceId === user.id) {
        shoppingListCollaborators.push(collaboratorSummary);
      }
    }
  });

  const ownerLabel = user.name || user.email || "Your shopping list";

  return NextResponse.json({
    recipes: Array.from(recipeRoster.values()),
    shoppingList: {
      ownerId: user.id,
      ownerLabel,
      collaborators: shoppingListCollaborators,
    },
  });
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

  const { resourceType, resourceId, email } = (payload ?? {}) as {
    resourceType?: unknown;
    resourceId?: unknown;
    email?: unknown;
  };

  if (resourceType !== "RECIPE" && resourceType !== "SHOPPING_LIST") {
    return NextResponse.json(
      { error: "resourceType must be RECIPE or SHOPPING_LIST" },
      { status: 400 }
    );
  }
  if (typeof resourceId !== "string" || !resourceId.trim()) {
    return NextResponse.json(
      { error: "resourceId is required" },
      { status: 400 }
    );
  }
  if (typeof email !== "string" || !email.trim()) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail === user.email?.toLowerCase()) {
    return NextResponse.json(
      { error: "You already own this resource" },
      { status: 400 }
    );
  }

  const collaborator = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });
  if (!collaborator) {
    return NextResponse.json(
      { error: "No account found for that email" },
      { status: 404 }
    );
  }
  if (collaborator.id === user.id) {
    return NextResponse.json(
      { error: "You already have full access" },
      { status: 400 }
    );
  }

  if (resourceType === "RECIPE") {
    const recipe = await prisma.recipe.findUnique({ where: { id: resourceId } });
    if (!recipe || recipe.ownerId !== user.id) {
      return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
    }
  } else {
    if (resourceId !== user.id) {
      return NextResponse.json(
        { error: "Only owners can share their shopping list" },
        { status: 403 }
      );
    }
  }

  const existing = await prisma.collaboration.findFirst({
    where: {
      resourceType: resourceType as CollaborationResourceType,
      resourceId,
      collaboratorId: collaborator.id,
    },
  });
  if (existing) {
    return NextResponse.json(
      { error: "That user already has access" },
      { status: 409 }
    );
  }

  const invite = await prisma.collaboration.create({
    data: {
      resourceType: resourceType as CollaborationResourceType,
      resourceId,
      ownerId: user.id,
      collaboratorId: collaborator.id,
      invitedEmail: normalizedEmail,
      acceptedAt: new Date(),
    },
    include: {
      collaborator: { select: { id: true, name: true, email: true } },
    },
  });

  return NextResponse.json({
    collaboration: {
      id: invite.id,
      resourceType: invite.resourceType,
      resourceId: invite.resourceId,
      collaborator: invite.collaborator,
      createdAt: invite.createdAt,
    },
  });
}
