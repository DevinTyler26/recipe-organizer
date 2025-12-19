"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { useShoppingList } from "@/components/shopping-list-context";
import { CollaborationInviteDialog } from "@/components/collaboration-invite-dialog";
import { CollaboratorRosterDialog } from "@/components/collaborator-roster-dialog";
import type {
  CollaborationRoster,
  CollaboratorSummary,
} from "@/types/collaboration";

type ToastTone = "success" | "info" | "error";

type ToastMessage = {
  id: number;
  message: string;
  tone: ToastTone;
};
type RecipeOwner = {
  id: string;
  name: string | null;
  email: string | null;
} | null;
type Recipe = {
  id: string;
  title: string;
  summary: string | null;
  ingredients: string[];
  tags: string[];
  isFavorite: boolean;
  order: number;
  owner: RecipeOwner;
};

type InviteTarget = {
  resourceType: "RECIPE" | "SHOPPING_LIST";
  resourceId: string;
  resourceLabel: string;
  description?: string;
};

type StoredRecipe = Omit<Recipe, "tags" | "order"> & {
  tags?: string[];
  order?: number;
  sortOrder?: number;
  owner?: RecipeOwner;
};

const toastToneStyles: Record<ToastTone, string> = {
  success:
    "border-emerald-100 bg-emerald-50 text-emerald-700 shadow-emerald-100/80",
  info: "border-slate-200 bg-white text-slate-700 shadow-slate-200/80",
  error: "border-rose-200 bg-rose-50 text-rose-700 shadow-rose-100/80",
};

const starterRecipes: Recipe[] = [
  {
    id: "starter-citrus-soba",
    title: "Citrus herb soba bowl",
    summary:
      "Buckwheat noodles tossed with shaved veggies, herbs, and honey-citrus dressing.",
    ingredients: [
      "Soba noodles",
      "English cucumber",
      "Carrots",
      "Mint",
      "Basil",
      "Orange",
      "Honey",
      "Rice vinegar",
    ],
    tags: ["Vegetarian", "Make-ahead"],
    isFavorite: true,
    order: 0,
    owner: null,
  },
  {
    id: "starter-sheet-pan-gnocchi",
    title: "Sheet-pan market gnocchi",
    summary:
      "Crispy gnocchi roasted with tomatoes, fennel, and lemony brown butter.",
    ingredients: [
      "Potato gnocchi",
      "Cherry tomatoes",
      "Fennel bulb",
      "Shallots",
      "Parsley",
      "Butter",
      "Lemon",
    ],
    tags: ["Weeknight", "Sheet pan"],
    isFavorite: false,
    order: 1,
    owner: null,
  },
  {
    id: "starter-midnight-brownies",
    title: "Midnight espresso brownies",
    summary: "Fudgy squares with instant espresso and flaky salt.",
    ingredients: [
      "Dark chocolate",
      "Butter",
      "Granulated sugar",
      "Eggs",
      "Flour",
      "Espresso powder",
      "Flaky salt",
    ],
    tags: ["Dessert", "Crowd-pleaser"],
    isFavorite: false,
    order: 2,
    owner: null,
  },
];

const LOCAL_RECIPES_KEY = "recipe-library-local";

const generateRecipeId = () => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `recipe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const emptyForm = {
  title: "",
  summary: "",
  ingredients: "",
  tags: "",
};

const parseIngredients = (value: string) =>
  value
    .split(/\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const dedupeTags = (entries: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  entries.forEach((raw) => {
    const normalized = raw.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(normalized);
  });
  return result;
};

const parseTagsInput = (value: string) => dedupeTags(value.split(/,|\n/));

const ensureTagsArray = (tags?: string[]) =>
  dedupeTags(Array.isArray(tags) ? tags : []);

const normalizeRecipeOwner = (owner: StoredRecipe["owner"]): RecipeOwner => {
  if (!owner || typeof owner !== "object") {
    return null;
  }
  const candidate = owner as { id?: unknown; name?: unknown; email?: unknown };
  if (typeof candidate.id !== "string") {
    return null;
  }
  return {
    id: candidate.id,
    name:
      typeof candidate.name === "string" && candidate.name.trim().length
        ? candidate.name
        : null,
    email:
      typeof candidate.email === "string" && candidate.email.trim().length
        ? candidate.email
        : null,
  };
};

const normalizeRecipe = (recipe: StoredRecipe): Recipe => {
  const normalizedOrder =
    typeof recipe.order === "number"
      ? recipe.order
      : typeof recipe.sortOrder === "number"
      ? recipe.sortOrder
      : 0;

  return {
    ...recipe,
    order: normalizedOrder,
    tags: ensureTagsArray(recipe.tags),
    owner: normalizeRecipeOwner(recipe.owner),
  };
};

const normalizeRecipeList = (list?: StoredRecipe[] | null) =>
  Array.isArray(list)
    ? list.map(normalizeRecipe).sort((a, b) => a.order - b.order)
    : [];

const summarizeCollaborators = (collaborators: CollaboratorSummary[]) => {
  if (!collaborators.length) {
    return "";
  }
  const names = collaborators.map(
    (entry) => entry.name?.trim() || entry.email?.trim() || "a collaborator"
  );
  if (names.length === 1) {
    return names[0];
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.length} collaborators`;
};

