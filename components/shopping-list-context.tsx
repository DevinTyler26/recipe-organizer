"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";

import {
  IncomingIngredient,
  QuantityEntry,
  ShoppingListItem,
  ShoppingListState,
  normalizeLabel,
  normalizeMeasureText,
  parseIngredient,
  summarizeEntries,
} from "@/lib/shopping-list";

const STORAGE_KEY = "recipe-organizer-shopping-list";
const SELECTED_OWNER_STORAGE_KEY = "recipe-organizer-active-shopping-list";

type ShoppingListContextValue = {
  items: ShoppingListItem[];
  lists: ShoppingListListMeta[];
  selectedListId: string | null;
  selectList: (ownerId: string) => void;
  addItems: (items: IncomingIngredient[], ownerId?: string) => void;
  removeItem: (key: string, ownerId?: string) => void;
  clearList: (ownerId?: string) => void;
  reorderItems: (keys: string[], ownerId?: string) => void;
  updateQuantity: (
    key: string,
    quantityText: string,
    ownerId?: string
  ) => Promise<void>;
  totalItems: number;
  isSyncing: boolean;
  isRemote: boolean;
};

type OwnerListState = {
  ownerId: string;
  ownerLabel: string;
  isSelf: boolean;
  state: ShoppingListState;
};

export type ShoppingListListMeta = {
  ownerId: string;
  ownerLabel: string;
  isSelf: boolean;
  totalItems: number;
};

const ShoppingListContext = createContext<ShoppingListContextValue | null>(
  null
);

const createId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 11);

function readStoredState(): ShoppingListState {
  if (typeof window === "undefined") {
    return {};
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return {};
  }
  try {
    return reviveStore(JSON.parse(raw));
  } catch (error) {
    console.warn("Failed to parse shopping list from storage", error);
    return {};
  }
}

const getNextOrderValue = (state: ShoppingListState) => {
  const orders = Object.values(state).map((record) => record.order ?? 0);
  return orders.length ? Math.max(...orders) : -1;
};

const LOCAL_OWNER_ID = "local";
const LOCAL_LIST_LABEL = "This device";

