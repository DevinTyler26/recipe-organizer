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

type ShoppingListContextValue = {
  items: ShoppingListItem[];
  addItems: (items: IncomingIngredient[]) => void;
  removeItem: (key: string) => void;
  clearList: () => void;
  reorderItems: (keys: string[]) => void;
  totalItems: number;
  isSyncing: boolean;
  isRemote: boolean;
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

export function ShoppingListProvider({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";
  const [store, setStore] = useState<ShoppingListState>(() =>
    readStoredState()
  );
  const [isRemote, setIsRemote] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const fetchRemoteState = useCallback(async () => {
    const response = await fetch("/api/shopping-list", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as {
      state?: ShoppingListState;
      error?: string;
    } | null;
    if (!response.ok || !body?.state) {
      throw new Error(body?.error ?? "Failed to load shopping list");
    }
    return reviveStore(body.state);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setIsRemote(false);
      setStore(readStoredState());
      return;
    }

    let cancelled = false;
    setIsSyncing(true);
    fetchRemoteState()
      .then((state) => {
        if (!cancelled) {
          setStore(state);
          setIsRemote(true);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to fetch shopping list", error);
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
  }, [isAuthenticated, fetchRemoteState]);

  useEffect(() => {
    if (typeof window === "undefined" || isRemote) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }, [store, isRemote]);

  const runRemoteMutation = useCallback(
    async (action: () => Promise<Response>) => {
      setIsSyncing(true);
      try {
        const response = await action();
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "Shopping list request failed");
        }
        const nextState = await fetchRemoteState();
        setStore(nextState);
        setIsRemote(true);
      } catch (error) {
        console.error("Shopping list sync failed", error);
      } finally {
        setIsSyncing(false);
      }
    },
    [fetchRemoteState]
  );

  const addItems = useCallback(
    (ingredients: IncomingIngredient[]) => {
      if (!ingredients.length) return;
      if (!isAuthenticated) {
        setStore((current) => {
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

      void runRemoteMutation(() =>
        fetch("/api/shopping-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ingredients }),
        })
      );
    },
    [isAuthenticated, runRemoteMutation]
  );

  const removeItem = useCallback(
    (key: string) => {
      if (!key) return;
      if (!isAuthenticated) {
        setStore((current) => {
          if (!current[key]) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
        return;
      }

      const url = `/api/shopping-list?label=${encodeURIComponent(key)}`;
      void runRemoteMutation(() => fetch(url, { method: "DELETE" }));
    },
    [isAuthenticated, runRemoteMutation]
  );

  const clearList = useCallback(() => {
    if (!isAuthenticated) {
      setStore({});
      return;
    }
    void runRemoteMutation(() =>
      fetch("/api/shopping-list", { method: "DELETE" })
    );
  }, [isAuthenticated, runRemoteMutation]);

  const reorderItems = useCallback(
    (orderedKeys: string[]) => {
      if (!orderedKeys.length) return;
      let didChange = false;
      setStore((current) => {
        const nextOrderSequence = (() => {
          const provided = orderedKeys.filter((key) => current[key]);
          const providedSet = new Set(provided);
          const missing = Object.keys(current).filter(
            (key) => !providedSet.has(key)
          );
          return [...provided, ...missing];
        })();

        if (nextOrderSequence.length === 0) {
          return current;
        }

        const next = { ...current } as ShoppingListState;
        let updated = false;
        nextOrderSequence.forEach((key, index) => {
          const record = current[key];
          if (!record) return;
          if (record.order !== index) {
            next[key] = { ...record, order: index };
            updated = true;
          }
        });
        if (updated) {
          didChange = true;
        }
        return updated ? next : current;
      });

      if (isAuthenticated && didChange) {
        void runRemoteMutation(() =>
          fetch("/api/shopping-list", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: orderedKeys }),
          })
        );
      }
    },
    [isAuthenticated, runRemoteMutation]
  );

  const items = useMemo(() => {
    return Object.entries(store)
      .map(([key, record]) => ({
        key,
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
      }))
      .sort((a, b) => {
        if (a.order !== b.order) {
          return a.order - b.order;
        }
        return a.label.localeCompare(b.label);
      });
  }, [store]);

  const totalItems = useMemo(
    () => items.reduce((sum, entry) => sum + entry.occurrences, 0),
    [items]
  );

  const value = useMemo(
    () => ({
      items,
      addItems,
      removeItem,
      clearList,
      reorderItems,
      totalItems,
      isSyncing,
      isRemote,
    }),
    [
      items,
      addItems,
      removeItem,
      clearList,
      reorderItems,
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
