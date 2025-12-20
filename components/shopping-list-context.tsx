"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";

import {
  collectSourceTitles,
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
const LOCAL_OWNER_LABEL_STORAGE_KEY = "recipe-organizer-local-list-label";
const REMOTE_LIST_CACHE_KEY = "recipe-organizer-remote-shopping-lists";
const OFFLINE_MUTATION_CACHE_KEY = "recipe-organizer-offline-mutations";

type ShoppingListContextValue = {
  items: ShoppingListItem[];
  lists: ShoppingListListMeta[];
  selectedListId: string | null;
  selectList: (ownerId: string) => void;
  renameList: (ownerId: string, nextLabel: string) => Promise<void>;
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
  externalUpdateNotice: ExternalListUpdateNotice | null;
  acknowledgeExternalUpdate: () => void;
  refreshCollaborativeLists: () => Promise<void>;
  hasLoadedStoredSelection: boolean;
};

type OwnerListState = {
  ownerId: string;
  ownerLabel: string;
  ownerDisplayName: string;
  isSelf: boolean;
  state: ShoppingListState;
};

type ExternalListUpdateNotice = {
  ownerId: string;
  ownerLabel: string;
  isSelf: boolean;
};

type OfflineMutation =
  | {
      kind: "ADD_ITEMS";
      ownerId: string;
      ingredients: IncomingIngredient[];
    }
  | { kind: "REMOVE_ITEM"; ownerId: string; label: string }
  | { kind: "CLEAR_LIST"; ownerId: string }
  | { kind: "REORDER_ITEMS"; ownerId: string; order: string[] }
  | {
      kind: "UPDATE_QUANTITY";
      ownerId: string;
      label: string;
      quantity: string;
    };

export type ShoppingListListMeta = {
  ownerId: string;
  ownerLabel: string;
  ownerDisplayName: string;
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
const REMOTE_SYNC_INTERVAL_MS = 12_000;

export function ShoppingListProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated";
  const currentUserId = session?.user?.id ?? null;
  const derivedSelfDisplayName = useMemo(() => {
    return session?.user?.name?.trim() || session?.user?.email || "You";
  }, [session?.user?.email, session?.user?.name]);
  const derivedSelfLabel = useMemo(() => {
    const customLabel = session?.user?.shoppingListLabel?.trim();
    if (customLabel) {
      return customLabel;
    }
    return session?.user?.name || session?.user?.email || "Your list";
  }, [
    session?.user?.email,
    session?.user?.name,
    session?.user?.shoppingListLabel,
  ]);
  const [selfListLabel, setSelfListLabel] = useState(derivedSelfLabel);
  useEffect(() => {
    setSelfListLabel(derivedSelfLabel);
  }, [derivedSelfLabel]);
  const [localStore, setLocalStore] = useState<ShoppingListState>(() =>
    readStoredState()
  );
  const [localListLabel, setLocalListLabel] = useState(() => {
    if (typeof window === "undefined") {
      return LOCAL_LIST_LABEL;
    }
    const stored = window.localStorage.getItem(LOCAL_OWNER_LABEL_STORAGE_KEY);
    return stored?.trim() || LOCAL_LIST_LABEL;
  });
  const [remoteLists, setRemoteLists] = useState<OwnerListState[]>([]);
  const [isRemote, setIsRemote] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);
  const [hasLoadedStoredSelection, setHasLoadedStoredSelection] =
    useState(false);
  const [isClientOnline, setIsClientOnline] = useState(true);
  const [externalUpdateNotice, setExternalUpdateNotice] =
    useState<ExternalListUpdateNotice | null>(null);
  const listSignatureRef = useRef<Map<string, string>>(new Map());
  const pendingOwnerMutationsRef = useRef<Map<string, number>>(new Map());
  const hasPrimedListSignaturesRef = useRef(false);
  const offlineMutationsRef = useRef<OfflineMutation[]>([]);
  const offlineQueueHydratedRef = useRef(false);

  const commitRemoteLists = useCallback(
    (
      next: OwnerListState[] | ((current: OwnerListState[]) => OwnerListState[])
    ) => {
      setRemoteLists((current) => {
        const resolved =
          typeof next === "function"
            ? (next as (state: OwnerListState[]) => OwnerListState[])(current)
            : next;
        if (resolved !== current && isAuthenticated) {
          persistRemoteListCache(resolved);
        }
        return resolved;
      });
    },
    [isAuthenticated]
  );

  const updateOfflineQueue = useCallback((mutations: OfflineMutation[]) => {
    offlineMutationsRef.current = mutations;
    if (offlineQueueHydratedRef.current) {
      persistOfflineMutationCache(mutations);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || isAuthenticated) {
      return;
    }
    window.localStorage.setItem(LOCAL_OWNER_LABEL_STORAGE_KEY, localListLabel);
  }, [isAuthenticated, localListLabel]);

  const fetchRemoteLists = useCallback(async () => {
    const response = await fetch("/api/shopping-list", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as {
      lists?: {
        ownerId: string;
        ownerLabel: string;
        ownerDisplayName?: string | null;
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
      ownerDisplayName:
        list.ownerDisplayName?.trim() ||
        (list.isSelf ? derivedSelfDisplayName : "Shared list owner"),
      isSelf: list.isSelf,
      state: reviveStore(list.state),
    }));
  }, [derivedSelfDisplayName]);

  const acknowledgeExternalUpdate = useCallback(() => {
    setExternalUpdateNotice(null);
  }, []);

  const evaluateRemoteListChanges = useCallback(
    (lists: OwnerListState[], options?: { prime?: boolean }) => {
      if (!isAuthenticated) {
        listSignatureRef.current.clear();
        pendingOwnerMutationsRef.current.clear();
        hasPrimedListSignaturesRef.current = false;
        setExternalUpdateNotice(null);
        return;
      }
      const prime = options?.prime ?? !hasPrimedListSignaturesRef.current;
      const signatures = listSignatureRef.current;
      const pending = pendingOwnerMutationsRef.current;
      const seen = new Set<string>();

      lists.forEach((list) => {
        seen.add(list.ownerId);
        const signature = serializeListState(list.state);
        const previous = signatures.get(list.ownerId);
        signatures.set(list.ownerId, signature);
        if (prime || !previous || previous === signature) {
          return;
        }
        if (pending.has(list.ownerId)) {
          return;
        }
        setExternalUpdateNotice({
          ownerId: list.ownerId,
          ownerLabel: list.ownerLabel,
          isSelf: list.isSelf,
        });
      });

      Array.from(signatures.keys()).forEach((ownerId) => {
        if (!seen.has(ownerId)) {
          signatures.delete(ownerId);
          pending.delete(ownerId);
        }
      });

      if (prime && lists.length) {
        hasPrimedListSignaturesRef.current = true;
      }
    },
    [isAuthenticated]
  );

  useEffect(() => {
    if (!isAuthenticated) {
      offlineQueueHydratedRef.current = false;
      updateOfflineQueue([]);
      clearOfflineMutationCache();
      clearRemoteListCache();
      return;
    }
    const cachedLists = readRemoteListCache();
    if (cachedLists.length) {
      commitRemoteLists(cachedLists);
      setIsRemote(true);
      evaluateRemoteListChanges(cachedLists, { prime: true });
    }
    const cachedMutations = readOfflineMutationCache();
    updateOfflineQueue(cachedMutations);
    offlineQueueHydratedRef.current = true;
  }, [
    commitRemoteLists,
    evaluateRemoteListChanges,
    isAuthenticated,
    updateOfflineQueue,
  ]);

  const backgroundRefreshRemoteLists = useCallback(
    async (options?: { shouldAbort?: () => boolean }) => {
      if (!isAuthenticated || !isClientOnline) {
        return;
      }
      const shouldAbort = options?.shouldAbort;
      try {
        const lists = await fetchRemoteLists();
        if (shouldAbort?.()) {
          return;
        }
        commitRemoteLists(lists);
        setIsRemote(true);
        evaluateRemoteListChanges(lists);
      } catch (error) {
        if (!shouldAbort?.()) {
          console.error("Failed to refresh shopping lists", error);
        }
      }
    },
    [
      commitRemoteLists,
      evaluateRemoteListChanges,
      fetchRemoteLists,
      isAuthenticated,
      isClientOnline,
    ]
  );

  const refreshCollaborativeLists = useCallback(() => {
    if (!isAuthenticated || !isClientOnline) {
      return Promise.resolve();
    }
    return backgroundRefreshRemoteLists();
  }, [backgroundRefreshRemoteLists, isAuthenticated, isClientOnline]);

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
    if (typeof window === "undefined") {
      setHasLoadedStoredSelection(true);
      return;
    }
    const stored = window.localStorage.getItem(SELECTED_OWNER_STORAGE_KEY);
    if (stored) {
      setSelectedOwnerId(stored);
    } else if (!isAuthenticated) {
      setSelectedOwnerId(LOCAL_OWNER_ID);
    }
    setHasLoadedStoredSelection(true);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      setIsRemote(false);
      commitRemoteLists([]);
      setLocalStore(readStoredState());
      setSelectedOwnerId(LOCAL_OWNER_ID);
      listSignatureRef.current.clear();
      pendingOwnerMutationsRef.current.clear();
      hasPrimedListSignaturesRef.current = false;
      setExternalUpdateNotice(null);
      return;
    }
    if (!isClientOnline) {
      return;
    }

    let cancelled = false;
    setIsSyncing(true);
    fetchRemoteLists()
      .then((lists) => {
        if (cancelled) return;
        commitRemoteLists(lists);
        setIsRemote(true);
        setSelectedOwnerId((current) => {
          if (current && lists.some((list) => list.ownerId === current)) {
            return current;
          }
          if (!hasLoadedStoredSelection) {
            return current;
          }
          return lists[0]?.ownerId ?? currentUserId ?? current;
        });
        evaluateRemoteListChanges(lists, { prime: true });
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
  }, [
    commitRemoteLists,
    currentUserId,
    evaluateRemoteListChanges,
    fetchRemoteLists,
    hasLoadedStoredSelection,
    isAuthenticated,
    isClientOnline,
  ]);

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (cancelled) {
        return;
      }
      void backgroundRefreshRemoteLists({ shouldAbort: () => cancelled });
    };
    tick();
    const intervalId = window.setInterval(tick, REMOTE_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [backgroundRefreshRemoteLists, isAuthenticated, isClientOnline]);

  useEffect(() => {
    if (typeof window === "undefined" || isAuthenticated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(localStore));
  }, [localStore, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      return;
    }
    const handleFocus = () => {
      void backgroundRefreshRemoteLists();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void backgroundRefreshRemoteLists();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [backgroundRefreshRemoteLists, isAuthenticated, isClientOnline]);

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      return;
    }
    const source = new EventSource("/api/live");
    const handleMessage = () => {
      void backgroundRefreshRemoteLists();
    };
    source.onmessage = handleMessage;
    source.onerror = (event) => {
      console.error("Live shopping list updates connection lost", event);
    };
    return () => {
      source.close();
    };
  }, [backgroundRefreshRemoteLists, isAuthenticated, isClientOnline]);

  const runRemoteMutation = useCallback(
    async (action: () => Promise<Response>, ownerScope?: string | null) => {
      if (!isAuthenticated) {
        return {
          success: false,
          error: new Error("You need to sign in to sync this list"),
        } as const;
      }
      if (ownerScope) {
        pendingOwnerMutationsRef.current.set(ownerScope, Date.now());
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
        commitRemoteLists(nextLists);
        setIsRemote(true);
        setSelectedOwnerId((current) => {
          if (current && nextLists.some((list) => list.ownerId === current)) {
            return current;
          }
          return nextLists[0]?.ownerId ?? currentUserId ?? current;
        });
        evaluateRemoteListChanges(nextLists);
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
        if (ownerScope) {
          pendingOwnerMutationsRef.current.delete(ownerScope);
        }
        setIsSyncing(false);
      }
    },
    [
      commitRemoteLists,
      currentUserId,
      evaluateRemoteListChanges,
      fetchRemoteLists,
      isAuthenticated,
    ]
  );

  const queueOfflineMutation = useCallback(
    (mutation: OfflineMutation) => {
      updateOfflineQueue([...offlineMutationsRef.current, mutation]);
    },
    [updateOfflineQueue]
  );

  const applyOwnerStateMutation = useCallback(
    (
      ownerId: string,
      mutator: (state: ShoppingListState) => ShoppingListState
    ) => {
      let didUpdate = false;
      commitRemoteLists((current) => {
        let found = false;
        let nextLists = current;
        for (let index = 0; index < current.length; index += 1) {
          const list = current[index];
          if (list.ownerId !== ownerId) {
            continue;
          }
          found = true;
          const nextState = mutator(list.state);
          if (nextState === list.state) {
            return current;
          }
          didUpdate = true;
          if (nextLists === current) {
            nextLists = [...current];
          }
          nextLists[index] = { ...list, state: nextState };
          return nextLists;
        }
        if (!found) {
          const fallbackState = mutator({});
          if (!Object.keys(fallbackState).length) {
            return current;
          }
          didUpdate = true;
          const ownerLabel =
            ownerId === currentUserId ? selfListLabel : "Shared list";
          return [
            ...current,
            {
              ownerId,
              ownerLabel,
              ownerDisplayName:
                ownerId === currentUserId
                  ? derivedSelfDisplayName
                  : "Shared list owner",
              isSelf: ownerId === currentUserId,
              state: fallbackState,
            },
          ];
        }
        return current;
      });
      return didUpdate;
    },
    [commitRemoteLists, currentUserId, derivedSelfDisplayName, selfListLabel]
  );

  const executeOfflineMutation = useCallback(
    (mutation: OfflineMutation) => {
      switch (mutation.kind) {
        case "ADD_ITEMS":
          return runRemoteMutation(
            () =>
              fetch("/api/shopping-list", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ingredients: mutation.ingredients,
                  ownerId: mutation.ownerId,
                }),
              }),
            mutation.ownerId
          );
        case "REMOVE_ITEM": {
          const params = new URLSearchParams({
            label: mutation.label,
            ownerId: mutation.ownerId,
          });
          return runRemoteMutation(
            () =>
              fetch(`/api/shopping-list?${params.toString()}`, {
                method: "DELETE",
              }),
            mutation.ownerId
          );
        }
        case "CLEAR_LIST": {
          const params = new URLSearchParams({ ownerId: mutation.ownerId });
          return runRemoteMutation(
            () =>
              fetch(`/api/shopping-list?${params.toString()}`, {
                method: "DELETE",
              }),
            mutation.ownerId
          );
        }
        case "REORDER_ITEMS":
          return runRemoteMutation(
            () =>
              fetch("/api/shopping-list", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  order: mutation.order,
                  ownerId: mutation.ownerId,
                }),
              }),
            mutation.ownerId
          );
        case "UPDATE_QUANTITY":
          return runRemoteMutation(
            () =>
              fetch("/api/shopping-list", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ownerId: mutation.ownerId,
                  label: mutation.label,
                  quantity: mutation.quantity,
                }),
              }),
            mutation.ownerId
          );
        default:
          return Promise.resolve({ success: true } as const);
      }
    },
    [runRemoteMutation]
  );

  const flushOfflineMutations = useCallback(async () => {
    if (!offlineMutationsRef.current.length) {
      return;
    }
    const pending = [...offlineMutationsRef.current];
    updateOfflineQueue([]);
    for (let index = 0; index < pending.length; index += 1) {
      const mutation = pending[index];
      const result = await executeOfflineMutation(mutation);
      if (!result?.success) {
        updateOfflineQueue(pending.slice(index));
        return;
      }
    }
    await backgroundRefreshRemoteLists();
  }, [
    backgroundRefreshRemoteLists,
    executeOfflineMutation,
    updateOfflineQueue,
  ]);

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      return;
    }
    void flushOfflineMutations();
  }, [flushOfflineMutations, isAuthenticated, isClientOnline]);

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
        setLocalStore((current) => addIngredientsToState(current, ingredients));
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) {
        console.warn("No shopping list owner available for new items");
        return;
      }

      if (!isClientOnline) {
        const didUpdate = applyOwnerStateMutation(targetOwnerId, (state) =>
          addIngredientsToState(state, ingredients)
        );
        if (didUpdate) {
          queueOfflineMutation({
            kind: "ADD_ITEMS",
            ownerId: targetOwnerId,
            ingredients,
          });
        }
        return;
      }

      void runRemoteMutation(
        () =>
          fetch("/api/shopping-list", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ingredients, ownerId: targetOwnerId }),
          }),
        targetOwnerId
      );
    },
    [
      applyOwnerStateMutation,
      isAuthenticated,
      isClientOnline,
      queueOfflineMutation,
      resolveOwnerId,
      runRemoteMutation,
    ]
  );

  const removeItem = useCallback(
    (key: string, ownerOverride?: string) => {
      if (!key) return;
      if (!isAuthenticated) {
        setLocalStore((current) => removeItemFromState(current, key));
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) return;

      if (!isClientOnline) {
        const didUpdate = applyOwnerStateMutation(targetOwnerId, (state) =>
          removeItemFromState(state, key)
        );
        if (didUpdate) {
          queueOfflineMutation({
            kind: "REMOVE_ITEM",
            ownerId: targetOwnerId,
            label: key,
          });
        }
        return;
      }
      const params = new URLSearchParams({
        label: key,
        ownerId: targetOwnerId,
      });
      void runRemoteMutation(
        () =>
          fetch(`/api/shopping-list?${params.toString()}`, {
            method: "DELETE",
          }),
        targetOwnerId
      );
    },
    [
      applyOwnerStateMutation,
      isAuthenticated,
      isClientOnline,
      queueOfflineMutation,
      resolveOwnerId,
      runRemoteMutation,
    ]
  );

  const clearList = useCallback(
    (ownerOverride?: string) => {
      if (!isAuthenticated) {
        setLocalStore((current) => clearListState(current));
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) return;

      if (!isClientOnline) {
        const didUpdate = applyOwnerStateMutation(targetOwnerId, (state) =>
          clearListState(state)
        );
        if (didUpdate) {
          queueOfflineMutation({
            kind: "CLEAR_LIST",
            ownerId: targetOwnerId,
          });
        }
        return;
      }
      const params = new URLSearchParams({ ownerId: targetOwnerId });
      void runRemoteMutation(
        () =>
          fetch(`/api/shopping-list?${params.toString()}`, {
            method: "DELETE",
          }),
        targetOwnerId
      );
    },
    [
      applyOwnerStateMutation,
      isAuthenticated,
      isClientOnline,
      queueOfflineMutation,
      resolveOwnerId,
      runRemoteMutation,
    ]
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

      if (!isClientOnline) {
        const didUpdate = applyOwnerStateMutation(targetOwnerId, (state) =>
          reorderState(state, orderedKeys)
        );
        if (didUpdate) {
          queueOfflineMutation({
            kind: "REORDER_ITEMS",
            ownerId: targetOwnerId,
            order: orderedKeys,
          });
        }
        return;
      }

      const targetList = remoteLists.find(
        (list) => list.ownerId === targetOwnerId
      );
      if (targetList) {
        const updatedState = reorderState(targetList.state, orderedKeys);
        if (updatedState === targetList.state) {
          return;
        }
      }

      commitRemoteLists((current) => {
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

      void runRemoteMutation(
        () =>
          fetch("/api/shopping-list", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              order: orderedKeys,
              ownerId: targetOwnerId,
            }),
          }),
        targetOwnerId
      );
    },
    [
      applyOwnerStateMutation,
      commitRemoteLists,
      isAuthenticated,
      isClientOnline,
      queueOfflineMutation,
      remoteLists,
      resolveOwnerId,
      runRemoteMutation,
    ]
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

      if (!isClientOnline) {
        const didUpdate = applyOwnerStateMutation(targetOwnerId, (state) =>
          applyQuantityOverrideToState(state, key, quantityText)
        );
        if (didUpdate) {
          queueOfflineMutation({
            kind: "UPDATE_QUANTITY",
            ownerId: targetOwnerId,
            label: key,
            quantity: quantityText,
          });
        }
        return;
      }

      const previousLists = remoteLists;
      commitRemoteLists((current) =>
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

      const result = await runRemoteMutation(
        () =>
          fetch("/api/shopping-list", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ownerId: targetOwnerId,
              label: key,
              quantity: quantityText,
            }),
          }),
        targetOwnerId
      );

      if (!result.success) {
        commitRemoteLists(previousLists);
        throw result.error;
      }
    },
    [
      applyOwnerStateMutation,
      commitRemoteLists,
      isAuthenticated,
      isClientOnline,
      queueOfflineMutation,
      remoteLists,
      resolveOwnerId,
      runRemoteMutation,
    ]
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
            ownerLabel: selfListLabel,
            ownerDisplayName: derivedSelfDisplayName,
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
        ownerLabel: localListLabel,
        ownerDisplayName: derivedSelfDisplayName,
        isSelf: true,
        state: localStore,
      },
    ];
  }, [
    currentUserId,
    isAuthenticated,
    isRemote,
    derivedSelfDisplayName,
    localListLabel,
    localStore,
    remoteLists,
    selfListLabel,
  ]);

  useEffect(() => {
    if (!resolvedLists.length) return;
    setSelectedOwnerId((current) => {
      if (current && resolvedLists.some((list) => list.ownerId === current)) {
        return current;
      }
      if (!hasLoadedStoredSelection) {
        return current;
      }
      return resolvedLists[0].ownerId;
    });
  }, [resolvedLists, hasLoadedStoredSelection]);

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
      ownerDisplayName: list.ownerDisplayName,
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
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SELECTED_OWNER_STORAGE_KEY, ownerId);
    }
  }, []);

  const renameList = useCallback(
    async (ownerId: string, nextLabel: string) => {
      const trimmed = nextLabel.trim();
      if (!trimmed) {
        throw new Error("List name cannot be empty.");
      }

      if (!isAuthenticated) {
        if (ownerId !== LOCAL_OWNER_ID) {
          throw new Error("You can only rename lists you own.");
        }
        setLocalListLabel(trimmed);
        return;
      }

      if (!currentUserId || ownerId !== currentUserId) {
        throw new Error("You can only rename lists you own.");
      }

      if (!isClientOnline) {
        throw new Error("Reconnect to rename your synced list.");
      }

      const response = await fetch("/api/shopping-list/label", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: trimmed }),
      });
      const payload = (await response.json().catch(() => null)) as {
        label?: string;
        error?: string;
      } | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Unable to rename list.");
      }

      const resolvedLabel = payload?.label?.trim() || trimmed;
      setSelfListLabel(resolvedLabel);
      commitRemoteLists((current) =>
        current.map((list) =>
          list.ownerId === ownerId
            ? { ...list, ownerLabel: resolvedLabel }
            : list
        )
      );
      setExternalUpdateNotice((notice) =>
        notice && notice.ownerId === ownerId
          ? { ...notice, ownerLabel: resolvedLabel }
          : notice
      );
    },
    [
      commitRemoteLists,
      currentUserId,
      isAuthenticated,
      isClientOnline,
      setExternalUpdateNotice,
      setLocalListLabel,
      setSelfListLabel,
    ]
  );

  const activeListId = activeList?.ownerId ?? selectedOwnerId ?? null;

  const value = useMemo(
    () => ({
      items,
      lists: listsMeta,
      selectedListId: activeListId,
      selectList,
      renameList,
      addItems,
      removeItem,
      clearList,
      reorderItems,
      updateQuantity: updateItemQuantity,
      totalItems,
      isSyncing,
      isRemote,
      externalUpdateNotice,
      acknowledgeExternalUpdate,
      refreshCollaborativeLists,
      hasLoadedStoredSelection,
    }),
    [
      items,
      listsMeta,
      activeListId,
      selectList,
      renameList,
      addItems,
      removeItem,
      clearList,
      reorderItems,
      updateItemQuantity,
      totalItems,
      isSyncing,
      isRemote,
      externalUpdateNotice,
      acknowledgeExternalUpdate,
      refreshCollaborativeLists,
      hasLoadedStoredSelection,
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

function addIngredientsToState(
  state: ShoppingListState,
  ingredients: IncomingIngredient[]
): ShoppingListState {
  if (!ingredients.length) {
    return state;
  }
  const next = { ...state };
  let orderCursor = getNextOrderValue(next);
  let updated = false;
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
    updated = true;
  });
  return updated ? next : state;
}