export function ShoppingListProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated";
  const currentUserId = session?.user?.id ?? null;
  const currentUserLabel =
    session?.user?.name || session?.user?.email || "Your list";
  const [localStore, setLocalStore] = useState<ShoppingListState>(() =>
    readStoredState()
  );
  const [remoteLists, setRemoteLists] = useState<OwnerListState[]>([]);
  const [isRemote, setIsRemote] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return window.localStorage.getItem(SELECTED_OWNER_STORAGE_KEY);
  });

  const fetchRemoteLists = useCallback(async () => {
    const response = await fetch("/api/shopping-list", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as {
      lists?: {
        ownerId: string;
        ownerLabel: string;
        isSelf: boolean;
        state: ShoppingListState;
      }[];
      error?: string;
    } | null;
    if (!response.ok || !Array.isArray(body?.lists)) {
      throw new Error(body?.error ?? "Failed to load shopping list");
    }
    return body.lists.map((list) => ({
      ownerId: list.ownerId,
      ownerLabel: list.ownerLabel,
      isSelf: list.isSelf,
      state: reviveStore(list.state),
    }));
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setIsRemote(false);
      setRemoteLists([]);
      setLocalStore(readStoredState());
      setSelectedOwnerId(LOCAL_OWNER_ID);
      return;
    }

    let cancelled = false;
    setIsSyncing(true);
    fetchRemoteLists()
      .then((lists) => {
        if (cancelled) return;
        setRemoteLists(lists);
        setIsRemote(true);
        setSelectedOwnerId((current) => {
          if (current && lists.some((list) => list.ownerId === current)) {
            return current;
          }
          return lists[0]?.ownerId ?? currentUserId ?? current;
        });
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to fetch shopping list", error);
          setIsRemote(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsSyncing(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentUserId, fetchRemoteLists, isAuthenticated]);

  useEffect(() => {
    if (typeof window === "undefined" || isAuthenticated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(localStore));
  }, [localStore, isAuthenticated]);

  const runRemoteMutation = useCallback(
    async (action: () => Promise<Response>) => {
      if (!isAuthenticated) {
        return {
          success: false,
          error: new Error("You need to sign in to sync this list"),
        } as const;
      }
      setIsSyncing(true);
      try {
        const response = await action();
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "Shopping list request failed");
        }
        const nextLists = await fetchRemoteLists();
        setRemoteLists(nextLists);
        setIsRemote(true);
        setSelectedOwnerId((current) => {
          if (current && nextLists.some((list) => list.ownerId === current)) {
            return current;
          }
          return nextLists[0]?.ownerId ?? currentUserId ?? current;
        });
        return { success: true } as const;
      } catch (error) {
        console.error("Shopping list sync failed", error);
        return {
          success: false,
          error:
            error instanceof Error
              ? error
              : new Error("Shopping list sync failed"),
        } as const;
      } finally {
        setIsSyncing(false);
      }
    },
    [currentUserId, fetchRemoteLists, isAuthenticated]
  );

  const resolveOwnerId = useCallback(
    (override?: string | null) => {
      if (!isAuthenticated) {
        return LOCAL_OWNER_ID;
      }
      if (override && override.trim().length) {
        return override.trim();
      }
      return selectedOwnerId ?? currentUserId ?? null;
    },
    [currentUserId, isAuthenticated, selectedOwnerId]
  );

  const addItems = useCallback(
    (ingredients: IncomingIngredient[], ownerOverride?: string) => {
      if (!ingredients.length) return;
      if (!isAuthenticated) {
        setLocalStore((current) => {
          const next = { ...current } as ShoppingListState;
          let orderCursor = getNextOrderValue(next);
          ingredients.forEach(({ value, recipeId, recipeTitle }) => {
            const parsed = parseIngredient(value);
            if (!parsed.label) return;
            const key = parsed.normalizedLabel || normalizeLabel(parsed.label);
            const entry: QuantityEntry = {
              id: createId(),
              quantityText: parsed.quantityText,
              amountValue: parsed.amountValue,
              measureText: parsed.measureText,
              sourceRecipeId: recipeId,
              sourceRecipeTitle: recipeTitle,
            };
            const existing = next[key];
            if (existing) {
              next[key] = {
                ...existing,
                label: parsed.label,
                entries: [...existing.entries, entry],
                order: existing.order,
              };
            } else {
              orderCursor += 1;
              next[key] = {
                label: parsed.label,
                entries: [entry],
                order: orderCursor,
              };
            }
          });
          return next;
        });
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) {
        console.warn("No shopping list owner available for new items");
        return;
      }

      void runRemoteMutation(() =>
        fetch("/api/shopping-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ingredients, ownerId: targetOwnerId }),
        })
      );
    },
    [isAuthenticated, resolveOwnerId, runRemoteMutation]
  );

  const removeItem = useCallback(
    (key: string, ownerOverride?: string) => {
      if (!key) return;
      if (!isAuthenticated) {
        setLocalStore((current) => {
          if (!current[key]) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) return;
      const params = new URLSearchParams({
        label: key,
        ownerId: targetOwnerId,
      });
      void runRemoteMutation(() =>
        fetch(`/api/shopping-list?${params.toString()}`, { method: "DELETE" })
      );
    },
    [isAuthenticated, resolveOwnerId, runRemoteMutation]
  );

  const clearList = useCallback(
    (ownerOverride?: string) => {
      if (!isAuthenticated) {
        setLocalStore({});
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) return;
      const params = new URLSearchParams({ ownerId: targetOwnerId });
      void runRemoteMutation(() =>
        fetch(`/api/shopping-list?${params.toString()}`, { method: "DELETE" })
      );
    },
    [isAuthenticated, resolveOwnerId, runRemoteMutation]
  );

  const reorderItems = useCallback(
    (orderedKeys: string[], ownerOverride?: string) => {
      if (!orderedKeys.length) return;

      if (!isAuthenticated) {
        setLocalStore((current) => reorderState(current, orderedKeys));
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) return;

      const targetList = remoteLists.find(
        (list) => list.ownerId === targetOwnerId
      );
      if (targetList) {
        const updatedState = reorderState(targetList.state, orderedKeys);
        if (updatedState === targetList.state) {
          return;
        }
      }

      setRemoteLists((current) => {
        let changed = false;
        const next = current.map((list) => {
          if (list.ownerId !== targetOwnerId) {
            return list;
          }
          const updatedState = reorderState(list.state, orderedKeys);
          if (updatedState === list.state) {
            return list;
          }
          changed = true;
          return { ...list, state: updatedState };
        });
        return changed ? next : current;
      });

      void runRemoteMutation(() =>
        fetch("/api/shopping-list", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: orderedKeys, ownerId: targetOwnerId }),
        })
      );
    },
    [isAuthenticated, remoteLists, resolveOwnerId, runRemoteMutation]
  );

  const updateItemQuantity = useCallback(
    async (key: string, quantityText: string, ownerOverride?: string) => {
      if (!key) {
        throw new Error("Missing list item identifier");
      }

      if (!isAuthenticated) {
        setLocalStore((current) =>
          applyQuantityOverrideToState(current, key, quantityText)
        );
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) {
        throw new Error("Select a shopping list first");
      }

      const previousLists = remoteLists;
      setRemoteLists((current) =>
        current.map((list) => {
          if (list.ownerId !== targetOwnerId) {
            return list;
          }
          const nextState = applyQuantityOverrideToState(
            list.state,
            key,
            quantityText
          );
          if (nextState === list.state) {
            return list;
          }
          return { ...list, state: nextState };
        })
      );

      const result = await runRemoteMutation(() =>
        fetch("/api/shopping-list", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ownerId: targetOwnerId,
            label: key,
            quantity: quantityText,
          }),
        })
      );

      if (!result.success) {
        setRemoteLists(previousLists);
        throw result.error;
      }
    },
    [isAuthenticated, remoteLists, resolveOwnerId, runRemoteMutation]
  );

  const resolvedLists = useMemo<OwnerListState[]>(() => {
    if (isAuthenticated) {
      if (isRemote) {
        return remoteLists;
      }
      if (currentUserId) {
        return [
          {
            ownerId: currentUserId,
            ownerLabel: currentUserLabel,
            isSelf: true,
            state: {},
          },
        ];
      }
      return [];
    }

    return [
      {
        ownerId: LOCAL_OWNER_ID,
        ownerLabel: LOCAL_LIST_LABEL,
        isSelf: true,
        state: localStore,
      },
    ];
  }, [
    currentUserId,
    currentUserLabel,
    isAuthenticated,
    isRemote,
    localStore,
    remoteLists,
  ]);

  useEffect(() => {
    if (!resolvedLists.length) return;
    setSelectedOwnerId((current) => {
      if (current && resolvedLists.some((list) => list.ownerId === current)) {
        return current;
      }
      return resolvedLists[0].ownerId;
    });
  }, [resolvedLists]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectedOwnerId) {
      window.localStorage.setItem(SELECTED_OWNER_STORAGE_KEY, selectedOwnerId);
    } else {
      window.localStorage.removeItem(SELECTED_OWNER_STORAGE_KEY);
    }
  }, [selectedOwnerId]);

  const activeList = useMemo(() => {
    if (!resolvedLists.length) return null;
    if (selectedOwnerId) {
      const matching = resolvedLists.find(
        (list) => list.ownerId === selectedOwnerId
      );
      if (matching) {
        return matching;
      }
    }
    return resolvedLists[0] ?? null;
  }, [resolvedLists, selectedOwnerId]);

  const items = useMemo(() => {
    if (!activeList) return [];
    return mapStateToItems(activeList.state, activeList);
  }, [activeList]);

  const listsMeta = useMemo<ShoppingListListMeta[]>(() => {
    return resolvedLists.map((list) => ({
      ownerId: list.ownerId,
      ownerLabel: list.ownerLabel,
      isSelf: list.isSelf,
      totalItems: Object.values(list.state).reduce(
        (sum, record) => sum + record.entries.length,
        0
      ),
    }));
  }, [resolvedLists]);

  const totalItems = useMemo(
    () => items.reduce((sum, entry) => sum + entry.occurrences, 0),
    [items]
  );

  const selectList = useCallback((ownerId: string) => {
    setSelectedOwnerId(ownerId);
  }, []);

  const activeListId = activeList?.ownerId ?? selectedOwnerId ?? null;

  const value = useMemo(
    () => ({
      items,
      lists: listsMeta,
      selectedListId: activeListId,
      selectList,
      addItems,
      removeItem,
      clearList,
      reorderItems,
      updateQuantity: updateItemQuantity,
      totalItems,
      isSyncing,
      isRemote,
    }),
    [
      items,
      listsMeta,
      activeListId,
      selectList,
      addItems,
      removeItem,
      clearList,
      reorderItems,
      updateItemQuantity,
      totalItems,
      isSyncing,
      isRemote,
    ]
  );

  return (
    <ShoppingListContext.Provider value={value}>
      {children}
    </ShoppingListContext.Provider>
  );
}

