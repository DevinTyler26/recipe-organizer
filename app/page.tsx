"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useShoppingList } from "@/components/shopping-list-context";
import { useCollaborationUI } from "@/components/collaboration-ui-context";
import { AppNav } from "@/components/app-nav";
import { useToast } from "@/components/toast-provider";
import { parseIngredient, type IncomingIngredient } from "@/lib/shopping-list";
import type { CollaboratorSummary } from "@/types/collaboration";

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
  updatedAt: string;
  updatedBy: RecipeOwner;
  updatedById: string | null;
};

type StoredRecipe = {
  id: string;
  title: string;
  summary?: string | null;
  ingredients: string[];
  tags?: string[];
  isFavorite?: boolean;
  order?: number;
  sortOrder?: number;
  owner?: RecipeOwner;
  updatedAt?: string;
  updatedBy?: RecipeOwner;
  updatedById?: string | null;
};

type PantryConflictItem = {
  id: string;
  label: string;
  ingredient: IncomingIngredient;
  parsedLabel: string;
  measureText: string;
  amountValue: number | null;
};

type PantryConflictModalState = {
  recipeTitle: string;
  items: PantryConflictItem[];
};

const STARTER_UPDATED_AT = "2024-01-01T00:00:00.000Z";
const RECIPE_REFRESH_INTERVAL_MS = 12_000;

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
    updatedAt: STARTER_UPDATED_AT,
    updatedBy: null,
    updatedById: null,
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
    updatedAt: STARTER_UPDATED_AT,
    updatedBy: null,
    updatedById: null,
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
    updatedAt: STARTER_UPDATED_AT,
    updatedBy: null,
    updatedById: null,
  },
];

const LOCAL_RECIPES_KEY = "recipe-library-local";
const REMOTE_RECIPES_CACHE_KEY = "recipe-library-remote";
const OFFLINE_RECIPE_QUEUE_KEY = "recipe-library-offline-mutations";
const PENDING_RECIPE_ORDER_KEY = "recipe-library-pending-order";

type RecipeDraftPayload = {
  title: string;
  summary: string | null;
  ingredients: string[];
  tags: string[];
  shareWithOwnerId?: string | null;
  collaboratorIds?: string[];
};
type RecipeUpdatePayload = {
  id: string;
  title: string;
  summary: string | null;
  ingredients: string[];
  tags: string[];
};

type OfflineRecipeMutation =
  | {
      kind: "CREATE";
      tempId: string;
      payload: RecipeDraftPayload;
    }
  | {
      kind: "UPDATE";
      targetId: string;
      payload: RecipeUpdatePayload;
    }
  | {
      kind: "DELETE";
      targetId: string;
    }
  | {
      kind: "REORDER";
      orderedIds: string[];
    };

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

const titleCaseIngredient = (value: string) =>
  value
    .split(/\s+/)
    .map((segment) =>
      segment
        .split("-")
        .map((part) =>
          part
            ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
            : part
        )
        .join("-")
    )
    .join(" ")
    .trim();

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