function removeItemFromState(
  state: ShoppingListState,
  key: string
): ShoppingListState {
  if (!state[key]) {
    return state;
  }
  const next = { ...state };
  delete next[key];
  return next;
}

function clearListState(state: ShoppingListState): ShoppingListState {
  if (!Object.keys(state).length) {
    return state;
  }
  return {};
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
      sources: collectSourceTitles(record.entries),
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

function serializeListState(state: ShoppingListState) {
  const payload = Object.entries(state)
    .map(([key, record]) => ({
      key,
      order: record.order ?? 0,
      entries: record.entries.map((entry) => ({
        quantityText: entry.quantityText,
        amountValue: entry.amountValue ?? null,
        measureText: entry.measureText ?? "",
        sourceRecipeId: entry.sourceRecipeId ?? null,
        sourceRecipeTitle: entry.sourceRecipeTitle ?? null,
      })),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return JSON.stringify(payload);
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
  const manualEntry = buildManualQuantityEntry(
    record.label,
    quantityText,
    collectSourceTitles(record.entries)
  );
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
  quantityText: string,
  sourceTitles?: string[]
): QuantityEntry {
  const trimmed = quantityText.trim();
  const parsed = parseIngredient(
    trimmed ? `${trimmed} ${label}`.trim() : label
  );
  const manualSourceTitle =
    sourceTitles && sourceTitles.length
      ? sourceTitles.join(" · ")
      : "Manual adjustment";
  return {
    id: createId(),
    quantityText: trimmed || "As listed",
    amountValue: trimmed && parsed.quantityText ? parsed.amountValue : null,
    measureText: parsed.measureText,
    sourceRecipeTitle: manualSourceTitle,
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

function readRemoteListCache(): OwnerListState[] {
  if (typeof window === "undefined") {
    return [];
  }
  const raw = window.localStorage.getItem(REMOTE_LIST_CACHE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => hydrateCachedOwnerList(entry))
      .filter((entry): entry is OwnerListState => Boolean(entry));
  } catch (error) {
    console.warn("Failed to parse cached shopping lists", error);
    return [];
  }
}

function hydrateCachedOwnerList(value: unknown): OwnerListState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as {
    ownerId?: unknown;
    ownerLabel?: unknown;
    ownerDisplayName?: unknown;
    isSelf?: unknown;
    state?: unknown;
  };
  const ownerId =
    typeof record.ownerId === "string" && record.ownerId.trim().length
      ? record.ownerId
      : null;
  if (!ownerId) {
    return null;
  }
  const ownerLabel =
    typeof record.ownerLabel === "string" && record.ownerLabel.trim().length
      ? record.ownerLabel
      : "Shared list";
  const ownerDisplayName =
    typeof record.ownerDisplayName === "string" &&
    record.ownerDisplayName.trim().length
      ? record.ownerDisplayName
      : ownerLabel;
  const revivedState = reviveStore(record.state);
  return {
    ownerId,
    ownerLabel,
    ownerDisplayName,
    isSelf: record.isSelf === true,
    state: revivedState,
  };
}

function persistRemoteListCache(lists: OwnerListState[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!lists.length) {
      window.localStorage.removeItem(REMOTE_LIST_CACHE_KEY);
      return;
    }
    const payload = lists.map((list) => ({
      ownerId: list.ownerId,
      ownerLabel: list.ownerLabel,
      ownerDisplayName: list.ownerDisplayName,
      isSelf: list.isSelf,
      state: list.state,
    }));
    window.localStorage.setItem(REMOTE_LIST_CACHE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to cache shopping lists", error);
  }
}

function clearRemoteListCache() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(REMOTE_LIST_CACHE_KEY);
}

function readOfflineMutationCache(): OfflineMutation[] {
  if (typeof window === "undefined") {
    return [];
  }
  const raw = window.localStorage.getItem(OFFLINE_MUTATION_CACHE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => hydrateOfflineMutation(entry))
      .filter((entry): entry is OfflineMutation => Boolean(entry));
  } catch (error) {
    console.warn("Failed to parse offline shopping list queue", error);
    return [];
  }
}

function hydrateOfflineMutation(value: unknown): OfflineMutation | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind =
    typeof record.kind === "string" && record.kind.length ? record.kind : null;
  if (!kind) {
    return null;
  }
  const ownerId =
    typeof record.ownerId === "string" && record.ownerId.trim().length
      ? record.ownerId
      : null;
  if (!ownerId) {
    return null;
  }
  switch (kind) {
    case "ADD_ITEMS": {
      if (!Array.isArray(record.ingredients)) {
        return null;
      }
      const ingredients = record.ingredients
        .map((entry) => hydrateOfflineIngredient(entry))
        .filter((entry): entry is IncomingIngredient => Boolean(entry));
      if (!ingredients.length) {
        return null;
      }
      return { kind: "ADD_ITEMS", ownerId, ingredients };
    }
    case "REMOVE_ITEM": {
      const label =
        typeof record.label === "string" && record.label.length
          ? record.label
          : null;
      if (!label) {
        return null;
      }
      return { kind: "REMOVE_ITEM", ownerId, label };
    }
    case "CLEAR_LIST":
      return { kind: "CLEAR_LIST", ownerId };
    case "REORDER_ITEMS": {
      if (!Array.isArray(record.order)) {
        return null;
      }
      const order = record.order
        .map((entry) => (typeof entry === "string" ? entry : null))
        .filter((entry): entry is string => Boolean(entry));
      if (!order.length) {
        return null;
      }
      return { kind: "REORDER_ITEMS", ownerId, order };
    }
    case "UPDATE_QUANTITY": {
      const label =
        typeof record.label === "string" && record.label.length
          ? record.label
          : null;
      const quantity =
        typeof record.quantity === "string" ? record.quantity : null;
      if (!label || quantity === null) {
        return null;
      }
      return { kind: "UPDATE_QUANTITY", ownerId, label, quantity };
    }
    default:
      return null;
  }
}

function hydrateOfflineIngredient(value: unknown): IncomingIngredient | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as {
    value?: unknown;
    recipeId?: unknown;
    recipeTitle?: unknown;
  };
  const normalizedValue =
    typeof record.value === "string" && record.value.trim().length
      ? record.value
      : null;
  if (!normalizedValue) {
    return null;
  }
  const ingredient: IncomingIngredient = {
    value: normalizedValue,
  };
  if (typeof record.recipeId === "string" && record.recipeId.length) {
    ingredient.recipeId = record.recipeId;
  }
  if (typeof record.recipeTitle === "string" && record.recipeTitle.length) {
    ingredient.recipeTitle = record.recipeTitle;
  }
  return ingredient;
}

function persistOfflineMutationCache(mutations: OfflineMutation[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!mutations.length) {
      window.localStorage.removeItem(OFFLINE_MUTATION_CACHE_KEY);
      return;
    }
    window.localStorage.setItem(
      OFFLINE_MUTATION_CACHE_KEY,
      JSON.stringify(mutations)
    );
  } catch (error) {
    console.warn("Failed to cache offline shopping list changes", error);
  }
}

function clearOfflineMutationCache() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(OFFLINE_MUTATION_CACHE_KEY);
}
