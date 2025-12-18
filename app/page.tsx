"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { useShoppingList } from "@/components/shopping-list-context";

type ToastTone = "success" | "info" | "error";

type ToastMessage = {
  id: number;
  message: string;
  tone: ToastTone;
};
type Recipe = {
  id: string;
  title: string;
  summary: string | null;
  ingredients: string[];
  tags: string[];
  isFavorite: boolean;
  order: number;
};

type StoredRecipe = Omit<Recipe, "tags" | "order"> & {
  tags?: string[];
  order?: number;
  sortOrder?: number;
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
  };
};

const normalizeRecipeList = (list?: StoredRecipe[] | null) =>
  Array.isArray(list)
    ? list.map(normalizeRecipe).sort((a, b) => a.order - b.order)
    : [];

export default function HomePage() {
  const { addItems, totalItems } = useShoppingList();
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
  const [actionsMenuRecipeId, setActionsMenuRecipeId] = useState<string | null>(
    null
  );
  const [guestLibraryLoaded, setGuestLibraryLoaded] = useState(false);
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
  const accountLabel = session?.user?.name || session?.user?.email || "Account";
  const orderedRecipes = useMemo(
    () => [...recipes].sort((a, b) => a.order - b.order),
    [recipes]
  );

  const showToast = useCallback(
    (message: string, tone: ToastTone = "success") => {
      setToastQueue((current) => [
        ...current,
        { id: Date.now() + Math.random(), message, tone },
      ]);
    },
    []
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
    if (!isAuthenticated) {
      try {
        const storedRecipes = window.localStorage.getItem(LOCAL_RECIPES_KEY);
        if (storedRecipes) {
          const parsed = JSON.parse(storedRecipes);
          if (Array.isArray(parsed)) {
            setRecipes(normalizeRecipeList(parsed as StoredRecipe[]));
            setGuestLibraryLoaded(true);
            setIsSyncing(false);
            return;
          }
        }
      } catch (error) {
        console.error("Failed to load local recipes", error);
      }
      setRecipes(starterRecipes);
      setIsSyncing(false);
      setGuestLibraryLoaded(true);
      return;
    }

    setGuestLibraryLoaded(false);
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
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to fetch recipes", error);
          showToast("Unable to load your saved recipes.", "error");
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
        body: JSON.stringify(payload),
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
      showToast(
        `${savedRecipe.title} is ready. Send it to your list when needed.`
      );
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
    showToast(`${recipe.title} ingredients now live in your shopping list.`);
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
      const updatedRecipe = normalizeRecipe(body.recipe as StoredRecipe);
      setRecipes((current) =>
        current.map((existing) =>
          existing.id === recipe.id ? updatedRecipe : existing
        )
      );
      showToast(
        updatedRecipe.isFavorite
          ? `${updatedRecipe.title} marked as a favorite.`
          : `${updatedRecipe.title} removed from favorites.`
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

  const handleDeleteRecipe = useCallback(
    async (recipe: Recipe) => {
      const confirmed = window.confirm(
        `Delete ${recipe.title}? This action cannot be undone.`
      );

      if (!confirmed) {
        return;
      }

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
        void handleDeleteRecipe(activeRecipe);
      }
    };

    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [actionsMenuRecipeId, handleDeleteRecipe, handleEditRecipe, recipes]);

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
  const librarySummary =
    libraryFilter === "favorites"
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
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-rose-500">
                Recipe Organizer
              </p>
              <h1 className="text-4xl font-semibold leading-tight text-slate-900 sm:text-5xl">
                Build dinners, snacks, and a synced shopping list.
              </h1>
              <p className="max-w-2xl text-lg text-slate-600">
                Drop the recipes you love, tag every ingredient, and dispatch
                the entire pantry plan to your shopping list in one tap.
              </p>
            </div>
            <div className="space-y-3 rounded-3xl border border-white/70 bg-white/80 p-6 text-sm text-slate-600 shadow-lg shadow-white/60">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-500">
                  {isAuthenticated ? "Signed in" : "Guest mode"}
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-900">
                  {isAuthenticated
                    ? accountLabel
                    : "Sign in to sync recipes across devices"}
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
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
                  className="inline-flex flex-1 items-center justify-center rounded-2xl border border-slate-200 bg-white/70 px-4 py-2 font-semibold text-slate-700 shadow-inner shadow-white/60 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isAuthenticated ? "Sign out" : "Sign in with Google"}
                </button>
                <Link
                  href="/shopping-list"
                  className="inline-flex flex-1 items-center justify-center rounded-2xl bg-slate-900 px-4 py-2 font-semibold text-white shadow-lg shadow-slate-900/20 transition hover:-translate-y-0.5"
                >
                  View Shopping List ({shoppingListTotal})
                </Link>
              </div>
              {!isAuthenticated && (
                <p className="text-xs text-slate-500">
                  We keep your local list for this browser, but sign in to sync
                  it everywhere.
                </p>
              )}
            </div>
          </div>
        </header>

        <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr]">
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
              {displayedRecipes.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-5 text-sm text-slate-500">
                  {libraryFilter === "favorites"
                    ? "Mark recipes as favorites to spotlight them here."
                    : "No saved recipes yet. Add your first creation to see it in this library."}
                </div>
              ) : (
                displayedRecipes.map((recipe) => (
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
                      canDragReorder ? "cursor-grab active:cursor-grabbing" : ""
                    } ${
                      draggingRecipeId === recipe.id
                        ? "opacity-70 ring-2 ring-rose-200"
                        : ""
                    }`}
                  >
                    <div
                      className="absolute right-4 top-4 sm:right-5 sm:top-5"
                      data-recipe-actions="true"
                    >
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={actionsMenuRecipeId === recipe.id}
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
                      {actionsMenuRecipeId === recipe.id && (
                        <div className="absolute right-0 z-10 mt-3 w-48 rounded-2xl border border-slate-100 bg-white/95 p-1 text-sm font-medium text-slate-600 shadow-lg shadow-slate-200/80">
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
                          <button
                            type="button"
                            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-rose-600 transition hover:bg-rose-50"
                            disabled={deletingRecipeId === recipe.id}
                            onClick={() => {
                              setActionsMenuRecipeId(null);
                              void handleDeleteRecipe(recipe);
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
                ))
              )}
            </div>
          </div>
        </section>
      </main>
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