const FILTER_HIGHLIGHT_CLASSES: Record<"all" | "favorites" | "mine", string> = {
  all: "bg-slate-900 shadow-lg",
  favorites: "bg-rose-500 shadow-lg",
  mine: "bg-amber-500 shadow-lg",
};

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

  const owner = normalizeRecipeOwner(recipe.owner);
  const updatedBy = normalizeRecipeOwner(recipe.updatedBy);
  const updatedAt =
    typeof recipe.updatedAt === "string" && recipe.updatedAt.length
      ? recipe.updatedAt
      : new Date().toISOString();
  const updatedById = recipe.updatedById ?? updatedBy?.id ?? null;

  return {
    id: recipe.id,
    title: recipe.title,
    summary:
      typeof recipe.summary === "string"
        ? recipe.summary
        : recipe.summary ?? null,
    ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
    tags: ensureTagsArray(recipe.tags),
    isFavorite: Boolean(recipe.isFavorite),
    order: normalizedOrder,
    owner,
    updatedAt,
    updatedBy,
    updatedById,
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
  const {
    addItems,
    lists,
    selectedListId,
    externalUpdateNotice,
    acknowledgeExternalUpdate,
    refreshCollaborativeLists,
    refreshPantry,
    hasLoadedStoredSelection,
  } = useShoppingList();
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated";
  const { showToast } = useToast();
  const router = useRouter();
  const {
    collaborationRoster,
    refreshCollaborations,
    openInviteDialog,
    openRosterDialog,
  } = useCollaborationUI();
  const [recipes, setRecipes] = useState<Recipe[]>(starterRecipes);
  const [form, setForm] = useState(emptyForm);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [favoriteUpdatingId, setFavoriteUpdatingId] = useState<string | null>(
    null
  );
  const [deletingRecipeId, setDeletingRecipeId] = useState<string | null>(null);
  const [leavingRecipeId, setLeavingRecipeId] = useState<string | null>(null);
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null);
  const [pendingDeletionRecipe, setPendingDeletionRecipe] =
    useState<Recipe | null>(null);
  const [actionsMenuRecipeId, setActionsMenuRecipeId] = useState<string | null>(
    null
  );
  const [guestLibraryLoaded, setGuestLibraryLoaded] = useState(false);
  const [recipesLoaded, setRecipesLoaded] = useState(false);
  const [offlineQueueVersion, setOfflineQueueVersion] = useState(0);
  const [shareWithCurrentCollaborators, setShareWithCurrentCollaborators] =
    useState(true);
  const [pantryConflictModal, setPantryConflictModal] =
    useState<PantryConflictModalState | null>(null);
  const [pantryConflictSelections, setPantryConflictSelections] = useState<
    Record<string, boolean>
  >({});
  const [pantryConflictQuantities, setPantryConflictQuantities] = useState<
    Record<string, number | null>
  >({});
  const [libraryFilter, setLibraryFilter] = useState<
    "all" | "favorites" | "mine"
  >("all");
  const [sortMode, setSortMode] = useState<"default" | "favorites-first">(
    "default"
  );
  const [sortPreferenceLoaded, setSortPreferenceLoaded] = useState(false);
  const [draggingRecipeId, setDraggingRecipeId] = useState<string | null>(null);
  const [isClientOnline, setIsClientOnline] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.navigator.onLine;
  });
  const recipeUpdateLedgerRef = useRef<Map<string, string>>(new Map());
  const hasPrimedRecipeLedgerRef = useRef(false);
  const recipeFormRef = useRef<HTMLFormElement | null>(null);
  const recipeTitleInputRef = useRef<HTMLInputElement | null>(null);
  const offlineRecipeMutationsRef = useRef<OfflineRecipeMutation[]>([]);
  const offlineRecipeQueueHydratedRef = useRef(false);
  const offlineRecipeQueueFlushInFlightRef = useRef(false);
  const liveUpdatesSourceRef = useRef<EventSource | null>(null);
  const pendingReorderRef = useRef<string[] | null>(null);
  const updateOfflineRecipeQueue = useCallback(
    (mutations: OfflineRecipeMutation[]) => {
      offlineRecipeMutationsRef.current = mutations;
      if (offlineRecipeQueueHydratedRef.current) {
        persistOfflineRecipeQueue(mutations);
      }
      setOfflineQueueVersion((current) => current + 1);
    },
    []
  );
  const queueOfflineReorder = useCallback(
    (orderedIds: string[]) => {
      const sanitizedIds = orderedIds.filter(
        (id) => typeof id === "string" && id.length > 0
      );
      if (!sanitizedIds.length) {
        return;
      }
      const withoutReorder = offlineRecipeMutationsRef.current.filter(
        (entry) => entry.kind !== "REORDER"
      );
      updateOfflineRecipeQueue([
        ...withoutReorder,
        { kind: "REORDER", orderedIds: sanitizedIds },
      ]);
    },
    [updateOfflineRecipeQueue]
  );
  const currentUserId = session?.user?.id ?? null;
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
  const pantryConflictSelectedItems = useMemo(() => {
    if (!pantryConflictModal) {
      return [];
    }
    return pantryConflictModal.items.filter(
      (item) => pantryConflictSelections[item.id]
    );
  }, [pantryConflictModal, pantryConflictSelections]);
  const hasPantryConflictSelections = Boolean(
    pantryConflictModal?.items.length
  );
  const pantryConflictNote = useMemo(() => {
    if (!pantryConflictModal) {
      return "";
    }
    return `These ingredients from "${pantryConflictModal.recipeTitle}" are already in your pantry and were skipped. Select any to add anyway and adjust the quantity if needed.`;
  }, [pantryConflictModal]);

  const formatQuantityValue = useCallback((value: number) => {
    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`;
  }, []);
  useEffect(() => {
    setShareWithCurrentCollaborators(true);
  }, [activeShoppingList?.ownerId]);
  const recipeCollaboratorLookup = useMemo(() => {
    const map = new Map<string, CollaboratorSummary[]>();
    collaborationRoster?.recipes.forEach((entry) => {
      map.set(entry.resourceId, entry.collaborators);
    });
    return map;
  }, [collaborationRoster]);
  const shoppingListCollaborators = useMemo(() => {
    if (
      !hasLoadedStoredSelection ||
      !collaborationRoster?.shoppingList ||
      collaborationRoster.shoppingList.ownerId !== currentUserId
    ) {
      return [];
    }
    return collaborationRoster.shoppingList.collaborators;
  }, [collaborationRoster, currentUserId, hasLoadedStoredSelection]);
  const activeListCollaborators = useMemo(() => {
    if (!hasLoadedStoredSelection || !activeShoppingList?.isSelf) {
      return [];
    }
    return shoppingListCollaborators;
  }, [
    activeShoppingList?.isSelf,
    shoppingListCollaborators,
    hasLoadedStoredSelection,
  ]);
  const activeListCollaboratorSummary = useMemo(() => {
    return summarizeCollaborators(activeListCollaborators);
  }, [activeListCollaborators]);
  const collaboratorSummaryDisplay =
    activeListCollaboratorSummary || "your collaborators";
  const showShareCollaboratorToggle = Boolean(
    hasLoadedStoredSelection &&
      isAuthenticated &&
      activeShoppingList?.isSelf &&
      activeListCollaborators.length > 0
  );

  const noteCollaboratorRecipeUpdates = useCallback(
    (incoming: Recipe[], options?: { suppressNotifications?: boolean }) => {
      if (!isAuthenticated) {
        recipeUpdateLedgerRef.current.clear();
        hasPrimedRecipeLedgerRef.current = false;
        return;
      }
      const suppress =
        options?.suppressNotifications || !hasPrimedRecipeLedgerRef.current;
      const ledger = recipeUpdateLedgerRef.current;
      const seen = new Set<string>();

      incoming.forEach((recipe) => {
        seen.add(recipe.id);
        const updatedAtValue = recipe.updatedAt ?? "";
        const previous = ledger.get(recipe.id);
        ledger.set(recipe.id, updatedAtValue);
        if (suppress || !previous || previous === updatedAtValue) {
          return;
        }
        const actorId = recipe.updatedBy?.id ?? null;
        if (!actorId || actorId === currentUserId) {
          return;
        }
        const actorLabel =
          recipe.updatedBy?.name?.trim() ||
          recipe.updatedBy?.email?.trim() ||
          "A collaborator";
        showToast(`${actorLabel} updated “${recipe.title}”.`, "info");
      });

      Array.from(ledger.keys()).forEach((id) => {
        if (!seen.has(id)) {
          ledger.delete(id);
        }
      });

      hasPrimedRecipeLedgerRef.current = true;
    },
    [currentUserId, isAuthenticated, showToast]
  );

  const fetchRemoteRecipes = useCallback(
    async (
      options: {
        background?: boolean;
        suppressNotifications?: boolean;
      } = {}
    ) => {
      const { background = false, suppressNotifications = false } = options;
      if (!isAuthenticated || !isClientOnline) {
        if (!background) {
          setIsSyncing(false);
        }
        return;
      }
      if (!background) {
        setIsSyncing(true);
      }
      try {
        const response = await fetch("/api/recipes", { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as {
          recipes?: Recipe[];
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(body?.error ?? "Failed to load recipes");
        }
        const normalized = normalizeRecipeList(
          body?.recipes as StoredRecipe[] | undefined
        );
        const queuedReorder = offlineRecipeMutationsRef.current.find(
          (entry) => entry.kind === "REORDER"
        );
        let pendingOrder =
          pendingReorderRef.current ?? queuedReorder?.orderedIds ?? null;
        if ((!pendingOrder || !pendingOrder.length) && queuedReorder) {
          pendingOrder = queuedReorder.orderedIds;
        }
        if (!pendingOrder || !pendingOrder.length) {
          const storedPendingOrder = readPendingRecipeOrder();
          if (storedPendingOrder.length) {
            pendingReorderRef.current = storedPendingOrder;
            pendingOrder = storedPendingOrder;
          }
        }
        const remoteIds = normalized.map((recipe) => recipe.id);
        let resolvedRecipes = normalized;
        if (pendingOrder && pendingOrder.length) {
          const ordersMatch =
            pendingOrder.length === remoteIds.length &&
            pendingOrder.every((id, index) => id === remoteIds[index]);
          if (ordersMatch) {
            pendingReorderRef.current = null;
            clearPendingRecipeOrder();
            if (!queuedReorder) {
              resolvedRecipes = normalized;
            }
          } else {
            const indexMap = new Map<string, number>();
            pendingOrder.forEach((id, index) => indexMap.set(id, index));
            const resorted = [...normalized].sort((a, b) => {
              const aIndex = indexMap.get(a.id);
              const bIndex = indexMap.get(b.id);
              if (aIndex !== undefined && bIndex !== undefined) {
                return aIndex - bIndex;
              }
              if (aIndex !== undefined) {
                return -1;
              }
              if (bIndex !== undefined) {
                return 1;
              }
              return a.order - b.order;
            });
            resolvedRecipes = resorted.map((recipe, index) => ({
              ...recipe,
              order: index,
            }));
          }
        }
        setRecipes(resolvedRecipes);
        persistRemoteRecipeCache(resolvedRecipes);
        noteCollaboratorRecipeUpdates(normalized, {
          suppressNotifications,
        });
        setRecipesLoaded(true);
      } catch (error) {
        console.error("Failed to fetch recipes", error);
        if (!background) {
          showToast("Unable to load your saved recipes.", "error");
          setRecipesLoaded(true);
        }
      } finally {
        if (!background) {
          setIsSyncing(false);
        }
      }
    },
    [isAuthenticated, isClientOnline, noteCollaboratorRecipeUpdates, showToast]
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

  const flushOfflineRecipeQueue = useCallback(async () => {
    if (
      !isAuthenticated ||
      !isClientOnline ||
      offlineRecipeQueueFlushInFlightRef.current ||
      !offlineRecipeQueueHydratedRef.current
    ) {
      return;
    }
    const queueSnapshot = [...offlineRecipeMutationsRef.current];
    if (!queueSnapshot.length) {
      return;
    }
    offlineRecipeQueueFlushInFlightRef.current = true;
    try {
      let pending = queueSnapshot;
      for (const mutation of queueSnapshot) {
        try {
          if (mutation.kind === "CREATE") {
            const response = await fetch("/api/recipes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(mutation.payload),
            });
            const body = (await response.json().catch(() => null)) as {
              recipe?: Recipe;
              error?: string;
            } | null;
            if (!response.ok || !body?.recipe) {
              throw new Error(body?.error ?? "Failed to sync offline recipe");
            }
            const savedRecipe = normalizeRecipe(body.recipe as StoredRecipe);
            setRecipes((current) => {
              const index = current.findIndex(
                (recipe) => recipe.id === mutation.tempId
              );
              if (index === -1) {
                return [savedRecipe, ...current];
              }
              const next = [...current];
              next[index] = savedRecipe;
              return next;
            });
            showToast(`${savedRecipe.title} synced once you were back online.`);
            pending = pending.filter((entry) => entry !== mutation);
            pending = pending.map((entry) => {
              if (entry.kind !== "REORDER") {
                return entry;
              }
              const remappedIds = entry.orderedIds.map((id) =>
                id === mutation.tempId ? savedRecipe.id : id
              );
              const changed = remappedIds.some(
                (id, idx) => id !== entry.orderedIds[idx]
              );
              return changed ? { ...entry, orderedIds: remappedIds } : entry;
            });
          } else if (mutation.kind === "UPDATE") {
            const response = await fetch("/api/recipes", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(mutation.payload),
            });
            const body = (await response.json().catch(() => null)) as {
              recipe?: Recipe;
              error?: string;
            } | null;
            if (!response.ok || !body?.recipe) {
              throw new Error(body?.error ?? "Failed to sync offline edits");
            }
            const updatedRecipe = normalizeRecipe(body.recipe as StoredRecipe);
            setRecipes((current) =>
              current.map((existing) =>
                existing.id === mutation.targetId ? updatedRecipe : existing
              )
            );
            showToast(
              `${updatedRecipe.title} updates synced once you were back online.`
            );
            pending = pending.filter((entry) => entry !== mutation);
          } else if (mutation.kind === "DELETE") {
            const response = await fetch("/api/recipes", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: mutation.targetId }),
            });
            const body = (await response.json().catch(() => null)) as {
              error?: string;
            } | null;
            if (!response.ok) {
              throw new Error(body?.error ?? "Failed to sync offline deletion");
            }
            showToast(`Recipe removed once you were back online.`, "info");
            pending = pending.filter((entry) => entry !== mutation);
          } else if (mutation.kind === "REORDER") {
            const response = await fetch("/api/recipes/reorder", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ order: mutation.orderedIds }),
            });
            if (!response.ok) {
              const body = (await response.json().catch(() => null)) as {
                error?: string;
              } | null;
              throw new Error(body?.error ?? "Failed to sync offline ordering");
            }
            showToast("Recipe order synced once you were back online.", "info");
            pending = pending.filter((entry) => entry !== mutation);
          }
        } catch (error) {
          console.error("Failed to sync offline recipe", error);
        }
      }
      updateOfflineRecipeQueue(pending);
    } finally {
      offlineRecipeQueueFlushInFlightRef.current = false;
    }
  }, [isAuthenticated, isClientOnline, showToast, updateOfflineRecipeQueue]);

  const resetFormState = useCallback(() => {
    setForm(emptyForm);
    setEditingRecipeId(null);
  }, []);

  useEffect(() => {
    void refreshCollaborations();
  }, [isAuthenticated, refreshCollaborations]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const syncStatus = () => {
      setIsClientOnline(window.navigator.onLine);
    };
    syncStatus();
    window.addEventListener("online", syncStatus);
    window.addEventListener("offline", syncStatus);
    return () => {
      window.removeEventListener("online", syncStatus);
      window.removeEventListener("offline", syncStatus);
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      offlineRecipeQueueHydratedRef.current = true;
      updateOfflineRecipeQueue([]);
      clearOfflineRecipeQueue();
      return;
    }
    const storedQueue = readOfflineRecipeQueue();
    offlineRecipeQueueHydratedRef.current = true;
    updateOfflineRecipeQueue(storedQueue);
  }, [isAuthenticated, updateOfflineRecipeQueue]);

  useEffect(() => {
    if (!isAuthenticated) {
      clearRemoteRecipeCache();
      try {
        const storedRecipes = window.localStorage.getItem(LOCAL_RECIPES_KEY);
        if (storedRecipes) {
          const parsed = JSON.parse(storedRecipes);
          if (Array.isArray(parsed)) {
            setRecipes(normalizeRecipeList(parsed as StoredRecipe[]));
            setGuestLibraryLoaded(true);
            setIsSyncing(false);
            setRecipesLoaded(true);
            recipeUpdateLedgerRef.current.clear();
            hasPrimedRecipeLedgerRef.current = false;
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
      recipeUpdateLedgerRef.current.clear();
      hasPrimedRecipeLedgerRef.current = false;
      return;
    }

    setGuestLibraryLoaded(false);
    const cachedRecipes = readRemoteRecipeCache();
    if (cachedRecipes.length) {
      setRecipes(cachedRecipes);
      setRecipesLoaded(true);
    } else {
      setRecipesLoaded(false);
    }
    recipeUpdateLedgerRef.current.clear();
    hasPrimedRecipeLedgerRef.current = false;
    void fetchRemoteRecipes({ suppressNotifications: true });
  }, [fetchRemoteRecipes, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void fetchRemoteRecipes({ background: true });
    }, RECIPE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [fetchRemoteRecipes, isAuthenticated, isClientOnline]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const handleFocus = () => {
      if (!isClientOnline) {
        return;
      }
      void fetchRemoteRecipes({ background: true });
    };
    const handleVisibility = () => {
      if (document.visibilityState !== "visible" || !isClientOnline) {
        return;
      }
      void fetchRemoteRecipes({ background: true });
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchRemoteRecipes, isAuthenticated, isClientOnline]);

  useEffect(() => {
    if (
      !isAuthenticated ||
      !isClientOnline ||
      !offlineRecipeQueueHydratedRef.current ||
      !offlineRecipeMutationsRef.current.length
    ) {
      return;
    }
    void flushOfflineRecipeQueue();
  }, [
    flushOfflineRecipeQueue,
    isAuthenticated,
    isClientOnline,
    offlineQueueVersion,
  ]);

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      if (liveUpdatesSourceRef.current) {
        liveUpdatesSourceRef.current.close();
        liveUpdatesSourceRef.current = null;
      }
      return;
    }
    if (liveUpdatesSourceRef.current) {
      return;
    }
    const source = new EventSource("/api/live");
    liveUpdatesSourceRef.current = source;
    const handleMessage = () => {
      void fetchRemoteRecipes({ background: true });
      void refreshCollaborativeLists();
    };
    source.onmessage = handleMessage;
    source.onerror = (event) => {
      console.error("Live updates connection lost", event);
    };
    return () => {
      source.close();
      if (liveUpdatesSourceRef.current === source) {
        liveUpdatesSourceRef.current = null;
      }
    };
  }, [
    fetchRemoteRecipes,
    isAuthenticated,
    isClientOnline,
    refreshCollaborativeLists,
  ]);

  useEffect(() => {
    if (!externalUpdateNotice || !isAuthenticated) {
      return;
    }
    const listLabel = externalUpdateNotice.isSelf
      ? "your shopping list"
      : `${externalUpdateNotice.ownerLabel}'s list`;
    showToast(`A collaborator updated ${listLabel}.`, "info");
    acknowledgeExternalUpdate();
  }, [
    acknowledgeExternalUpdate,
    externalUpdateNotice,
    isAuthenticated,
    showToast,
  ]);
  useEffect(() => {
    const storedFilter = window.localStorage.getItem("recipe-library-filter");
    if (
      storedFilter === "all" ||
      storedFilter === "favorites" ||
      storedFilter === "mine"
    ) {
      setLibraryFilter(storedFilter);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("recipe-library-filter", libraryFilter);
  }, [libraryFilter]);

  useEffect(() => {
    if (status === "loading") {
      return;
    }
    if (!currentUserId && libraryFilter === "mine") {
      setLibraryFilter("all");
    }
  }, [currentUserId, libraryFilter, status]);

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
    if (!isAuthenticated || !recipesLoaded) {
      return;
    }
    persistRemoteRecipeCache(recipes);
  }, [isAuthenticated, recipes, recipesLoaded]);

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
    const collaboratorDescriptor = shouldShareCollaborators
      ? summarizeCollaborators(activeListCollaborators)
      : "";
    const collaboratorSuffix = collaboratorDescriptor
      ? ` plus ${collaboratorDescriptor}`
      : "";
    const draftPayload: RecipeDraftPayload = { ...payload };
    if (shareTargetOwnerId) {
      draftPayload.shareWithOwnerId = shareTargetOwnerId;
    }
    if (collaboratorIdsPayload?.length) {
      draftPayload.collaboratorIds = collaboratorIdsPayload;
    }

    setIsSaving(true);
    if (editingRecipeId) {
      const recipeIdBeingEdited = editingRecipeId;
      const currentRecipe = recipes.find(
        (existing) => existing.id === recipeIdBeingEdited
      );
      if (isAuthenticated) {
        if (!isClientOnline) {
          if (!currentRecipe) {
            showToast("Unable to find this recipe locally.", "error");
            resetFormState();
            setIsSaving(false);
            return;
          }
          const offlineOwner: RecipeOwner = session?.user?.id
            ? {
                id: session.user.id,
                name: session.user.name ?? null,
                email: session.user.email ?? null,
              }
            : currentRecipe.updatedBy ?? currentRecipe.owner ?? null;
          const updatedRecipe: Recipe = {
            ...currentRecipe,
            title: trimmedTitle,
            summary: payload.summary,
            ingredients,
            tags,
            updatedAt: new Date().toISOString(),
            updatedBy: offlineOwner,
            updatedById: offlineOwner?.id ?? currentRecipe.updatedById ?? null,
          };
          setRecipes((current) =>
            current.map((existing) =>
              existing.id === recipeIdBeingEdited ? updatedRecipe : existing
            )
          );
          const queueSnapshot = offlineRecipeMutationsRef.current;
          const existingCreateIndex = queueSnapshot.findIndex(
            (entry) =>
              entry.kind === "CREATE" && entry.tempId === recipeIdBeingEdited
          );
          let nextQueue: OfflineRecipeMutation[];
          if (existingCreateIndex !== -1) {
            nextQueue = [...queueSnapshot];
            const existingEntry = nextQueue[existingCreateIndex];
            if (existingEntry.kind === "CREATE") {
              nextQueue[existingCreateIndex] = {
                ...existingEntry,
                payload: {
                  ...existingEntry.payload,
                  title: payload.title,
                  summary: payload.summary,
                  ingredients,
                  tags,
                },
              };
            }
          } else {
            const sanitizedQueue = queueSnapshot.filter(
              (entry) =>
                !(
                  entry.kind === "UPDATE" &&
                  entry.targetId === recipeIdBeingEdited
                )
            );
            const offlineUpdatePayload: RecipeUpdatePayload = {
              id: recipeIdBeingEdited,
              title: payload.title,
              summary: payload.summary,
              ingredients,
              tags,
            };
            nextQueue = [
              ...sanitizedQueue,
              {
                kind: "UPDATE",
                targetId: recipeIdBeingEdited,
                payload: offlineUpdatePayload,
              },
            ];
          }
          updateOfflineRecipeQueue(nextQueue);
          resetFormState();
          showToast(
            `${updatedRecipe.title} changes saved offline. We'll sync them when you're back online.`,
            "info"
          );
          setIsSaving(false);
          return;
        }
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
        updatedAt: new Date().toISOString(),
        updatedBy: null,
        updatedById: null,
      };
      setRecipes((current) => [newRecipe, ...current]);
      resetFormState();
      showToast(`${newRecipe.title} saved to this browser.`);
      setIsSaving(false);
      return;
    }

    if (!isClientOnline) {
      const tempId = generateRecipeId();
      const nextLocalOrder =
        recipes.length > 0
          ? Math.min(...recipes.map((existing) => existing.order)) - 1
          : 0;
      const offlineOwner: RecipeOwner = session?.user?.id
        ? {
            id: session.user.id,
            name: session.user.name ?? null,
            email: session.user.email ?? null,
          }
        : null;
      const offlineRecipe: Recipe = {
        id: tempId,
        title: trimmedTitle,
        summary: payload.summary,
        ingredients,
        tags,
        isFavorite: false,
        order: nextLocalOrder,
        owner: offlineOwner,
        updatedAt: new Date().toISOString(),
        updatedBy: offlineOwner,
        updatedById: offlineOwner?.id ?? null,
      };
      const offlineMutation: OfflineRecipeMutation = {
        kind: "CREATE",
        tempId,
        payload: draftPayload,
      };
      setRecipes((current) => [offlineRecipe, ...current]);
      updateOfflineRecipeQueue([
        ...offlineRecipeMutationsRef.current,
        offlineMutation,
      ]);
      setRecipesLoaded(true);
      resetFormState();
      const offlineShareLabel = shareRecipientLabel
        ? `${shareRecipientLabel}${collaboratorSuffix}`
        : collaboratorDescriptor;
      const offlineToastMessage = offlineShareLabel
        ? `${offlineRecipe.title} saved offline. We'll sync and share with ${offlineShareLabel} once you're back online.`
        : `${offlineRecipe.title} saved offline. We'll sync it once you're back online.`;
      showToast(offlineToastMessage, "info");
      setIsSaving(false);
      return;
    }

    try {
      const response = await fetch("/api/recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload),
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

  const openPantryConflictModal = useCallback(
    (
      recipe: Recipe,
      skippedIngredients: { label: string; ingredient: IncomingIngredient }[]
    ) => {
      const items = skippedIngredients.map((entry, index) => {
        const parsed = parseIngredient(entry.ingredient.value);
        const parsedLabel = parsed.label || entry.label;
        return {
          id: `${recipe.id}-pantry-${index}`,
          label: parsedLabel,
          ingredient: entry.ingredient,
          parsedLabel,
          measureText: parsed.measureText || "",
          amountValue:
            typeof parsed.amountValue === "number" &&
            Number.isFinite(parsed.amountValue)
              ? parsed.amountValue
              : null,
        };
      });
      setPantryConflictModal({
        recipeTitle: recipe.title,
        items,
      });
      setPantryConflictSelections({});
      setPantryConflictQuantities(
        items.reduce<Record<string, number | null>>((acc, item) => {
          acc[item.id] = item.amountValue;
          return acc;
        }, {})
      );
    },
    []
  );

  const closePantryConflictModal = useCallback(() => {
    setPantryConflictModal(null);
    setPantryConflictSelections({});
    setPantryConflictQuantities({});
  }, []);

  const handleConfirmPantryConflict = useCallback(() => {
    if (!pantryConflictModal) {
      return;
    }
    if (!pantryConflictSelectedItems.length) {
      closePantryConflictModal();
      return;
    }
    const result = addItems(
      pantryConflictSelectedItems.map((item) => {
        const quantity =
          typeof pantryConflictQuantities[item.id] === "number"
            ? pantryConflictQuantities[item.id]
            : null;
        if (quantity === null) {
          return item.ingredient;
        }
        const formatted = formatQuantityValue(quantity);
        const value = [formatted, item.measureText, item.parsedLabel]
          .filter((part) => part && part.trim().length)
          .join(" ");
        return { ...item.ingredient, value };
      }),
      undefined,
      { ignorePantry: true }
    );
    closePantryConflictModal();
    if (result.addedCount === 0) {
      showToast("Select a shopping list first.", "error");
      return;
    }
    const destinationLabel = activeShoppingList
      ? activeShoppingList.isSelf
        ? "your shopping list"
        : `${activeShoppingList.ownerLabel}'s list`
      : "your shopping list";
    const itemLabel = result.addedCount === 1 ? "item" : "items";
    showToast(
      `${result.addedCount} pantry ${itemLabel} added to ${destinationLabel}.`,
      "success",
      {
        onClick: () => router.push("/shopping-list"),
        actionLabel: "View list",
      }
    );
  }, [
    activeShoppingList,
    addItems,
    closePantryConflictModal,
    formatQuantityValue,
    pantryConflictModal,
    pantryConflictSelectedItems,
    pantryConflictQuantities,
    router,
    showToast,
  ]);

  const togglePantryConflictSelection = useCallback((id: string) => {
    setPantryConflictSelections((current) => ({
      ...current,
      [id]: !current[id],
    }));
  }, []);

  const updatePantryConflictQuantity = useCallback(
    (id: string, value: number | null) => {
      setPantryConflictQuantities((current) => ({
        ...current,
        [id]: value,
      }));
    },
    []
  );

  const adjustPantryConflictQuantity = useCallback(
    (item: PantryConflictItem, delta: number) => {
      const current =
        typeof pantryConflictQuantities[item.id] === "number"
          ? pantryConflictQuantities[item.id]!
          : item.amountValue ?? 0;
      const step =
        item.amountValue !== null && !Number.isInteger(item.amountValue)
          ? 0.5
          : 1;
      const next = Math.max(step, current + delta * step);
      updatePantryConflictQuantity(item.id, next);
    },
    [pantryConflictQuantities, updatePantryConflictQuantity]
  );

  const handleAddToShoppingList = async (recipe: Recipe) => {
    if (isAuthenticated) {
      await Promise.allSettled([refreshCollaborativeLists(), refreshPantry()]);
    }
    const result = addItems(
      recipe.ingredients.map((ingredient) => ({
        value: ingredient,
        recipeId: recipe.id,
        recipeTitle: recipe.title,
      }))
    );
    if (result.addedCount === 0) {
      if (!result.skippedIngredients.length) {
        showToast("Select a shopping list first.", "error");
      }
      if (result.skippedIngredients.length) {
        openPantryConflictModal(recipe, result.skippedIngredients);
      }
      return;
    }
    if (result.skippedIngredients.length) {
      openPantryConflictModal(recipe, result.skippedIngredients);
    }
    const destinationLabel = activeShoppingList
      ? activeShoppingList.isSelf
        ? "your shopping list"
        : `${activeShoppingList.ownerLabel}'s list`
      : "your shopping list";
    const skippedSuffix = result.skippedIngredients.length
      ? ` Skipped ${result.skippedIngredients.length} pantry item${
          result.skippedIngredients.length === 1 ? "" : "s"
        }.`
      : "";
    showToast(
      `${recipe.title} ingredients now live in ${destinationLabel}.${skippedSuffix}`,
      "success",
      {
        onClick: () => router.push("/shopping-list"),
        actionLabel: "View list",
      }
    );
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

  const handleLeaveRecipe = useCallback(
    async (recipe: Recipe) => {
      if (!isAuthenticated) {
        showToast("Sign in to manage shared recipes.", "error");
        return;
      }
      if (!isClientOnline) {
        showToast("Reconnect to leave this shared recipe.", "error");
        return;
      }
      setLeavingRecipeId(recipe.id);
      try {
        const response = await fetch("/api/collaborations", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resourceType: "RECIPE",
            resourceId: recipe.id,
          }),
        });
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(body?.error ?? "Failed to leave recipe");
        }
        setRecipes((current) =>
          current.filter((existing) => existing.id !== recipe.id)
        );
        showToast(`You left ${recipe.title}.`, "info");
        void refreshCollaborations();
        void fetchRemoteRecipes({ background: true });
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Unable to leave this recipe right now.";
        console.error("Failed to leave recipe collaboration", error);
        showToast(message, "error");
      } finally {
        setLeavingRecipeId((current) =>
          current === recipe.id ? null : current
        );
      }
    },
    [
      fetchRemoteRecipes,
      isAuthenticated,
      isClientOnline,
      refreshCollaborations,
      showToast,
    ]
  );

  const handleEditRecipe = useCallback((recipe: Recipe) => {
    setEditingRecipeId(recipe.id);
    setForm({
      title: recipe.title,
      summary: recipe.summary ?? "",
      ingredients: recipe.ingredients.join("\n"),
      tags: recipe.tags.join(", "),
    });
  }, []);

  useEffect(() => {
    if (!editingRecipeId || typeof window === "undefined") {
      return;
    }
    const formElement = recipeFormRef.current;
    if (!formElement) {
      return;
    }
    const prefersMobileLayout = window.matchMedia("(max-width: 767px)");
    if (!prefersMobileLayout.matches) {
      return;
    }
    window.requestAnimationFrame(() => {
      formElement.scrollIntoView({ behavior: "smooth", block: "start" });
      recipeTitleInputRef.current?.focus({ preventScroll: true });
    });
  }, [editingRecipeId]);

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

      if (!isClientOnline) {
        const queueSnapshot = offlineRecipeMutationsRef.current;
        const hadPendingCreate = queueSnapshot.some(
          (entry) => entry.kind === "CREATE" && entry.tempId === recipe.id
        );
        const sanitizedQueue = queueSnapshot.filter(
          (entry) =>
            !(
              (entry.kind === "CREATE" && entry.tempId === recipe.id) ||
              ((entry.kind === "UPDATE" || entry.kind === "DELETE") &&
                entry.targetId === recipe.id)
            )
        );
        const deleteMutation: OfflineRecipeMutation = {
          kind: "DELETE",
          targetId: recipe.id,
        };
        const nextQueue = hadPendingCreate
          ? sanitizedQueue
          : [...sanitizedQueue, deleteMutation];
        updateOfflineRecipeQueue(nextQueue);
        setRecipes((current) =>
          current.filter((existing) => existing.id !== recipe.id)
        );
        showToast(
          `${recipe.title} will be deleted once you're back online.`,
          "info"
        );
        setDeletingRecipeId(null);
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
    [
      editingRecipeId,
      isAuthenticated,
      isClientOnline,
      recipes,
      resetFormState,
      showToast,
      updateOfflineRecipeQueue,
    ]
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

  const favoritesOnly = useMemo(
    () => orderedRecipes.filter((recipe) => recipe.isFavorite),
    [orderedRecipes]
  );
  const favoriteCount = favoritesOnly.length;
  const ownedRecipes = useMemo(() => {
    if (!currentUserId) {
      return [];
    }
    return orderedRecipes.filter(
      (recipe) => recipe.owner?.id === currentUserId
    );
  }, [currentUserId, orderedRecipes]);
  const ownedCount = currentUserId ? ownedRecipes.length : 0;
  const baseLibrary = useMemo(() => {
    if (libraryFilter === "favorites") {
      return favoritesOnly;
    }
    if (libraryFilter === "mine") {
      return ownedRecipes;
    }
    return orderedRecipes;
  }, [favoritesOnly, libraryFilter, orderedRecipes, ownedRecipes]);
  const favoritesViewEmpty =
    libraryFilter === "favorites" && favoriteCount === 0;
  const effectiveSortMode = favoritesViewEmpty ? "default" : sortMode;
  const displayedRecipes = useMemo<Recipe[]>(() => {
    if (libraryFilter === "favorites" || effectiveSortMode === "default") {
      return baseLibrary;
    }
    const favoriteFirst = baseLibrary.filter((recipe) => recipe.isFavorite);
    const nonFavorites = baseLibrary.filter((recipe) => !recipe.isFavorite);
    return [...favoriteFirst, ...nonFavorites];
  }, [baseLibrary, effectiveSortMode, libraryFilter]);
  const showRecipeSkeletons = isAuthenticated && !recipesLoaded;
  const librarySummary = showRecipeSkeletons
    ? "Loading recipes…"
    : libraryFilter === "favorites"
    ? `${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"}`
    : libraryFilter === "mine"
    ? currentUserId
      ? `${ownedCount} owned`
      : "Sign in to see owned recipes"
    : `${orderedRecipes.length} saved`;
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
      let nextOrderIds: string[] = [];
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
        nextOrderIds = next.map((recipe) => recipe.id);
        pendingReorderRef.current = nextOrderIds;
        persistPendingRecipeOrder(nextOrderIds);
        return next;
      });
      const orderedIds = nextOrderIds;
      if (isAuthenticated && orderedIds.length > 0) {
        if (isClientOnline) {
          void persistRecipeOrder(orderedIds);
        } else {
          queueOfflineReorder(orderedIds);
        }
      }
      finalizeRecipeDrag();
    },
    [
      draggingRecipeId,
      finalizeRecipeDrag,
      isAuthenticated,
      isClientOnline,
      persistRecipeOrder,
      queueOfflineReorder,
    ]
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
        libraryFilter === "favorites" || libraryFilter === "mine"
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
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-10">
        <AppNav />

        <section className="mt-2 grid gap-10 lg:grid-cols-[1.1fr_0.9fr]">
          <form
            ref={recipeFormRef}
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
                  ref={recipeTitleInputRef}
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
                      We&rsquo;ll add them as recipe collaborators
                      automatically.
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
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
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
                    className={`relative isolate overflow-hidden rounded-xl px-4 py-2 transition ${
                      libraryFilter === "all"
                        ? "text-white"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    {libraryFilter === "all" && (
                      <motion.span
                        layoutId="libraryFilterHighlight"
                        className={`pointer-events-none absolute inset-0 rounded-xl ${FILTER_HIGHLIGHT_CLASSES.all}`}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 40,
                        }}
                      />
                    )}
                    <span className="relative z-10">
                      All ({orderedRecipes.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={libraryFilter === "favorites"}
                    onClick={() => setLibraryFilter("favorites")}
                    className={`relative isolate overflow-hidden rounded-xl px-4 py-2 transition ${
                      libraryFilter === "favorites"
                        ? "text-white"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    {libraryFilter === "favorites" && (
                      <motion.span
                        layoutId="libraryFilterHighlight"
                        className={`pointer-events-none absolute inset-0 rounded-xl ${FILTER_HIGHLIGHT_CLASSES.favorites}`}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 40,
                        }}
                      />
                    )}
                    <span className="relative z-10">
                      Favorites ({favoriteCount})
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={libraryFilter === "mine"}
                    disabled={!currentUserId}
                    title={
                      currentUserId
                        ? "Show only the recipes you created"
                        : "Sign in to filter by owner"
                    }
                    onClick={() => currentUserId && setLibraryFilter("mine")}
                    className={`relative isolate overflow-hidden rounded-xl px-4 py-2 transition ${
                      libraryFilter === "mine" && currentUserId
                        ? "text-white"
                        : "text-slate-500 hover:text-slate-900"
                    } ${!currentUserId ? "cursor-not-allowed opacity-50" : ""}`}
                  >
                    {libraryFilter === "mine" && currentUserId && (
                      <motion.span
                        layoutId="libraryFilterHighlight"
                        className={`pointer-events-none absolute inset-0 rounded-xl ${FILTER_HIGHLIGHT_CLASSES.mine}`}
                        transition={{
                          type: "spring",
                          stiffness: 500,
                          damping: 40,
                        }}
                      />
                    )}
                    <span className="relative z-10">
                      Mine ({currentUserId ? ownedCount : 0})
                    </span>
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
                    sortMode === "favorites-first" &&
                    libraryFilter !== "favorites"
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
                      : libraryFilter === "mine"
                      ? "Drag recipes you created to adjust their rank."
                      : "Drag recipes to reorder your library."
                    : effectiveSortMode !== "default"
                    ? "Disable Favorites first to drag and drop recipes."
                    : displayedRecipes.length <= 1
                    ? "Add another recipe to unlock drag-and-drop ordering."
                    : "Drag-to-reorder works in All, Mine, or Favorites while using default sorting."}
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
                    : libraryFilter === "mine"
                    ? currentUserId
                      ? "Recipes you create will show up here. Start by saving one."
                      : "Sign in to track which recipes you own."
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
                                  openRosterDialog({
                                    title: `Collaborators on “${recipe.title}”`,
                                    collaborators: recipeCollaborators,
                                    resourceType: "RECIPE",
                                    resourceId: recipe.id,
                                  });
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
                                  openInviteDialog({
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
                            {isSharedRecipe && (
                              <button
                                type="button"
                                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-rose-600 transition hover:bg-rose-50"
                                disabled={leavingRecipeId === recipe.id}
                                onClick={() => {
                                  setActionsMenuRecipeId(null);
                                  void handleLeaveRecipe(recipe);
                                }}
                              >
                                <span>
                                  {leavingRecipeId === recipe.id
                                    ? "Leaving…"
                                    : "Leave recipe"}
                                </span>
                                <span className="text-xs text-rose-300">↩</span>
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
                        <div className="flex flex-col items-start gap-2 text-left sm:items-end sm:text-right">
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
                            {titleCaseIngredient(ingredient)}
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
      {pantryConflictModal && (
        <div className="fixed inset-0 z-60 flex items-center justify-center px-4 py-8">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            aria-hidden="true"
            onClick={closePantryConflictModal}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pantry-conflict-title"
            className="relative z-70 w-full max-w-lg rounded-3xl border border-slate-100 bg-white p-6 shadow-2xl shadow-slate-900/10"
          >
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
                  <span aria-hidden="true" className="text-lg font-semibold">
                    !
                  </span>
                </div>
                <div>
                  <h2
                    id="pantry-conflict-title"
                    className="text-lg font-semibold text-slate-900"
                  >
                    Pantry match detected
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {pantryConflictNote}
                  </p>
                </div>
              </div>
              {hasPantryConflictSelections && (
                <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                  {pantryConflictModal.items.map((item) => {
                    const inputId = `pantry-conflict-${item.id}`;
                    const isSelected = Boolean(
                      pantryConflictSelections[item.id]
                    );
                    const quantityValue =
                      pantryConflictQuantities[item.id] ?? item.amountValue;
                    return (
                      <div
                        key={item.id}
                        className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
                      >
                        <label htmlFor={inputId} className="flex items-center gap-3">
                          <input
                            id={inputId}
                            type="checkbox"
                            checked={isSelected}
                            onChange={() =>
                              togglePantryConflictSelection(item.id)
                            }
                            className="h-4 w-4 accent-slate-900"
                          />
                          <span className="flex-1">{item.label}</span>
                        </label>
                        <div className="mt-2 flex items-center gap-2">
                          {quantityValue === null ? (
                            <span className="text-sm text-slate-500">
                              Use recipe amount
                            </span>
                          ) : (
                            <div className="flex flex-1 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!isSelected) {
                                    togglePantryConflictSelection(item.id);
                                  }
                                  adjustPantryConflictQuantity(item, -1);
                                }}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 text-slate-600 transition hover:bg-slate-100"
                                aria-label={`Decrease ${item.label} quantity`}
                              >
                                -
                              </button>
                              <div
                                className="min-w-[3rem] text-center text-sm font-semibold text-slate-700"
                              >
                                {formatQuantityValue(quantityValue)}
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  if (!isSelected) {
                                    togglePantryConflictSelection(item.id);
                                  }
                                  adjustPantryConflictQuantity(item, 1);
                                }}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 text-slate-600 transition hover:bg-slate-100"
                                aria-label={`Increase ${item.label} quantity`}
                              >
                                +
                              </button>
                              <span className="text-xs text-slate-500">
                                {item.measureText || "units"}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={closePantryConflictModal}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Skip pantry items
                </button>
                {hasPantryConflictSelections && (
                  <button
                    type="button"
                    onClick={handleConfirmPantryConflict}
                    disabled={!pantryConflictSelectedItems.length}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pantryConflictSelectedItems.length
                      ? `Add selected (${pantryConflictSelectedItems.length})`
                      : "Add selected"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {pendingDeletionRecipe && (
        <div className="fixed inset-0 z-60 flex items-center justify-center px-4 py-8">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            aria-hidden="true"
            onClick={cancelDeleteRecipe}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-recipe-title"
            className="relative z-70 w-full max-w-md rounded-3xl border border-slate-100 bg-white p-6 shadow-2xl shadow-slate-900/10"
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
    </div>
  );
}

function readRemoteRecipeCache(): Recipe[] {
  if (typeof window === "undefined") {
    return [];
  }
  const raw = window.localStorage.getItem(REMOTE_RECIPES_CACHE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((entry) => normalizeRecipe(entry as StoredRecipe));
  } catch (error) {
    console.warn("Failed to parse cached recipes", error);
    return [];
  }
}

function persistRemoteRecipeCache(recipes: Recipe[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!recipes.length) {
      window.localStorage.removeItem(REMOTE_RECIPES_CACHE_KEY);
      return;
    }
    window.localStorage.setItem(
      REMOTE_RECIPES_CACHE_KEY,
      JSON.stringify(recipes)
    );
  } catch (error) {
    console.warn("Failed to cache recipes", error);
  }
}

function clearRemoteRecipeCache() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(REMOTE_RECIPES_CACHE_KEY);
}

function readOfflineRecipeQueue(): OfflineRecipeMutation[] {
  if (typeof window === "undefined") {
    return [];
  }
  const raw = window.localStorage.getItem(OFFLINE_RECIPE_QUEUE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is OfflineRecipeMutation => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      if (entry.kind === "CREATE") {
        return (
          typeof entry.tempId === "string" &&
          entry.tempId.length > 0 &&
          entry.payload !== null &&
          typeof entry.payload === "object"
        );
      }
      if (entry.kind === "UPDATE") {
        return (
          typeof entry.targetId === "string" &&
          entry.targetId.length > 0 &&
          entry.payload !== null &&
          typeof entry.payload === "object" &&
          typeof (entry.payload as { id?: unknown }).id === "string"
        );
      }
      if (entry.kind === "DELETE") {
        return typeof entry.targetId === "string" && entry.targetId.length > 0;
      }
      if (entry.kind === "REORDER") {
        return (
          Array.isArray(entry.orderedIds) &&
          entry.orderedIds.every(
            (id: unknown) => typeof id === "string" && id.length > 0
          )
        );
      }
      return false;
    });
  } catch (error) {
    console.warn("Failed to parse offline recipe queue", error);
    return [];
  }
}

function persistOfflineRecipeQueue(mutations: OfflineRecipeMutation[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!mutations.length) {
      window.localStorage.removeItem(OFFLINE_RECIPE_QUEUE_KEY);
      return;
    }
    window.localStorage.setItem(
      OFFLINE_RECIPE_QUEUE_KEY,
      JSON.stringify(mutations)
    );
  } catch (error) {
    console.warn("Failed to cache offline recipe queue", error);
  }
}

function clearOfflineRecipeQueue() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(OFFLINE_RECIPE_QUEUE_KEY);
}

function readPendingRecipeOrder(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  const raw = window.localStorage.getItem(PENDING_RECIPE_ORDER_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((id: unknown) => typeof id === "string" && id.length > 0)
    ) {
      return parsed as string[];
    }
  } catch (error) {
    console.warn("Failed to parse pending recipe order", error);
  }
  return [];
}

function persistPendingRecipeOrder(order: string[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!order.length) {
      window.localStorage.removeItem(PENDING_RECIPE_ORDER_KEY);
      return;
    }
    window.localStorage.setItem(
      PENDING_RECIPE_ORDER_KEY,
      JSON.stringify(order)
    );
  } catch (error) {
    console.warn("Failed to cache pending recipe order", error);
  }
}

function clearPendingRecipeOrder() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(PENDING_RECIPE_ORDER_KEY);
}