export function useShoppingList() {
  const context = useContext(ShoppingListContext);
  if (!context) {
    throw new Error(
      "useShoppingList must be used within a ShoppingListProvider"
    );
  }
  return context;
}

function mapStateToItems(
  state: ShoppingListState,
  meta: Pick<OwnerListState, "ownerId" | "ownerLabel" | "isSelf">
): ShoppingListItem[] {
  return Object.entries(state)
    .map(([key, record]) => ({
      id: `${meta.ownerId}:${key}`,
      storageKey: key,
      label: record.label,
      unitSummary: summarizeEntries(record.entries),
      occurrences: record.entries.length,
      sources: Array.from(
        new Set(
          record.entries
            .map((entry) => entry.sourceRecipeTitle?.trim())
            .filter((title): title is string => Boolean(title))
        )
      ),
      order: record.order ?? 0,
      ownerId: meta.ownerId,
      ownerLabel: meta.ownerLabel,
      isSelf: meta.isSelf,
    }))
    .sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return a.label.localeCompare(b.label);
    });
}

function reorderState(
  state: ShoppingListState,
  orderedKeys: string[]
): ShoppingListState {
  if (!orderedKeys.length) {
    return state;
  }
  const provided = orderedKeys.filter((key) => state[key]);
  const providedSet = new Set(provided);
  const missing = Object.keys(state).filter((key) => !providedSet.has(key));
  const nextOrderSequence = [...provided, ...missing];
  if (!nextOrderSequence.length) {
    return state;
  }
  let updated = false;
  const next: ShoppingListState = { ...state };
  nextOrderSequence.forEach((key, index) => {
    const record = state[key];
    if (!record) return;
    if ((record.order ?? 0) !== index) {
      next[key] = { ...record, order: index };
      updated = true;
    }
  });
  return updated ? next : state;
}

