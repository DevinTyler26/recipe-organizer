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
const SHOPPING_LIST_QUEUE_MESSAGE = "SHOPPING_LIST_QUEUE_UPDATE";
const SHOPPING_LIST_SYNC_COMPLETE_MESSAGE = "SHOPPING_LIST_SYNC_COMPLETED";
const SHOPPING_LIST_SYNC_TAG = "shopping-list-offline-sync";
const SHOPPING_LIST_QUEUE_CACHE_NAME = "shopping-list-offline-queue";
const SHOPPING_LIST_QUEUE_REQUEST_URL = "/__shopping-list-offline-queue";

const getSelectedOwnerStorageKey = (userId: string | null) =>
  `${SELECTED_OWNER_STORAGE_KEY}:${userId ?? "guest"}`;

type ShoppingListContextValue = {
  items: ShoppingListItem[];
  lists: ShoppingListListMeta[];
  selectedListId: string | null;
  selectList: (ownerId: string) => void;
  renameList: (ownerId: string, nextLabel: string) => Promise<void>;
  addItems: (
    items: IncomingIngredient[],
    ownerId?: string,
    options?: { position?: "start" | "end" }
  ) => void;
  removeItem: (key: string, ownerId?: string) => void;
  clearList: (ownerId?: string) => void;
  reorderItems: (keys: string[], ownerId?: string) => void;
  setCrossedOff: (key: string, crossed: boolean, ownerId?: string) => void;
  getEntriesForItem: (key: string, ownerId?: string) => QuantityEntry[] | null;
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
      position?: "start" | "end";
    }
  | { kind: "REMOVE_ITEM"; ownerId: string; label: string }
  | { kind: "CLEAR_LIST"; ownerId: string }
  | { kind: "REORDER_ITEMS"; ownerId: string; order: string[] }
  | {
      kind: "UPDATE_QUANTITY";
      ownerId: string;
      label: string;
      quantity: string;
    }
  | {
      kind: "SET_CROSSED_OFF";
      ownerId: string;
      label: string;
      crossedOffAt: number | null;
    };

type RemoteMutationResult =
  | { success: true }
  | { success: false; error: Error };

