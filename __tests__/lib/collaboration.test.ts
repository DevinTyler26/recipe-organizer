/// <reference types="jest" />

import { CollaborationResourceType, type Recipe } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  canAccessShoppingListOwner,
  getRecipeAccessibleToUser,
  getSharedRecipeIds,
  getSharedShoppingListOwnerIds,
} from "@/lib/collaboration";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    collaboration: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    recipe: {
      findUnique: jest.fn(),
    },
  },
}));

type PrismaMock = {
  collaboration: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
  };
  recipe: {
    findUnique: jest.Mock;
  };
};

const mockPrisma = prisma as unknown as PrismaMock;

describe("collaboration helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns recipe collaboration ids", async () => {
    mockPrisma.collaboration.findMany.mockResolvedValue([
      { resourceId: "recipe-1" },
      { resourceId: "recipe-2" },
    ]);

    const result = await getSharedRecipeIds("user-1");

    expect(mockPrisma.collaboration.findMany).toHaveBeenCalledWith({
      where: {
        collaboratorId: "user-1",
        resourceType: CollaborationResourceType.RECIPE,
      },
      select: { resourceId: true },
    });
    expect(result).toEqual(["recipe-1", "recipe-2"]);
  });

  it("returns shopping list collaboration owner ids", async () => {
    mockPrisma.collaboration.findMany.mockResolvedValue([
      { resourceId: "owner-A" },
    ]);

    const result = await getSharedShoppingListOwnerIds("user-2");

    expect(mockPrisma.collaboration.findMany).toHaveBeenCalledWith({
      where: {
        collaboratorId: "user-2",
        resourceType: CollaborationResourceType.SHOPPING_LIST,
      },
      select: { resourceId: true },
    });
    expect(result).toEqual(["owner-A"]);
  });

  it("short-circuits recipe lookup when no id provided", async () => {
    const result = await getRecipeAccessibleToUser("user-1", "");

    expect(mockPrisma.recipe.findUnique).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("returns recipe owned by the user", async () => {
    const recipe = { id: "recipe-1", ownerId: "user-1" } as Recipe;
    mockPrisma.recipe.findUnique.mockResolvedValue(recipe);

    const result = await getRecipeAccessibleToUser("user-1", "recipe-1");

    expect(result).toBe(recipe);
    expect(mockPrisma.collaboration.findFirst).not.toHaveBeenCalled();
  });

  it("returns shared recipe when collaboration exists", async () => {
    const recipe = { id: "recipe-1", ownerId: "owner-id" } as Recipe;
    mockPrisma.recipe.findUnique.mockResolvedValue(recipe);
    mockPrisma.collaboration.findFirst.mockResolvedValue({ id: "collab" });

    const result = await getRecipeAccessibleToUser("user-2", "recipe-1");

    expect(mockPrisma.collaboration.findFirst).toHaveBeenCalledWith({
      where: {
        collaboratorId: "user-2",
        resourceType: CollaborationResourceType.RECIPE,
        resourceId: "recipe-1",
      },
    });
    expect(result).toBe(recipe);
  });

  it("returns null when user lacks access to recipe", async () => {
    const recipe = { id: "recipe-1", ownerId: "owner-id" } as Recipe;
    mockPrisma.recipe.findUnique.mockResolvedValue(recipe);
    mockPrisma.collaboration.findFirst.mockResolvedValue(null);

    const result = await getRecipeAccessibleToUser("user-3", "recipe-1");

    expect(result).toBeNull();
  });

  it("grants shopping list access to owner", async () => {
    await expect(
      canAccessShoppingListOwner("owner-id", "owner-id")
    ).resolves.toBe(true);
    expect(mockPrisma.collaboration.findFirst).not.toHaveBeenCalled();
  });

  it("checks collaborator access for shopping lists", async () => {
    mockPrisma.collaboration.findFirst.mockResolvedValue({ id: "collab" });

    await expect(
      canAccessShoppingListOwner("user-1", "owner-1")
    ).resolves.toBe(true);
    expect(mockPrisma.collaboration.findFirst).toHaveBeenCalledWith({
      where: {
        collaboratorId: "user-1",
        resourceType: CollaborationResourceType.SHOPPING_LIST,
        resourceId: "owner-1",
      },
    });
  });

  it("denies shopping list access when collaboration missing", async () => {
    mockPrisma.collaboration.findFirst.mockResolvedValue(null);

    await expect(
      canAccessShoppingListOwner("user-1", "owner-1")
    ).resolves.toBe(false);
  });

  it("returns false when owner id missing", async () => {
    await expect(
      canAccessShoppingListOwner("user-1", "")
    ).resolves.toBe(false);
  });
});