function applyQuantityOverrideToState(
  state: ShoppingListState,
  key: string,
  quantityText: string
): ShoppingListState {
  const record = state[key];
  if (!record) {
    return state;
  }
  const manualEntry = buildManualQuantityEntry(record.label, quantityText);
  if (
    record.entries.length === 1 &&
    record.entries[0].quantityText === manualEntry.quantityText &&
    record.entries[0].amountValue === manualEntry.amountValue &&
    record.entries[0].measureText === manualEntry.measureText
  ) {
    return state;
  }
  return {
    ...state,
    [key]: {
      ...record,
      entries: [manualEntry],
    },
  };
}

function buildManualQuantityEntry(
  label: string,
  quantityText: string
): QuantityEntry {
  const trimmed = quantityText.trim();
  const parsed = parseIngredient(
    trimmed ? `${trimmed} ${label}`.trim() : label
  );
  return {
    id: createId(),
    quantityText: trimmed || "As listed",
    amountValue: trimmed && parsed.quantityText ? parsed.amountValue : null,
    measureText: parsed.measureText,
    sourceRecipeTitle: "Manual adjustment",
  };
}

function reviveStore(value: unknown): ShoppingListState {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: ShoppingListState = {};
  let fallbackOrder = 0;

  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    if (!entry || typeof entry !== "object") {
      return;
    }

    const record = entry as {
      label?: string;
      entries?: unknown[];
      quantity?: number;
      order?: unknown;
    };

    const resolveOrder = () => {
      if (typeof record.order === "number" && Number.isFinite(record.order)) {
        return record.order;
      }
      const assigned = fallbackOrder;
      fallbackOrder += 1;
      return assigned;
    };

    if (Array.isArray(record.entries)) {
      const hydratedEntries = record.entries
        .map((item) => reviveEntry(item))
        .filter((item): item is QuantityEntry => Boolean(item));
      if (!hydratedEntries.length) return;
      const labelSource =
        typeof record.label === "string" && record.label.length
          ? record.label
          : key;
      const parsedLabel = parseIngredient(labelSource);
      const label = parsedLabel.label || labelSource;
      result[key] = { label, entries: hydratedEntries, order: resolveOrder() };
      return;
    }

    const parsed = parseIngredient(
      typeof record.label === "string" ? record.label : key
    );
    const quantityCount =
      typeof record.quantity === "number" && Number.isFinite(record.quantity)
        ? Math.max(1, Math.round(record.quantity))
        : 1;
    const entriesArray: QuantityEntry[] = Array.from(
      { length: quantityCount },
      () => ({
        id: createId(),
        quantityText: parsed.quantityText || "As listed",
        amountValue: parsed.amountValue,
        measureText: parsed.measureText,
      })
    );
    result[key] = {
      label: parsed.label,
      entries: entriesArray,
      order: resolveOrder(),
    };
  });

  return result;
}

function reviveEntry(value: unknown): QuantityEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as {
    id?: string;
    quantityText?: string;
    amountValue?: number;
    measureText?: string;
    sourceRecipeId?: string;
    sourceRecipeTitle?: string;
  };
  return {
    id: typeof entry.id === "string" ? entry.id : createId(),
    quantityText: entry.quantityText || "",
    amountValue:
      typeof entry.amountValue === "number" ? entry.amountValue : null,
    measureText:
      normalizeMeasureText(entry.measureText || "") || entry.measureText || "",
    sourceRecipeId:
      typeof entry.sourceRecipeId === "string"
        ? entry.sourceRecipeId
        : undefined,
    sourceRecipeTitle:
      typeof entry.sourceRecipeTitle === "string"
        ? entry.sourceRecipeTitle
        : undefined,
  };
}