export default function HomePage() {
  const { addItems, totalItems, lists, selectedListId, selectList } =
    useShoppingList();
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated";
  const isSessionLoading = status === "loading";
  const [recipes, setRecipes] = useState<Recipe[]>(starterRecipes);
  const [form, setForm] = useState(emptyForm);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [favoriteUpdatingId, setFavoriteUpdatingId] = useState<string | null>(
    null
  );
  const [deletingRecipeId, setDeletingRecipeId] = useState<string | null>(null);
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null);
  const [pendingDeletionRecipe, setPendingDeletionRecipe] =
    useState<Recipe | null>(null);
  const [actionsMenuRecipeId, setActionsMenuRecipeId] = useState<string | null>(
    null
  );
  const [guestLibraryLoaded, setGuestLibraryLoaded] = useState(false);
  const [recipesLoaded, setRecipesLoaded] = useState(false);
  const [shareWithCurrentCollaborators, setShareWithCurrentCollaborators] =
    useState(true);
  const [toastQueue, setToastQueue] = useState<ToastMessage[]>([]);
  const [activeToast, setActiveToast] = useState<ToastMessage | null>(null);
  const [libraryFilter, setLibraryFilter] = useState<"all" | "favorites">(
    "all"
  );
  const [sortMode, setSortMode] = useState<"default" | "favorites-first">(
    "default"
  );
  const [sortPreferenceLoaded, setSortPreferenceLoaded] = useState(false);
  const [draggingRecipeId, setDraggingRecipeId] = useState<string | null>(null);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [inviteTarget, setInviteTarget] = useState<InviteTarget | null>(null);
  const [collaborationRoster, setCollaborationRoster] =
    useState<CollaborationRoster | null>(null);
  const [isCollaborationsLoading, setIsCollaborationsLoading] = useState(false);
  const [isListMenuOpen, setIsListMenuOpen] = useState(false);
  const [rosterModal, setRosterModal] = useState<{
    title: string;
    collaborators: CollaboratorSummary[];
  } | null>(null);
  const listMenuRef = useRef<HTMLDivElement | null>(null);
  const currentUserId = session?.user?.id ?? null;
  const accountLabel = session?.user?.name || session?.user?.email || "Account";
  const isAdmin = Boolean(session?.user?.isAdmin);
  const orderedRecipes = useMemo(
    () => [...recipes].sort((a, b) => a.order - b.order),
    [recipes]
  );
  const activeShoppingList = useMemo(() => {
    if (!lists.length) return null;
    if (selectedListId) {
      const selected = lists.find((list) => list.ownerId === selectedListId);
      if (selected) {
        return selected;
      }
    }
    return lists[0] ?? null;
  }, [lists, selectedListId]);
  const activeSharedListOwnerId =
    activeShoppingList && !activeShoppingList.isSelf
      ? activeShoppingList.ownerId
      : null;
  const activeSharedListOwnerLabel =
    activeSharedListOwnerId && activeShoppingList
      ? activeShoppingList.ownerLabel
      : null;
  useEffect(() => {
    setShareWithCurrentCollaborators(true);
  }, [activeShoppingList?.ownerId]);
  const shoppingListDestinationLabel =
    activeShoppingList?.ownerLabel ??
    (isAuthenticated ? "your list" : "this device");
  const canShareShoppingList = Boolean(
    isAuthenticated && activeShoppingList?.isSelf && currentUserId
  );
  const recipeCollaboratorLookup = useMemo(() => {
    const map = new Map<string, CollaboratorSummary[]>();
    collaborationRoster?.recipes.forEach((entry) => {
      map.set(entry.resourceId, entry.collaborators);
    });
    return map;
  }, [collaborationRoster]);
  const shoppingListCollaborators = useMemo(() => {
    if (
      !collaborationRoster?.shoppingList ||
      collaborationRoster.shoppingList.ownerId !== currentUserId
    ) {
      return [];
    }
    return collaborationRoster.shoppingList.collaborators;
  }, [collaborationRoster, currentUserId]);
  const activeListCollaborators = useMemo(() => {
    return activeShoppingList?.isSelf ? shoppingListCollaborators : [];
  }, [activeShoppingList?.isSelf, shoppingListCollaborators]);
  const activeListCollaboratorSummary = useMemo(() => {
    return summarizeCollaborators(activeListCollaborators);
  }, [activeListCollaborators]);
  const collaboratorSummaryDisplay =
    activeListCollaboratorSummary || "your collaborators";
  const showShareCollaboratorToggle = Boolean(
    isAuthenticated &&
      activeShoppingList?.isSelf &&
      activeListCollaborators.length > 0
  );

  const refreshCollaborations = useCallback(async () => {
    if (!isAuthenticated) {
      setCollaborationRoster(null);
      return;
    }
    setIsCollaborationsLoading(true);
    try {
      const response = await fetch("/api/collaborations", {
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as
        | CollaborationRoster
        | { error?: string }
        | null;
      if (!response.ok || !body || ("error" in body && body.error)) {
        throw new Error(body && "error" in body ? body.error : undefined);
      }
      if ("error" in body) {
        throw new Error(body.error);
      }
      setCollaborationRoster(body as CollaborationRoster);
    } catch (error) {
      console.error("Failed to load collaboration roster", error);
    } finally {
      setIsCollaborationsLoading(false);
    }
  }, [isAuthenticated]);

  const showToast = useCallback(
    (message: string, tone: ToastTone = "success") => {
      setToastQueue((current) => [
        ...current,
        { id: Date.now() + Math.random(), message, tone },
      ]);
    },
    []
  );

  const handleInviteSubmit = useCallback(
    async (email: string) => {
      const target = inviteTarget;
      if (!target) {
        throw new Error("Select something to share first");
      }
      const response = await fetch("/api/collaborations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceType: target.resourceType,
          resourceId: target.resourceId,
          email,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to send invite");
      }
      showToast(`Shared ${target.resourceLabel} with ${email}.`);
      void refreshCollaborations();
    },
    [inviteTarget, refreshCollaborations, showToast]
  );

  const persistRecipeOrder = useCallback(
    async (orderedIds: string[]) => {
      if (!isAuthenticated || orderedIds.length === 0) {
        return;
      }

      try {
        const response = await fetch("/api/recipes/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: orderedIds }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "Failed to sync order");
        }
      } catch (error) {
        console.error("Failed to persist recipe order", error);
        showToast("Unable to sync recipe order. We'll retry soon.", "error");
      }
    },
    [isAuthenticated, showToast]
  );

  const dismissToast = () => setActiveToast(null);

  const resetFormState = useCallback(() => {
    setForm(emptyForm);
    setEditingRecipeId(null);
  }, []);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    if (!isListMenuOpen) {
      return;
    }
    const handleClick = (event: MouseEvent) => {
      if (!listMenuRef.current?.contains(event.target as Node)) {
        setIsListMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isListMenuOpen]);

  const openRosterDialog = useCallback(
    (title: string, collaborators: CollaboratorSummary[]) => {
      setRosterModal({ title, collaborators });
    },
    []
  );

  useEffect(() => {
    void refreshCollaborations();
  }, [isAuthenticated, refreshCollaborations]);

  useEffect(() => {
    if (!isAuthenticated) {
      try {
        const storedRecipes = window.localStorage.getItem(LOCAL_RECIPES_KEY);
        if (storedRecipes) {
          const parsed = JSON.parse(storedRecipes);
          if (Array.isArray(parsed)) {
            setRecipes(normalizeRecipeList(parsed as StoredRecipe[]));
            setGuestLibraryLoaded(true);
            setIsSyncing(false);
            setRecipesLoaded(true);
            return;
          }
        }
      } catch (error) {
        console.error("Failed to load local recipes", error);
      }
      setRecipes(starterRecipes);
      setIsSyncing(false);
      setGuestLibraryLoaded(true);
      setRecipesLoaded(true);
      return;
    }

    setGuestLibraryLoaded(false);
    setRecipesLoaded(false);
    let cancelled = false;
    const fetchRecipes = async () => {
      setIsSyncing(true);
      try {
        const response = await fetch("/api/recipes");
        const body = (await response.json().catch(() => null)) as {
          recipes?: Recipe[];
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(body?.error ?? "Failed to load recipes");
        }
        if (!cancelled) {
          setRecipes(
            normalizeRecipeList(body?.recipes as StoredRecipe[] | undefined)
          );
          setRecipesLoaded(true);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to fetch recipes", error);
          showToast("Unable to load your saved recipes.", "error");
          setRecipesLoaded(true);
        }
      } finally {
        if (!cancelled) {
          setIsSyncing(false);
        }
      }
    };

    fetchRecipes();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, showToast]);

  useEffect(() => {
    if (activeToast || toastQueue.length === 0) {
      return;
    }
    setActiveToast(toastQueue[0]);
    setToastQueue((current) => current.slice(1));
  }, [activeToast, toastQueue]);

  useEffect(() => {
    if (!activeToast) {
      return;
    }
    const timeoutId = window.setTimeout(() => setActiveToast(null), 3600);
    return () => window.clearTimeout(timeoutId);
  }, [activeToast]);

  useEffect(() => {
    const storedFilter = window.localStorage.getItem("recipe-library-filter");
    if (storedFilter === "all" || storedFilter === "favorites") {
      setLibraryFilter(storedFilter);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("recipe-library-filter", libraryFilter);
  }, [libraryFilter]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const storedSort = window.localStorage.getItem("recipe-library-sort");
    if (storedSort === "favorites-first") {
      setSortMode("favorites-first");
    }
    setSortPreferenceLoaded(true);
  }, []);

  useEffect(() => {
    if (!isAuthenticated && guestLibraryLoaded) {
      try {
        window.localStorage.setItem(LOCAL_RECIPES_KEY, JSON.stringify(recipes));
      } catch (error) {
        console.error("Failed to persist local recipes", error);
      }
    }
  }, [guestLibraryLoaded, isAuthenticated, recipes]);

  useEffect(() => {
    if (!sortPreferenceLoaded || typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("recipe-library-sort", sortMode);
  }, [sortMode, sortPreferenceLoaded]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = form.title.trim();
    const ingredients = parseIngredients(form.ingredients);
    const tags = parseTagsInput(form.tags);

    if (!trimmedTitle || ingredients.length === 0) {
      showToast(
        "Add a title and at least one ingredient to save a recipe.",
        "error"
      );
      return;
    }

    const payload = {
      title: trimmedTitle,
      summary: form.summary.trim() || null,
      ingredients,
      tags,
    };
    const shareTargetOwnerId = activeSharedListOwnerId;
    const shareRecipientLabel = activeSharedListOwnerLabel;
    const shouldShareCollaborators =
      shareWithCurrentCollaborators && activeListCollaborators.length > 0;
    const collaboratorIdsPayload = shouldShareCollaborators
      ? activeListCollaborators.map((collaborator) => collaborator.id)
      : undefined;

    setIsSaving(true);
    if (editingRecipeId) {
      const recipeIdBeingEdited = editingRecipeId;
      if (isAuthenticated) {
        try {
          const response = await fetch("/api/recipes", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: recipeIdBeingEdited, ...payload }),
          });
          const body = (await response.json().catch(() => null)) as {
            recipe?: Recipe;
            error?: string;
          } | null;
          if (!response.ok || !body?.recipe) {
            throw new Error(body?.error ?? "Failed to update recipe");
          }
          const updatedServerRecipe = normalizeRecipe(
            body.recipe as StoredRecipe
          );
          setRecipes((current) =>
            current.map((existing) =>
              existing.id === recipeIdBeingEdited
                ? updatedServerRecipe
                : existing
            )
          );
          resetFormState();
          showToast(`${updatedServerRecipe.title} was updated.`);
        } catch (error) {
          console.error("Failed to update recipe", error);
          showToast(
            "Unable to update recipe right now. Please retry.",
            "error"
          );
        } finally {
          setIsSaving(false);
        }
        return;
      }

      const currentRecipe = recipes.find(
        (existing) => existing.id === recipeIdBeingEdited
      );
      if (!currentRecipe) {
        showToast("Unable to find this recipe locally.", "error");
        resetFormState();
        setIsSaving(false);
        return;
      }
      const updatedRecipe: Recipe = {
        ...currentRecipe,
        title: trimmedTitle,
        summary: payload.summary,
        ingredients,
        tags,
      };
      setRecipes((current) =>
        current.map((existing) =>
          existing.id === recipeIdBeingEdited ? updatedRecipe : existing
        )
      );
      resetFormState();
      showToast(`${updatedRecipe.title} updated for this browser.`);
      setIsSaving(false);
      return;
    }

    if (!isAuthenticated) {
      const nextLocalOrder =
        recipes.length > 0
          ? Math.min(...recipes.map((existing) => existing.order)) - 1
          : 0;
      const newRecipe: Recipe = {
        id: generateRecipeId(),
        title: trimmedTitle,
        summary: payload.summary,
        ingredients,
        tags,
        isFavorite: false,
        order: nextLocalOrder,
        owner: null,
      };
      setRecipes((current) => [newRecipe, ...current]);
      resetFormState();
      showToast(`${newRecipe.title} saved to this browser.`);
      setIsSaving(false);
      return;
    }

    try {
      const response = await fetch("/api/recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          shareTargetOwnerId
            ? {
                ...payload,
                shareWithOwnerId: shareTargetOwnerId,
                collaboratorIds: collaboratorIdsPayload,
              }
            : payload
        ),
      });
      const body = (await response.json().catch(() => null)) as {
        recipe?: Recipe;
        error?: string;
      } | null;
      if (!response.ok || !body?.recipe) {
        throw new Error(body?.error ?? "Failed to save recipe");
      }
      const savedRecipe = normalizeRecipe(body.recipe as StoredRecipe);
      setRecipes((current) => [savedRecipe, ...current]);
      resetFormState();
      const collaboratorDescriptor = shouldShareCollaborators
        ? summarizeCollaborators(activeListCollaborators)
        : "";
      const collaboratorSuffix = collaboratorDescriptor
        ? ` plus ${collaboratorDescriptor}`
        : "";
      const toastMessage = shareRecipientLabel
        ? `${savedRecipe.title} is ready and now shared with ${shareRecipientLabel}${collaboratorSuffix}.`
        : collaboratorDescriptor
        ? `${savedRecipe.title} is ready and now shared with ${collaboratorDescriptor}.`
        : `${savedRecipe.title} is ready. Send it to your list when needed.`;
      showToast(toastMessage);
    } catch (error) {
      console.error("Failed to save recipe", error);
      showToast("Unable to save recipe right now. Please retry.", "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddToShoppingList = (recipe: Recipe) => {
    addItems(
      recipe.ingredients.map((ingredient) => ({
        value: ingredient,
        recipeId: recipe.id,
        recipeTitle: recipe.title,
      }))
    );
    const destinationLabel = activeShoppingList
      ? activeShoppingList.isSelf
        ? "your shopping list"
        : `${activeShoppingList.ownerLabel}'s list`
      : "your shopping list";
    showToast(`${recipe.title} ingredients now live in ${destinationLabel}.`);
  };

  const handleToggleFavorite = async (recipe: Recipe) => {
    const previousFavorite = recipe.isFavorite;
    const nextFavorite = !recipe.isFavorite;

    if (!isAuthenticated) {
      setRecipes((current) =>
        current.map((existing) =>
          existing.id === recipe.id
            ? { ...existing, isFavorite: nextFavorite }
            : existing
        )
      );
      showToast(
        nextFavorite
          ? `${recipe.title} favorited for this browser.`
          : `${recipe.title} removed from favorites locally.`,
        "info"
      );
      return;
    }

    setFavoriteUpdatingId(recipe.id);
    setRecipes((current) =>
      current.map((existing) =>
        existing.id === recipe.id
          ? { ...existing, isFavorite: nextFavorite }
          : existing
      )
    );
    try {
      const response = await fetch("/api/recipes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recipe.id, isFavorite: nextFavorite }),
      });
      const body = (await response.json().catch(() => null)) as {
        recipe?: Recipe;
        error?: string;
      } | null;
      if (!response.ok || !body?.recipe) {
        throw new Error(body?.error ?? "Failed to update favorite state");
      }
      const updatedServerRecipe = normalizeRecipe(body.recipe as StoredRecipe);
      setRecipes((current) =>
        current.map((existing) =>
          existing.id === recipe.id
            ? { ...existing, isFavorite: updatedServerRecipe.isFavorite }
            : existing
        )
      );
      showToast(
        updatedServerRecipe.isFavorite
          ? `${recipe.title} marked as a favorite.`
          : `${recipe.title} removed from favorites.`
      );
    } catch (error) {
      console.error("Failed to toggle favorite", error);
      setRecipes((current) =>
        current.map((existing) =>
          existing.id === recipe.id
            ? { ...existing, isFavorite: previousFavorite }
            : existing
        )
      );
      showToast("Unable to update favorite right now. Please retry.", "error");
    } finally {
      setFavoriteUpdatingId(null);
    }
  };

  const handleEditRecipe = useCallback((recipe: Recipe) => {
    setEditingRecipeId(recipe.id);
    setForm({
      title: recipe.title,
      summary: recipe.summary ?? "",
      ingredients: recipe.ingredients.join("\n"),
      tags: recipe.tags.join(", "),
    });
  }, []);

  const requestDeleteRecipe = useCallback((recipe: Recipe) => {
    setPendingDeletionRecipe(recipe);
  }, []);

  const deleteRecipe = useCallback(
    async (recipe: Recipe) => {
      const wasEditingTarget = editingRecipeId === recipe.id;
      if (wasEditingTarget) {
        resetFormState();
      }

      if (!isAuthenticated) {
        setRecipes((current) =>
          current.filter((existing) => existing.id !== recipe.id)
        );
        showToast(`${recipe.title} was removed from this browser.`, "info");
        return;
      }

      const previousRecipes = recipes;
      setDeletingRecipeId(recipe.id);
      setRecipes((current) =>
        current.filter((existing) => existing.id !== recipe.id)
      );

      try {
        const response = await fetch("/api/recipes", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: recipe.id }),
        });
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(body?.error ?? "Failed to delete recipe");
        }
        showToast(`${recipe.title} was removed from your library.`, "info");
      } catch (error) {
        console.error("Failed to delete recipe", error);
        setRecipes(previousRecipes);
        if (wasEditingTarget) {
          setEditingRecipeId(recipe.id);
          setForm({
            title: recipe.title,
            summary: recipe.summary ?? "",
            ingredients: recipe.ingredients.join("\n"),
            tags: recipe.tags.join(", "),
          });
        }
        showToast("Unable to delete recipe right now. Please retry.", "error");
      } finally {
        setDeletingRecipeId(null);
      }
    },
    [editingRecipeId, isAuthenticated, recipes, resetFormState, showToast]
  );

  const confirmDeleteRecipe = useCallback(() => {
    if (!pendingDeletionRecipe) {
      return;
    }
    const recipe = pendingDeletionRecipe;
    setPendingDeletionRecipe(null);
    void deleteRecipe(recipe);
  }, [deleteRecipe, pendingDeletionRecipe]);

  const cancelDeleteRecipe = useCallback(() => {
    setPendingDeletionRecipe(null);
  }, []);

  useEffect(() => {
    if (!actionsMenuRecipeId) {
      return;
    }

    const activeRecipe = recipes.find(
      (recipe) => recipe.id === actionsMenuRecipeId
    );

    if (!activeRecipe) {
      setActionsMenuRecipeId(null);
      return;
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-recipe-actions]")) {
        return;
      }
      setActionsMenuRecipeId(null);
    };

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActionsMenuRecipeId(null);
        return;
      }

      if (!event.metaKey) {
        return;
      }

      if (event.key.toLowerCase() === "e") {
        event.preventDefault();
        setActionsMenuRecipeId(null);
        handleEditRecipe(activeRecipe);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        setActionsMenuRecipeId(null);
        requestDeleteRecipe(activeRecipe);
      }
    };

    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [actionsMenuRecipeId, handleEditRecipe, recipes, requestDeleteRecipe]);

  const favoritesOnly = orderedRecipes.filter((recipe) => recipe.isFavorite);
  const favoriteCount = favoritesOnly.length;
  const baseLibrary =
    libraryFilter === "favorites" ? favoritesOnly : orderedRecipes;
  const favoritesViewEmpty =
    libraryFilter === "favorites" && favoriteCount === 0;
  const effectiveSortMode = favoritesViewEmpty ? "default" : sortMode;
  const displayedRecipes: Recipe[] =
    libraryFilter === "favorites" || effectiveSortMode === "default"
      ? baseLibrary
      : [
          ...baseLibrary.filter((recipe) => recipe.isFavorite),
          ...baseLibrary.filter((recipe) => !recipe.isFavorite),
        ];
  const showRecipeSkeletons = isAuthenticated && !recipesLoaded;
  const librarySummary = showRecipeSkeletons
    ? "Loading recipes…"
    : libraryFilter === "favorites"
    ? `${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"}`
    : `${orderedRecipes.length} saved`;
  const shoppingListTotal = hasHydrated ? totalItems : 0;
  const canDragReorder =
    effectiveSortMode === "default" && displayedRecipes.length > 1;

  useEffect(() => {
    if (!canDragReorder && draggingRecipeId) {
      setDraggingRecipeId(null);
    }
  }, [canDragReorder, draggingRecipeId]);

  const finalizeRecipeDrag = useCallback(() => {
    setDraggingRecipeId(null);
  }, []);

  const reorderRelative = useCallback(
    (targetId: string | null, placeAfter: boolean) => {
      if (!draggingRecipeId) {
        return;
      }
      setRecipes((current) => {
        const ordered = [...current].sort((a, b) => a.order - b.order);
        const movingIndex = ordered.findIndex(
          (recipe) => recipe.id === draggingRecipeId
        );
        if (movingIndex === -1) {
          return ordered;
        }
        const [movingRecipe] = ordered.splice(movingIndex, 1);
        if (targetId === null) {
          ordered.push(movingRecipe);
        } else {
          const targetIndex = ordered.findIndex(
            (recipe) => recipe.id === targetId
          );
          const insertIndex =
            targetIndex === -1
              ? ordered.length
              : targetIndex + (placeAfter ? 1 : 0);
          ordered.splice(insertIndex, 0, movingRecipe);
        }
        const next = ordered.map((recipe, index) => ({
          ...recipe,
          order: index,
        }));
        if (isAuthenticated) {
          void persistRecipeOrder(next.map((recipe) => recipe.id));
        }
        return next;
      });
      finalizeRecipeDrag();
    },
    [draggingRecipeId, finalizeRecipeDrag, isAuthenticated, persistRecipeOrder]
  );

  const beginRecipeDrag = useCallback(
    (recipeId: string, event: DragEvent<HTMLElement>) => {
      if (!canDragReorder) {
        return;
      }
      setDraggingRecipeId(recipeId);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", recipeId);
    },
    [canDragReorder]
  );

  const handleRecipeDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!canDragReorder || !draggingRecipeId) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [canDragReorder, draggingRecipeId]
  );

  const handleRecipeDrop = useCallback(
    (event: DragEvent<HTMLElement>, targetId: string) => {
      if (
        !canDragReorder ||
        !draggingRecipeId ||
        draggingRecipeId === targetId
      ) {
        return;
      }
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const placeAfter = event.clientY > rect.top + rect.height / 2;
      reorderRelative(targetId, placeAfter);
    },
    [canDragReorder, draggingRecipeId, reorderRelative]
  );

  const handleRecipeListDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canDragReorder || !draggingRecipeId) {
        return;
      }
      if (event.target !== event.currentTarget) {
        return;
      }
      event.preventDefault();
      const fallbackTargetId =
        libraryFilter === "favorites"
          ? displayedRecipes[displayedRecipes.length - 1]?.id ?? null
          : null;
      reorderRelative(fallbackTargetId, true);
    },
    [
      canDragReorder,
      displayedRecipes,
      draggingRecipeId,
      libraryFilter,
      reorderRelative,
    ]
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-rose-50 to-white px-4 py-12 text-slate-900">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-12">
        <header className="rounded-3xl border border-white/60 bg-white/85 p-8 shadow-xl shadow-rose-100/60 backdrop-blur">
          <nav className="flex flex-wrap items-center justify-between gap-4 border-b border-white/60 pb-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.35em] text-rose-500">
                Recipe Organizer
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {isAuthenticated ? accountLabel : "Guest mode"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {lists.length > 0 && (
                <div className="relative" ref={listMenuRef}>
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={isListMenuOpen}
                    onClick={() => setIsListMenuOpen((current) => !current)}
                    className="inline-flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/70 px-4 py-2 text-left text-sm font-semibold text-slate-700 shadow-inner shadow-white/60 transition hover:border-slate-300"
                  >
                    <span className="flex flex-col leading-tight">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.35em] text-slate-400">
                        Active list
                      </span>
                      <span className="text-slate-900">
                        {shoppingListDestinationLabel}
                      </span>
                    </span>
                    <svg
                      className={`h-4 w-4 text-slate-500 transition ${
                        isListMenuOpen ? "rotate-180" : ""
                      }`}
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.585l3.71-3.355a.75.75 0 0 1 1.02 1.1l-4.23 3.83a.75.75 0 0 1-1.02 0l-4.23-3.83a.75.75 0 0 1 .02-1.1z" />
                    </svg>
                  </button>
                  {isListMenuOpen && (
                    <div className="absolute right-0 z-20 mt-3 w-72 rounded-3xl border border-slate-100 bg-white/95 p-4 text-sm text-slate-600 shadow-2xl shadow-slate-200/80">
                      {activeShoppingList ? (
                        <>
                          <p className="text-base font-semibold text-slate-900">
                            {shoppingListDestinationLabel}
                          </p>
                          <p className="text-xs text-slate-500">
                            {activeShoppingList.isSelf
                              ? "Owned by you"
                              : `Shared from ${activeShoppingList.ownerLabel}`}
                          </p>
                        </>
                      ) : (
                        <p className="text-slate-500">
                          Select a list to manage it here.
                        </p>
                      )}
                      {lists.length > 1 && (
                        <div className="mt-4 flex flex-col gap-2">
                          {lists.map((list) => {
                            const isSelected =
                              list.ownerId ===
                              (activeShoppingList?.ownerId ?? selectedListId);
                            return (
                              <button
                                key={list.ownerId}
                                type="button"
                                onClick={() => {
                                  selectList(list.ownerId);
                                  setIsListMenuOpen(false);
                                }}
                                className={`rounded-2xl border px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.2em] transition ${
                                  isSelected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                                }`}
                              >
                                {list.ownerLabel}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {canShareShoppingList && activeShoppingList && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setIsListMenuOpen(false);
                              openRosterDialog(
                                `${activeShoppingList.ownerLabel}'s list`,
                                shoppingListCollaborators
                              );
                            }}
                            disabled={isCollaborationsLoading}
                            className={`rounded-2xl border px-3 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition ${
                              isCollaborationsLoading
                                ? "border-slate-200 text-slate-400"
                                : "border-slate-200 text-slate-600 hover:border-slate-300"
                            }`}
                          >
                            {isCollaborationsLoading
                              ? "Loading…"
                              : "View collaborators"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!currentUserId) {
                                return;
                              }
                              setIsListMenuOpen(false);
                              setInviteTarget({
                                resourceType: "SHOPPING_LIST",
                                resourceId: currentUserId,
                                resourceLabel: `${activeShoppingList.ownerLabel}'s list`,
                                description:
                                  "Collaborators can add, remove, and reorder items on this list.",
                              });
                            }}
                            className="rounded-2xl bg-rose-500 px-3 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-white shadow-lg shadow-rose-200/80 transition hover:scale-[1.01]"
                          >
                            Invite
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                disabled={isSessionLoading}
                onClick={() => {
                  if (isAuthenticated) {
                    void signOut();
                  } else {
                    void signIn("google");
                  }
                }}
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white/70 px-5 py-2 text-sm font-semibold text-slate-700 shadow-inner shadow-white/60 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isAuthenticated ? "Sign out" : "Sign in with Google"}
              </button>
              {isAdmin && (
                <Link
                  href="/whitelist"
                  className="inline-flex items-center justify-center rounded-2xl border border-amber-300 bg-white/80 px-5 py-2 text-sm font-semibold text-amber-700 shadow-inner shadow-amber-100/80 transition hover:border-amber-400"
                >
                  Admin whitelist
                </Link>
              )}
              <Link
                href="/shopping-list"
                className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-slate-900/20 transition hover:-translate-y-0.5"
              >
                Shopping list ({shoppingListTotal})
              </Link>
            </div>
          </nav>
          <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold leading-snug text-slate-900 sm:text-4xl">
                Build dinners, snacks, and a synced shopping list.
              </h1>
              <p className="text-base text-slate-600">
                Tag every ingredient, keep favorites close, and dispatch pantry
                plans straight to the cart.
              </p>
            </div>
            <div className="rounded-2xl border border-white/70 bg-white/80 p-5 text-sm text-slate-600 shadow-inner shadow-white/60">
              <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-500">
                {isAuthenticated ? "Synced" : "Offline mode"}
              </p>
              <p className="mt-2 text-slate-700">
                {isAuthenticated
                  ? "Recipes and lists back up automatically across your devices."
                  : "Sign in with Google to sync this library everywhere."}
              </p>
              {!isAuthenticated && (
                <p className="mt-2 text-xs text-slate-500">
                  We keep your list in this browser until you sign in.
                </p>
              )}
            </div>
          </div>
        </header>

        <section className="mt-2 grid gap-10 lg:grid-cols-[1.1fr_0.9fr]">
          <form
            onSubmit={handleSubmit}
            className="rounded-3xl border border-white/70 bg-white/90 p-8 shadow-xl shadow-amber-100/60 backdrop-blur"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-2xl font-semibold text-slate-900">
                Add a recipe
              </h2>
              <span className="text-xs font-semibold uppercase tracking-[0.3em] text-amber-500">
                Fresh entry
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              Ingredients can be comma or line separated. We will split and
              count them for you.
            </p>
            {!isAuthenticated && (
              <div className="mt-4 rounded-2xl border border-dashed border-rose-200 bg-rose-50/70 px-4 py-3 text-sm text-rose-600">
                Sign in to sync recipes across devices.
              </div>
            )}
            <div className="mt-6 space-y-5">
              <label className="block text-sm font-medium text-slate-700">
                Recipe title
                <input
                  value={form.title}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, title: event.target.value }))
                  }
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-amber-400 focus:ring-4 focus:ring-amber-100"
                  placeholder="Charred corn tacos"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Quick notes (optional)
                <textarea
                  value={form.summary}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      summary: event.target.value,
                    }))
                  }
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-amber-400 focus:ring-4 focus:ring-amber-100"
                  rows={2}
                  placeholder="Add marinade steps, oven temps, plating ideas..."
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Tags (optional)
                <input
                  value={form.tags}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      tags: event.target.value,
                    }))
                  }
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-amber-400 focus:ring-4 focus:ring-amber-100"
                  placeholder="Weeknight, Vegetarian, Meal prep"
                />
                <p className="mt-1 text-xs text-slate-400">
                  Separate with commas or line breaks.
                </p>
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Ingredients list
                <textarea
                  value={form.ingredients}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      ingredients: event.target.value,
                    }))
                  }
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-rose-400 focus:ring-4 focus:ring-rose-100"
                  rows={6}
                  placeholder={
                    "2 limes\nSalt\n4 ears corn\n2 tablespoons unsalted butter\n1 tablespoon olive oil\n1 medium white onion\n2 cloves garlic\n3 tablespoons chopped epazote\n1/2 cup crumbled cotija cheese\n1/4 teaspoon chili powder\n12 small (6-inch) soft corn tortillas"
                  }
                />
              </label>
              {showShareCollaboratorToggle && (
                <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-700 shadow-inner shadow-white/70">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 rounded border-slate-300 text-rose-500 focus:ring-rose-400"
                    checked={shareWithCurrentCollaborators}
                    onChange={(event) =>
                      setShareWithCurrentCollaborators(event.target.checked)
                    }
                  />
                  <span>
                    <span className="font-semibold text-slate-900">
                      Share with {collaboratorSummaryDisplay}
                    </span>
                    <p className="mt-1 text-xs text-slate-500">
                      We'll add them as recipe collaborators automatically.
                    </p>
                  </span>
                </label>
              )}
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex flex-1 items-center justify-center rounded-2xl bg-gradient-to-r from-rose-500 to-amber-400 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-rose-200/70 transition hover:scale-[1.01] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSaving
                  ? editingRecipeId
                    ? "Updating…"
                    : "Saving…"
                  : editingRecipeId
                  ? "Update recipe"
                  : "Save recipe"}
              </button>
              <button
                type="button"
                onClick={resetFormState}
                disabled={isSaving && Boolean(editingRecipeId)}
                className="inline-flex items-center justify-center rounded-2xl border border-transparent bg-white/60 px-4 py-3 text-sm font-semibold text-slate-600 shadow-inner shadow-white/60 transition hover:border-slate-200"
              >
                {editingRecipeId ? "Cancel editing" : "Reset"}
              </button>
            </div>
          </form>

          <div className="rounded-3xl border border-white/70 bg-white/85 p-8 shadow-xl shadow-slate-200/70 backdrop-blur">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1 sm:flex-1">
                <h2 className="text-2xl font-semibold text-slate-900">
                  Recipe library
                </h2>
                <span className="text-sm font-medium text-slate-500">
                  {isSyncing ? "Syncing…" : librarySummary}
                </span>
              </div>
              <div className="flex flex-col items-start gap-3 sm:items-end sm:flex-1">
                <div className="inline-flex rounded-2xl border border-slate-200 bg-white/80 p-1 text-xs font-semibold text-slate-500">
                  <button
                    type="button"
                    aria-pressed={libraryFilter === "all"}
                    onClick={() => setLibraryFilter("all")}
                    className={`rounded-xl px-4 py-2 transition ${
                      libraryFilter === "all"
                        ? "bg-slate-900 text-white shadow"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    All ({orderedRecipes.length})
                  </button>
                  <button
                    type="button"
                    aria-pressed={libraryFilter === "favorites"}
                    onClick={() => setLibraryFilter("favorites")}
                    className={`rounded-xl px-4 py-2 transition ${
                      libraryFilter === "favorites"
                        ? "bg-rose-500 text-white shadow"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    Favorites ({favoriteCount})
                  </button>
                </div>
                <button
                  type="button"
                  aria-pressed={sortMode === "favorites-first"}
                  disabled={
                    libraryFilter === "favorites" && favoriteCount === 0
                  }
                  onClick={() =>
                    setSortMode((current) =>
                      current === "favorites-first"
                        ? "default"
                        : "favorites-first"
                    )
                  }
                  title={
                    libraryFilter === "favorites"
                      ? favoriteCount === 0
                        ? "Add a favorite to enable this"
                        : "Favorites view already shows only starred recipes"
                      : "Bubble favorites to the top of the list"
                  }
                  className={`rounded-2xl border px-4 py-2 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400 disabled:cursor-not-allowed disabled:opacity-60 ${
                    sortMode === "favorites-first" && libraryFilter === "all"
                      ? "border-rose-200 bg-rose-50 text-rose-600"
                      : "border-slate-200 bg-white/70 text-slate-500 hover:text-slate-900"
                  }`}
                >
                  Favorites first
                </button>
                <p className="text-xs text-slate-400">
                  {canDragReorder
                    ? libraryFilter === "favorites"
                      ? "Drag any favorite to re-rank this view."
                      : "Drag recipes to reorder your library."
                    : effectiveSortMode !== "default"
                    ? "Disable Favorites first to drag and drop recipes."
                    : displayedRecipes.length <= 1
                    ? "Add another recipe to unlock drag-and-drop ordering."
                    : "Drag-to-reorder works in All or Favorites while using default sorting."}
                </p>
              </div>
            </div>
            <div
              className="mt-6 space-y-4"
              onDragOver={(event) => {
                if (
                  canDragReorder &&
                  draggingRecipeId &&
                  event.target === event.currentTarget
                ) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={handleRecipeListDrop}
            >
              {showRecipeSkeletons ? (
                Array.from({ length: 3 }).map((_, index) => (
                  <div
                    key={`recipe-skeleton-${index}`}
                    className="rounded-2xl border border-slate-100 bg-white/80 p-5 shadow-sm animate-pulse"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 space-y-3">
                        <div className="h-5 w-2/5 rounded-full bg-slate-200" />
                        <div className="h-3 w-3/4 rounded-full bg-slate-100" />
                        <div className="flex flex-wrap gap-2">
                          <span className="h-6 w-16 rounded-full bg-slate-100" />
                          <span className="h-6 w-20 rounded-full bg-slate-100" />
                          <span className="h-6 w-14 rounded-full bg-slate-100" />
                        </div>
                      </div>
                      <div className="h-8 w-8 rounded-full border border-slate-200 bg-white" />
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <span className="h-6 w-24 rounded-full bg-slate-100" />
                      <span className="h-6 w-32 rounded-full bg-slate-100" />
                      <span className="h-6 w-28 rounded-full bg-slate-100" />
                    </div>
                    <div className="mt-4 h-10 w-full rounded-xl bg-slate-200" />
                  </div>
                ))
              ) : displayedRecipes.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-5 text-sm text-slate-500">
                  {libraryFilter === "favorites"
                    ? "Mark recipes as favorites to spotlight them here."
                    : "No saved recipes yet. Add your first creation to see it in this library."}
                </div>
              ) : (
                displayedRecipes.map((recipe) => {
                  const recipeOwnerLabel =
                    recipe.owner?.name || recipe.owner?.email || "Shared";
                  const isRecipeOwner = recipe.owner?.id === currentUserId;
                  const isSharedRecipe = Boolean(
                    recipe.owner && !isRecipeOwner
                  );
                  const canShareRecipe = isAuthenticated && isRecipeOwner;
                  const recipeCollaborators =
                    recipeCollaboratorLookup.get(recipe.id) ?? [];
                  const isActionsMenuOpen = actionsMenuRecipeId === recipe.id;
                  return (
                    <article
                      key={recipe.id}
                      draggable={canDragReorder}
                      onDragStart={(event) => beginRecipeDrag(recipe.id, event)}
                      onDragOver={handleRecipeDragOver}
                      onDrop={(event) => handleRecipeDrop(event, recipe.id)}
                      onDragEnd={finalizeRecipeDrag}
                      aria-grabbed={draggingRecipeId === recipe.id}
                      className={`group relative rounded-2xl border p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg ${
                        recipe.isFavorite
                          ? "border-rose-200 bg-rose-50/80 shadow-rose-100"
                          : "border-slate-100 bg-white/90 shadow-slate-100"
                      } ${
                        canDragReorder
                          ? "cursor-grab active:cursor-grabbing"
                          : ""
                      } ${
                        draggingRecipeId === recipe.id
                          ? "opacity-70 ring-2 ring-rose-200"
                          : ""
                      } ${isActionsMenuOpen ? "z-40" : "z-0"}`}
                    >
                      <div
                        className="absolute right-4 top-4 z-20 sm:right-5 sm:top-5"
                        data-recipe-actions="true"
                      >
                        <button
                          type="button"
                          aria-haspopup="menu"
                          aria-expanded={isActionsMenuOpen}
                          title="Recipe actions"
                          disabled={deletingRecipeId === recipe.id}
                          onClick={() =>
                            setActionsMenuRecipeId((current) =>
                              current === recipe.id ? null : recipe.id
                            )
                          }
                          className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white/90 p-2 text-slate-500 shadow-inner shadow-white/70 transition hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span className="sr-only">Open recipe actions</span>
                          <span
                            aria-hidden="true"
                            className="flex flex-col items-center gap-1"
                          >
                            <span className="h-1 w-1 rounded-full bg-current" />
                            <span className="h-1 w-1 rounded-full bg-current" />
                            <span className="h-1 w-1 rounded-full bg-current" />
                          </span>
                        </button>
                        {isActionsMenuOpen && (
                          <div className="absolute right-0 z-30 mt-3 w-48 rounded-2xl border border-slate-100 bg-white/95 p-1 text-sm font-medium text-slate-600 shadow-lg shadow-slate-200/80">
                            <button
                              type="button"
                              className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition ${
                                recipe.isFavorite
                                  ? "text-rose-600 hover:bg-rose-50"
                                  : "hover:bg-slate-50"
                              }`}
                              disabled={
                                deletingRecipeId === recipe.id ||
                                favoriteUpdatingId === recipe.id
                              }
                              onClick={() => {
                                setActionsMenuRecipeId(null);
                                void handleToggleFavorite(recipe);
                              }}
                            >
                              <span>
                                {favoriteUpdatingId === recipe.id
                                  ? "Updating…"
                                  : recipe.isFavorite
                                  ? "Remove favorite"
                                  : "Mark favorite"}
                              </span>
                              <span
                                className={`text-xs ${
                                  recipe.isFavorite
                                    ? "text-rose-400"
                                    : "text-slate-400"
                                }`}
                              >
                                {recipe.isFavorite ? "★" : "☆"}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition hover:bg-slate-50"
                              disabled={deletingRecipeId === recipe.id}
                              onClick={() => {
                                setActionsMenuRecipeId(null);
                                handleEditRecipe(recipe);
                              }}
                            >
                              <span>
                                {editingRecipeId === recipe.id
                                  ? "Editing"
                                  : "Edit"}
                              </span>
                              <span className="text-xs text-slate-400">⌘E</span>
                            </button>
                            {canShareRecipe && (
                              <button
                                type="button"
                                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition hover:bg-slate-50"
                                onClick={() => {
                                  setActionsMenuRecipeId(null);
                                  openRosterDialog(
                                    `Collaborators on “${recipe.title}”`,
                                    recipeCollaborators
                                  );
                                }}
                              >
                                <span>View collaborators</span>
                                <span className="text-xs text-slate-400">
                                  👥
                                </span>
                              </button>
                            )}
                            {canShareRecipe && (
                              <button
                                type="button"
                                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition hover:bg-slate-50"
                                onClick={() => {
                                  setActionsMenuRecipeId(null);
                                  setInviteTarget({
                                    resourceType: "RECIPE",
                                    resourceId: recipe.id,
                                    resourceLabel: recipe.title,
                                    description:
                                      "Collaborators can edit this recipe and send its ingredients to their shopping list.",
                                  });
                                }}
                              >
                                <span>Share recipe</span>
                                <span className="text-xs text-slate-400">
                                  ⇢
                                </span>
                              </button>
                            )}
                            <button
                              type="button"
                              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-rose-600 transition hover:bg-rose-50"
                              disabled={deletingRecipeId === recipe.id}
                              onClick={() => {
                                setActionsMenuRecipeId(null);
                                requestDeleteRecipe(recipe);
                              }}
                            >
                              <span>Delete</span>
                              <span className="text-xs text-rose-300">⌘⌫</span>
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-4 pr-10 sm:flex-row sm:items-start sm:justify-between sm:pr-12">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-lg font-semibold text-slate-900">
                              {recipe.title}
                            </h3>
                            {isSharedRecipe && (
                              <span className="rounded-full bg-rose-100/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.25em] text-rose-500">
                                Shared by {recipeOwnerLabel}
                              </span>
                            )}
                          </div>
                          {recipe.summary && (
                            <p className="mt-1 text-sm text-slate-500">
                              {recipe.summary}
                            </p>
                          )}
                          {recipe.tags.length > 0 && (
                            <div className="mt-2 flex flex-nowrap items-center gap-2 overflow-x-auto pb-1">
                              {recipe.tags.map((tag, index) => (
                                <span
                                  key={`${recipe.id}-tag-${index}`}
                                  className="flex-shrink-0 rounded-full bg-rose-100/80 px-3 py-1 text-xs font-semibold text-rose-500 whitespace-nowrap"
                                >
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-2 text-right">
                          {isAuthenticated && recipe.isFavorite && (
                            <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-600">
                              Favorited
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/5 px-3 py-1 text-xs font-semibold text-slate-600 leading-none">
                            <span className="text-sm text-slate-800 leading-none">
                              {recipe.ingredients.length}
                            </span>
                            <span className="uppercase tracking-wide text-[11px] leading-none">
                              items
                            </span>
                          </span>
                        </div>
                      </div>
                      <ul className="mt-4 flex flex-wrap gap-2 text-xs font-medium text-slate-600">
                        {recipe.ingredients.map((ingredient, index) => (
                          <li
                            key={`${recipe.id}-ingredient-${index}`}
                            className="rounded-full bg-white/70 px-3 py-1 text-slate-600 shadow-inner shadow-white/70"
                          >
                            {ingredient}
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        onClick={() => handleAddToShoppingList(recipe)}
                        className="mt-4 inline-flex w-full items-center justify-center rounded-xl bg-slate-900/90 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-900"
                      >
                        Send ingredients to shopping list
                      </button>
                    </article>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </main>
      <CollaborationInviteDialog
        open={Boolean(inviteTarget)}
        title={
          inviteTarget?.resourceType === "SHOPPING_LIST"
            ? "Share your shopping list"
            : "Share this recipe"
        }
        description={
          inviteTarget?.description ??
          (inviteTarget?.resourceType === "SHOPPING_LIST"
            ? "Invite someone to edit and organize groceries with you."
            : "Give another cook edit access to this recipe.")
        }
        resourceLabel={inviteTarget?.resourceLabel ?? ""}
        onClose={() => setInviteTarget(null)}
        onSubmit={handleInviteSubmit}
      />
      <CollaboratorRosterDialog
        open={Boolean(rosterModal)}
        title={rosterModal?.title ?? ""}
        collaborators={rosterModal?.collaborators ?? []}
        onClose={() => setRosterModal(null)}
      />
      {pendingDeletionRecipe && (
        <div className="fixed inset-0 z-40 flex items-center justify-center px-4 py-8">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            aria-hidden="true"
            onClick={cancelDeleteRecipe}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-recipe-title"
            className="relative z-50 w-full max-w-md rounded-3xl border border-slate-100 bg-white p-6 shadow-2xl shadow-slate-900/10"
          >
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-500">
                  <span aria-hidden="true" className="text-xl">
                    ✕
                  </span>
                </div>
                <div>
                  <h2
                    id="delete-recipe-title"
                    className="text-lg font-semibold text-slate-900"
                  >
                    Delete “{pendingDeletionRecipe.title}”?
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    This removes it from your library and any collaborators will
                    lose access.
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={cancelDeleteRecipe}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Keep recipe
                </button>
                <button
                  type="button"
                  onClick={confirmDeleteRecipe}
                  disabled={deletingRecipeId === pendingDeletionRecipe.id}
                  className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-200 transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingRecipeId === pendingDeletionRecipe.id
                    ? "Deleting…"
                    : "Delete recipe"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {activeToast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-6 right-6 z-50 flex min-w-[260px] items-start gap-4 rounded-2xl border px-5 py-3 text-sm font-semibold shadow-2xl transition ${
            toastToneStyles[activeToast.tone]
          }`}
        >
          <span className="flex-1 leading-snug">{activeToast.message}</span>
          <button
            type="button"
            onClick={dismissToast}
            className="mt-0.5 rounded-full bg-white/70 px-2 py-1 text-xs font-bold uppercase tracking-wide text-slate-500 shadow-inner shadow-white/70 transition hover:bg-white"
            aria-label="Dismiss notification"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