type DeferredRemoteMutation = {
  operation: OfflineMutation;
  ownerScope?: string | null;
  resolve: (result: RemoteMutationResult) => void;
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

const getLowestOrderValue = (state: ShoppingListState) => {
  const orders = Object.values(state).map((record) => record.order ?? 0);
  return orders.length ? Math.min(...orders) : null;
};

const LOCAL_OWNER_ID = "local";
const LOCAL_LIST_LABEL = "This device";
const REMOTE_SYNC_INTERVAL_MS = 12_000;
const MUTATION_NOTICE_GRACE_MS = 10_000;
const COLLAB_UPDATE_DELAY_MS = 5_000;
const COLLAB_UPDATE_JITTER_MS = 2_000;
const MIN_DEFERRED_MUTATION_DELAY_MS = 7_000;
const MAX_DEFERRED_MUTATION_DELAY_MS = 9_000;

const getDeferredMutationDelay = () =>
  MIN_DEFERRED_MUTATION_DELAY_MS +
  Math.floor(
    Math.random() *
      (MAX_DEFERRED_MUTATION_DELAY_MS - MIN_DEFERRED_MUTATION_DELAY_MS)
  );

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
  const remoteListsRef = useRef<OwnerListState[]>([]);
  const [isRemote, setIsRemote] = useState(false);
  const [hasSyncedRemoteLists, setHasSyncedRemoteLists] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);
  const [hasLoadedStoredSelection, setHasLoadedStoredSelection] =
    useState(false);
  const [isClientOnline, setIsClientOnline] = useState(true);
  const [externalUpdateNotice, setExternalUpdateNotice] =
    useState<ExternalListUpdateNotice | null>(null);
  const listSignatureRef = useRef<Map<string, string>>(new Map());
  const pendingOwnerMutationsRef = useRef<Map<string, number>>(new Map());
  const recentMutationRef = useRef<Map<string, number>>(new Map());
  const deferredMutationsRef = useRef<DeferredRemoteMutation[]>([]);
  const deferredFlushTimerRef = useRef<number | null>(null);
  const hasPrimedListSignaturesRef = useRef(false);
  const offlineMutationsRef = useRef<OfflineMutation[]>([]);
  const offlineQueueHydratedRef = useRef(false);
  const remoteRefreshTimerRef = useRef<number | null>(null);
  const remoteRefreshAbortRef = useRef<(() => boolean) | null>(null);
  const persistedOwnerIdRef = useRef<string | null>(null);

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

  useEffect(() => {
    remoteListsRef.current = remoteLists;
  }, [remoteLists]);

  const syncOfflineQueueWithWorker = useCallback(
    async (mutations: OfflineMutation[]) => {
      if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
        return;
      }
      try {
        const registration = await navigator.serviceWorker.ready;
        registration.active?.postMessage({
          type: SHOPPING_LIST_QUEUE_MESSAGE,
          payload: { mutations },
        });
        if (mutations.length) {
          const syncManager = (
            registration as ServiceWorkerRegistration & {
              sync?: { register: (tag: string) => Promise<void> };
            }
          ).sync;
          if (syncManager) {
            try {
              await syncManager.register(SHOPPING_LIST_SYNC_TAG);
            } catch (error) {
              console.warn(
                "Shopping list background sync registration failed",
                error
              );
            }
          }
        }
      } catch (error) {
        console.warn("Shopping list service worker unavailable", error);
      }
    },
    []
  );

  const updateOfflineQueue = useCallback(
    (mutations: OfflineMutation[]) => {
      offlineMutationsRef.current = mutations;
      if (offlineQueueHydratedRef.current) {
        persistOfflineMutationCache(mutations);
      }
      void syncOfflineQueueWithWorker(mutations);
    },
    [syncOfflineQueueWithWorker]
  );

  const reconcileOfflineQueueWithWorker = useCallback(async () => {
    if (typeof window === "undefined" || !("caches" in window)) {
      return;
    }
    try {
      const cache = await window.caches.open(SHOPPING_LIST_QUEUE_CACHE_NAME);
      const snapshot = await cache.match(SHOPPING_LIST_QUEUE_REQUEST_URL);
      if (!snapshot && offlineMutationsRef.current.length) {
        updateOfflineQueue([]);
      }
    } catch (error) {
      console.warn("Failed to reconcile offline shopping list queue", error);
    }
  }, [updateOfflineQueue]);

  const mergeFetchedRemoteLists = useCallback(
    (fetchedLists: OwnerListState[], fetchedAt: number) => {
      const current = remoteListsRef.current;
      if (!current.length) {
        return fetchedLists;
      }
      const currentLookup = new Map(
        current.map((list) => [list.ownerId, list])
      );
      let changed = false;
      const merged = fetchedLists.map((list) => {
        const lastMutation = recentMutationRef.current.get(list.ownerId);
        if (lastMutation && lastMutation > fetchedAt) {
          const preserved = currentLookup.get(list.ownerId);
          if (preserved) {
            changed = true;
            return preserved;
          }
        }
        const previous = currentLookup.get(list.ownerId);
        if (!previous || previous.state !== list.state) {
          changed = true;
        }
        return list;
      });
      if (merged.length !== current.length) {
        changed = true;
      }
      return changed ? merged : current;
    },
    [recentMutationRef, remoteListsRef]
  );

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

  const recordRecentMutation = useCallback((ownerId?: string | null) => {
    if (!ownerId) {
      return;
    }
    recentMutationRef.current.set(ownerId, Date.now());
  }, []);

  const hasRecentMutation = useCallback((ownerId: string) => {
    const timestamp = recentMutationRef.current.get(ownerId);
    if (!timestamp) {
      return false;
    }
    if (Date.now() - timestamp > MUTATION_NOTICE_GRACE_MS) {
      recentMutationRef.current.delete(ownerId);
      return false;
    }
    return true;
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
        if (pending.has(list.ownerId) || hasRecentMutation(list.ownerId)) {
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
    [hasRecentMutation, isAuthenticated]
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
    void reconcileOfflineQueueWithWorker();
  }, [
    commitRemoteLists,
    evaluateRemoteListChanges,
    isAuthenticated,
    reconcileOfflineQueueWithWorker,
    updateOfflineQueue,
  ]);

  const backgroundRefreshRemoteLists = useCallback(
    async (options?: { shouldAbort?: () => boolean }) => {
      if (
        !isAuthenticated ||
        !isClientOnline ||
        pendingOwnerMutationsRef.current.size > 0
      ) {
        // Avoid clobbering optimistic changes while a mutation is in flight.
        return;
      }
      const shouldAbort = options?.shouldAbort;
      try {
        const fetchStartedAt = Date.now();
        const lists = await fetchRemoteLists();
        if (shouldAbort?.()) {
          return;
        }
        const merged = mergeFetchedRemoteLists(lists, fetchStartedAt);
        commitRemoteLists(merged);
        setIsRemote(true);
        setHasSyncedRemoteLists(true);
        const preferred = persistedOwnerIdRef.current;
        if (
          preferred &&
          merged.some((list) => list.ownerId === preferred) &&
          selectedOwnerId !== preferred
        ) {
          setSelectedOwnerId(preferred);
        }
        evaluateRemoteListChanges(merged);
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
      mergeFetchedRemoteLists,
      isAuthenticated,
      isClientOnline,
      selectedOwnerId,
    ]
  );

  const clearScheduledRemoteRefresh = useCallback(() => {
    if (
      remoteRefreshTimerRef.current !== null &&
      typeof window !== "undefined"
    ) {
      window.clearTimeout(remoteRefreshTimerRef.current);
    }
    remoteRefreshTimerRef.current = null;
    remoteRefreshAbortRef.current = null;
  }, []);

  const scheduleRemoteRefresh = useCallback(
    (options?: { immediate?: boolean; shouldAbort?: () => boolean }) => {
      if (!isAuthenticated || !isClientOnline) {
        return;
      }
      if (typeof window === "undefined" || options?.immediate) {
        if (options?.shouldAbort && options.shouldAbort()) {
          return;
        }
        clearScheduledRemoteRefresh();
        void backgroundRefreshRemoteLists();
        return;
      }
      if (remoteRefreshTimerRef.current !== null) {
        remoteRefreshAbortRef.current = options?.shouldAbort ?? null;
        return;
      }
      const jitterRange = Math.min(
        COLLAB_UPDATE_JITTER_MS,
        COLLAB_UPDATE_DELAY_MS
      );
      const jitter = jitterRange
        ? Math.round((Math.random() * 2 - 1) * jitterRange)
        : 0;
      const delay = Math.max(1_000, COLLAB_UPDATE_DELAY_MS + jitter);
      remoteRefreshAbortRef.current = options?.shouldAbort ?? null;
      remoteRefreshTimerRef.current = window.setTimeout(() => {
        remoteRefreshTimerRef.current = null;
        const shouldAbort = remoteRefreshAbortRef.current;
        remoteRefreshAbortRef.current = null;
        if (shouldAbort?.()) {
          return;
        }
        void backgroundRefreshRemoteLists();
      }, delay);
    },
    [
      backgroundRefreshRemoteLists,
      clearScheduledRemoteRefresh,
      isAuthenticated,
      isClientOnline,
    ]
  );

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      clearScheduledRemoteRefresh();
    }
    return () => {
      clearScheduledRemoteRefresh();
    };
  }, [clearScheduledRemoteRefresh, isAuthenticated, isClientOnline]);

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
    const storageKey = getSelectedOwnerStorageKey(
      isAuthenticated ? currentUserId : null
    );
    const stored = window.localStorage.getItem(storageKey);
    if (stored) {
      setSelectedOwnerId(stored);
      persistedOwnerIdRef.current = stored;
    } else if (!isAuthenticated) {
      setSelectedOwnerId(LOCAL_OWNER_ID);
      persistedOwnerIdRef.current = LOCAL_OWNER_ID;
    }
    setHasLoadedStoredSelection(true);
  }, [currentUserId, isAuthenticated]);

  useEffect(() => {
    if (status === "loading") {
      return;
    }
    if (!isAuthenticated) {
      setIsRemote(false);
      setHasSyncedRemoteLists(false);
      commitRemoteLists([]);
      setLocalStore(readStoredState());
      setSelectedOwnerId(LOCAL_OWNER_ID);
      persistedOwnerIdRef.current = LOCAL_OWNER_ID;
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
    const fetchStartedAt = Date.now();
    fetchRemoteLists()
      .then((lists) => {
        if (cancelled) return;
        const merged = mergeFetchedRemoteLists(lists, fetchStartedAt);
        commitRemoteLists(merged);
        setIsRemote(true);
        setHasSyncedRemoteLists(true);
        setSelectedOwnerId((current) => {
          if (current && merged.some((list) => list.ownerId === current)) {
            return current;
          }
          if (!hasLoadedStoredSelection) {
            return current;
          }
          const preferred = persistedOwnerIdRef.current;
          if (preferred && merged.some((list) => list.ownerId === preferred)) {
            return preferred;
          }
          return merged[0]?.ownerId ?? currentUserId ?? current;
        });
        evaluateRemoteListChanges(merged, { prime: true });
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
    mergeFetchedRemoteLists,
    hasLoadedStoredSelection,
    isAuthenticated,
    isClientOnline,
    status,
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
      scheduleRemoteRefresh({ shouldAbort: () => cancelled });
    };
    tick();
    const intervalId = window.setInterval(tick, REMOTE_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isAuthenticated, isClientOnline, scheduleRemoteRefresh]);

  useEffect(() => {
    if (typeof window === "undefined" || isAuthenticated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(localStore));
  }, [localStore, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      return;
    }
    const handleFocus = () => {
      scheduleRemoteRefresh();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        scheduleRemoteRefresh();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [isAuthenticated, isClientOnline, scheduleRemoteRefresh]);

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      return;
    }
    const source = new EventSource("/api/live");
    const handleMessage = () => {
      scheduleRemoteRefresh();
    };
    source.onmessage = handleMessage;
    source.onerror = (event) => {
      console.error("Live shopping list updates connection lost", event);
    };
    return () => {
      source.close();
    };
  }, [isAuthenticated, isClientOnline, scheduleRemoteRefresh]);

  const dispatchRemoteMutationBatch = useCallback(
    async (
      operations: OfflineMutation[],
      ownerScopes: string[]
    ): Promise<RemoteMutationResult> => {
      if (!operations.length) {
        return { success: true } as const;
      }
      if (!isAuthenticated) {
        return {
          success: false,
          error: new Error("You need to sign in to sync this list"),
        } as const;
      }
      setIsSyncing(true);
      try {
        const response = await fetch("/api/shopping-list/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operations }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "Shopping list request failed");
        }
        scheduleRemoteRefresh();
        ownerScopes.forEach((ownerId) => recordRecentMutation(ownerId));
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
        ownerScopes.forEach((ownerId) => {
          pendingOwnerMutationsRef.current.delete(ownerId);
        });
        setIsSyncing(false);
      }
    },
    [isAuthenticated, recordRecentMutation, scheduleRemoteRefresh]
  );

  const flushDeferredMutations = useCallback(async () => {
    if (!deferredMutationsRef.current.length) {
      return;
    }
    const pending = [...deferredMutationsRef.current];
    deferredMutationsRef.current = [];
    const operations = pending.map((entry) => entry.operation);
    const ownerScopes = Array.from(
      new Set(
        pending
          .map((entry) => entry.ownerScope)
          .filter((value): value is string => Boolean(value))
      )
    );
    const result = await dispatchRemoteMutationBatch(operations, ownerScopes);
    pending.forEach((entry) => entry.resolve(result));
  }, [dispatchRemoteMutationBatch]);

  const scheduleDeferredMutationFlush = useCallback(() => {
    if (typeof window === "undefined") {
      void flushDeferredMutations();
      return;
    }
    if (deferredFlushTimerRef.current) {
      window.clearTimeout(deferredFlushTimerRef.current);
    }
    const delay = getDeferredMutationDelay();
    deferredFlushTimerRef.current = window.setTimeout(() => {
      deferredFlushTimerRef.current = null;
      void flushDeferredMutations();
    }, delay);
  }, [flushDeferredMutations]);

  const runRemoteMutation = useCallback(
    (operation: OfflineMutation) => {
      if (!isAuthenticated) {
        return Promise.resolve({
          success: false,
          error: new Error("You need to sign in to sync this list"),
        } as const);
      }
      if (operation.ownerId) {
        pendingOwnerMutationsRef.current.set(operation.ownerId, Date.now());
      }
      return new Promise<RemoteMutationResult>((resolve) => {
        deferredMutationsRef.current.push({
          operation,
          ownerScope: operation.ownerId,
          resolve,
        });
        scheduleDeferredMutationFlush();
      });
    },
    [isAuthenticated, scheduleDeferredMutationFlush]
  );

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && deferredFlushTimerRef.current) {
        window.clearTimeout(deferredFlushTimerRef.current);
      }
      deferredMutationsRef.current = [];
    };
  }, []);

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

  const flushOfflineMutations = useCallback(async () => {
    if (!offlineMutationsRef.current.length) {
      return;
    }
    const pending = [...offlineMutationsRef.current];
    updateOfflineQueue([]);
    const ownerScopes = Array.from(
      new Set(pending.map((mutation) => mutation.ownerId))
    );
    ownerScopes.forEach((ownerId) => {
      pendingOwnerMutationsRef.current.set(ownerId, Date.now());
    });
    const result = await dispatchRemoteMutationBatch(pending, ownerScopes);
    if (!result.success) {
      updateOfflineQueue(pending);
      return;
    }
    await backgroundRefreshRemoteLists();
  }, [
    backgroundRefreshRemoteLists,
    dispatchRemoteMutationBatch,
    updateOfflineQueue,
  ]);

  useEffect(() => {
    if (!isAuthenticated || !isClientOnline) {
      return;
    }
    void flushOfflineMutations();
  }, [flushOfflineMutations, isAuthenticated, isClientOnline]);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type !== SHOPPING_LIST_SYNC_COMPLETE_MESSAGE) {
        return;
      }
      updateOfflineQueue([]);
      void backgroundRefreshRemoteLists();
    };
    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
    };
  }, [backgroundRefreshRemoteLists, updateOfflineQueue]);

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
    (
      ingredients: IncomingIngredient[],
      ownerOverride?: string,
      options?: { position?: "start" | "end" }
    ) => {
      if (!ingredients.length) return;
      if (!isAuthenticated) {
        setLocalStore((current) =>
          addIngredientsToState(current, ingredients, options?.position)
        );
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) {
        console.warn("No shopping list owner available for new items");
        return;
      }

      if (targetOwnerId === LOCAL_OWNER_ID) {
        setLocalStore((current) =>
          addIngredientsToState(current, ingredients, options?.position)
        );
        return;
      }

      if (!isClientOnline) {
        const didUpdate = applyOwnerStateMutation(targetOwnerId, (state) =>
          addIngredientsToState(state, ingredients, options?.position)
        );
        if (didUpdate) {
          queueOfflineMutation({
            kind: "ADD_ITEMS",
            ownerId: targetOwnerId,
            ingredients,
            position: options?.position,
          });
        }
        return;
      }

      void applyOwnerStateMutation(targetOwnerId, (state) =>
        addIngredientsToState(state, ingredients, options?.position)
      );

      void runRemoteMutation({
        kind: "ADD_ITEMS",
        ownerId: targetOwnerId,
        ingredients,
        position: options?.position,
      });
    },
    [
      applyOwnerStateMutation,
      isAuthenticated,
      isClientOnline,
      queueOfflineMutation,
      resolveOwnerId,
      runRemoteMutation,
      setLocalStore,
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

      if (targetOwnerId === LOCAL_OWNER_ID) {
        setLocalStore((current) => removeItemFromState(current, key));
        return;
      }

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

      commitRemoteLists((current) => {
        let changed = false;
        const next = current.map((list) => {
          if (list.ownerId !== targetOwnerId) {
            return list;
          }
          const updatedState = removeItemFromState(list.state, key);
          if (updatedState === list.state) {
            return list;
          }
          changed = true;
          return { ...list, state: updatedState };
        });
        return changed ? next : current;
      });

      void runRemoteMutation({
        kind: "REMOVE_ITEM",
        ownerId: targetOwnerId,
        label: key,
      });
    },
    [
      applyOwnerStateMutation,
      commitRemoteLists,
      isAuthenticated,
      isClientOnline,
      queueOfflineMutation,
      resolveOwnerId,
      runRemoteMutation,
      setLocalStore,
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

      if (targetOwnerId === LOCAL_OWNER_ID) {
        setLocalStore((current) => clearListState(current));
        return;
      }

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

      commitRemoteLists((current) => {
        let changed = false;
        const next = current.map((list) => {
          if (list.ownerId !== targetOwnerId) {
            return list;
          }
          const updatedState = clearListState(list.state);
          if (updatedState === list.state) {
            return list;
          }
          changed = true;
          return { ...list, state: updatedState };
        });
        return changed ? next : current;
      });
      void runRemoteMutation({
        kind: "CLEAR_LIST",
        ownerId: targetOwnerId,
      });
    },
    [
      applyOwnerStateMutation,
      commitRemoteLists,
      isAuthenticated,
      isClientOnline,
      queueOfflineMutation,
      resolveOwnerId,
      runRemoteMutation,
      setLocalStore,
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

      void runRemoteMutation({
        kind: "REORDER_ITEMS",
        ownerId: targetOwnerId,
        order: orderedKeys,
      });
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

  const setCrossedOff = useCallback(
    (key: string, crossed: boolean, ownerOverride?: string) => {
      if (!key) {
        return;
      }
      const timestamp = crossed ? Date.now() : null;

      if (!isAuthenticated) {
        setLocalStore((current) => setCrossedOffFlag(current, key, timestamp));
        return;
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) {
        return;
      }

      if (!isClientOnline) {
        const didUpdate = applyOwnerStateMutation(targetOwnerId, (state) =>
          setCrossedOffFlag(state, key, timestamp)
        );
        if (didUpdate) {
          queueOfflineMutation({
            kind: "SET_CROSSED_OFF",
            ownerId: targetOwnerId,
            label: key,
            crossedOffAt: timestamp,
          });
        }
        return;
      }

      commitRemoteLists((current) => {
        let changed = false;
        const next = current.map((list) => {
          if (list.ownerId !== targetOwnerId) {
            return list;
          }
          const nextState = setCrossedOffFlag(list.state, key, timestamp);
          if (nextState === list.state) {
            return list;
          }
          changed = true;
          return { ...list, state: nextState };
        });
        return changed ? next : current;
      });

      void runRemoteMutation({
        kind: "SET_CROSSED_OFF",
        ownerId: targetOwnerId,
        label: key,
        crossedOffAt: timestamp,
      });
    },
    [
      applyOwnerStateMutation,
      commitRemoteLists,
      isAuthenticated,
      isClientOnline,
      queueOfflineMutation,
      resolveOwnerId,
      runRemoteMutation,
      setLocalStore,
    ]
  );

  const getEntriesForItem = useCallback(
    (key: string, ownerOverride?: string) => {
      if (!key) {
        return null;
      }

      const readEntries = (state: ShoppingListState | null | undefined) => {
        const record = state?.[key];
        if (!record) {
          return null;
        }
        return record.entries.map((entry) => ({ ...entry }));
      };

      if (!isAuthenticated) {
        return readEntries(localStore);
      }

      const targetOwnerId = resolveOwnerId(ownerOverride);
      if (!targetOwnerId) {
        return null;
      }

      if (targetOwnerId === LOCAL_OWNER_ID) {
        return readEntries(localStore);
      }

      const targetList = remoteLists.find(
        (list) => list.ownerId === targetOwnerId
      );
      if (!targetList) {
        return null;
      }

      return readEntries(targetList.state);
    },
    [isAuthenticated, localStore, remoteLists, resolveOwnerId]
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

      const result = await runRemoteMutation({
        kind: "UPDATE_QUANTITY",
        ownerId: targetOwnerId,
        label: key,
        quantity: quantityText,
      });

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
    let base: OwnerListState[] = [];
    if (isAuthenticated) {
      if (isRemote) {
        base = remoteLists;
      } else if (currentUserId) {
        base = [
          {
            ownerId: currentUserId,
            ownerLabel: selfListLabel,
            ownerDisplayName: derivedSelfDisplayName,
            isSelf: true,
            state: {},
          },
        ];
      }
    } else {
      base = [
        {
          ownerId: LOCAL_OWNER_ID,
          ownerLabel: localListLabel,
          ownerDisplayName: derivedSelfDisplayName,
          isSelf: true,
          state: localStore,
        },
      ];
    }

    if (!base.length) {
      return base;
    }

    const prioritizedOwnerId =
      selectedOwnerId ?? persistedOwnerIdRef.current ?? null;
    const ordered = base.slice();
    if (prioritizedOwnerId) {
      const index = ordered.findIndex(
        (list) => list.ownerId === prioritizedOwnerId
      );
      if (index > 0) {
        const [match] = ordered.splice(index, 1);
        ordered.unshift(match);
      }
    }
    return ordered;
  }, [
    currentUserId,
    isAuthenticated,
    isRemote,
    derivedSelfDisplayName,
    localListLabel,
    localStore,
    remoteLists,
    selectedOwnerId,
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
      if (isAuthenticated && !hasSyncedRemoteLists) {
        return current;
      }
      const fallbackOwnerId = resolvedLists[0]?.ownerId ?? current;
      if (fallbackOwnerId && fallbackOwnerId !== current) {
        persistedOwnerIdRef.current = fallbackOwnerId;
      }
      return fallbackOwnerId ?? current;
    });
  }, [
    hasLoadedStoredSelection,
    hasSyncedRemoteLists,
    isAuthenticated,
    resolvedLists,
  ]);

  useEffect(() => {
    const preferred = persistedOwnerIdRef.current;
    if (!preferred || selectedOwnerId === preferred) {
      return;
    }
    if (!resolvedLists.some((list) => list.ownerId === preferred)) {
      return;
    }
    setSelectedOwnerId(preferred);
  }, [resolvedLists, selectedOwnerId]);

  useEffect(() => {
    if (!hasLoadedStoredSelection || typeof window === "undefined") {
      return;
    }
    const storageKey = getSelectedOwnerStorageKey(
      isAuthenticated ? currentUserId : null
    );
    if (selectedOwnerId) {
      window.localStorage.setItem(storageKey, selectedOwnerId);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  }, [
    currentUserId,
    hasLoadedStoredSelection,
    isAuthenticated,
    selectedOwnerId,
  ]);

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

  const selectList = useCallback(
    (ownerId: string) => {
      setSelectedOwnerId(ownerId);
      persistedOwnerIdRef.current = ownerId;
      if (typeof window !== "undefined") {
        const storageKey = getSelectedOwnerStorageKey(
          isAuthenticated ? currentUserId : null
        );
        window.localStorage.setItem(storageKey, ownerId);
      }
    },
    [currentUserId, isAuthenticated]
  );

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
      setCrossedOff,
      getEntriesForItem,
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
      setCrossedOff,
      getEntriesForItem,
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
  ingredients: IncomingIngredient[],
  position: "start" | "end" = "end"
): ShoppingListState {
  if (!ingredients.length) {
    return state;
  }
  const next = { ...state };
  let orderCursor = getNextOrderValue(next);
  const lowestOrder = getLowestOrderValue(next);
  let prependCursor = (lowestOrder ?? 0) - 1;
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
        crossedOffAt: null,
      };
    } else {
      const assignedOrder =
        position === "start" ? prependCursor-- : (orderCursor += 1);
      next[key] = {
        label: parsed.label,
        entries: [entry],
        order: assignedOrder,
        crossedOffAt: null,
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
      crossedOffAt: record.crossedOffAt ?? null,
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
      crossedOffAt: record.crossedOffAt ?? null,
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

function setCrossedOffFlag(
  state: ShoppingListState,
  key: string,
  crossedOffAt: number | null
): ShoppingListState {
  const record = state[key];
  if (!record) {
    return state;
  }
  const normalizedValue =
    typeof crossedOffAt === "number" && Number.isFinite(crossedOffAt)
      ? crossedOffAt
      : null;
  if ((record.crossedOffAt ?? null) === normalizedValue) {
    return state;
  }
  return {
    ...state,
    [key]: {
      ...record,
      crossedOffAt: normalizedValue,
    },
  };
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
      result[key] = {
        label,
        entries: hydratedEntries,
        order: resolveOrder(),
        crossedOffAt: normalizeCrossedOffStamp(
          (record as Record<string, unknown>).crossedOffAt
        ),
      };
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
      crossedOffAt: null,
    };
  });

  return result;
}

function normalizeCrossedOffStamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
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
    case "SET_CROSSED_OFF": {
      const label =
        typeof record.label === "string" && record.label.length
          ? record.label
          : null;
      if (!label) {
        return null;
      }
      if (record.crossedOffAt === null) {
        return { kind: "SET_CROSSED_OFF", ownerId, label, crossedOffAt: null };
      }
      if (
        typeof record.crossedOffAt === "number" &&
        Number.isFinite(record.crossedOffAt)
      ) {
        return {
          kind: "SET_CROSSED_OFF",
          ownerId,
          label,
          crossedOffAt: record.crossedOffAt,
        };
      }
      return null;
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
