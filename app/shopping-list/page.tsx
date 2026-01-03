"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { AnimatePresence, motion, type Transition } from "framer-motion";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type CSSProperties,
  type TouchEvent,
} from "react";
import { AppNav } from "@/components/app-nav";
import { useCollaborationUI } from "@/components/collaboration-ui-context";
import { useShoppingList } from "@/components/shopping-list-context";
import { useToast } from "@/components/toast-provider";
import {
  getMeasureDisplay,
  MEASURE_OPTIONS,
  normalizeMeasureText,
  type IncomingIngredient,
  type QuantityEntry,
  type ShoppingListItem,
} from "@/lib/shopping-list";

type QuantityEditorState = {
  key: string;
  ownerId: string | null;
  mode: "structured" | "custom";
  quantity: string;
  unit: string;
  customDraft: string;
  fallbackSummary: string;
};

const UNICODE_FRACTIONS: Record<string, number> = {
  "¼": 0.25,
  "½": 0.5,
  "¾": 0.75,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};

const isKnownMeasure = (value: string) =>
  Boolean(value && MEASURE_OPTIONS.some((option) => option.value === value));

const SWIPE_TRIGGER_THRESHOLD = 64;
const SWIPE_MAX_OFFSET = 120;
const INTERACTIVE_SWIPE_SELECTOR =
  "button, a, input, textarea, select, [role='button']";
const MAX_ORDER_RESTORE_ATTEMPTS = 50;
const LIST_LAYOUT_TRANSITION: Transition = {
  type: "spring",
  damping: 32,
  stiffness: 420,
  mass: 0.4,
};

type SwipeSession = {
  key: string;
  startX: number;
  startY: number;
  deltaX: number;
  direction: "pending" | "horizontal" | "vertical";
};

type SwipePreviewState = {
  key: string | null;
  deltaX: number;
  isActive: boolean;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

type SortableRenderProps = {
  ref: (node: HTMLLIElement | null) => void;
  style: CSSProperties;
  dragHandleProps: Record<string, unknown> | null;
  isDragging: boolean;
};

const SortableListItem = ({
  item,
  children,
}: {
  item: ShoppingListItem;
  children: (props: SortableRenderProps) => ReactNode;
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.storageKey });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const dragHandleProps = { ...attributes, ...listeners } as Record<
    string,
    unknown
  >;
  return children({
    ref: setNodeRef,
    style,
    dragHandleProps,
    isDragging,
  });
};

const guessStructuredFields = (summary: string) => {
  const trimmed = summary.trim();
  if (!trimmed) {
    return { quantity: "", unit: "" };
  }
  const tokens = trimmed.split(/\s+/);
  const quantity = tokens.shift() ?? "";
  const unitCandidate = tokens.join(" ");
  const normalizedUnit = normalizeMeasureText(unitCandidate);
  if (quantity && normalizedUnit && isKnownMeasure(normalizedUnit)) {
    return { quantity, unit: normalizedUnit };
  }
  return { quantity: "", unit: "" };
};

const deriveQuantityEditorFields = (summary: string) => {
  const cleaned = summary === "—" ? "" : summary.trim();
  const { quantity, unit } = guessStructuredFields(cleaned);
  if (quantity && unit) {
    return {
      mode: "structured" as const,
      quantity,
      unit,
      customDraft: cleaned,
      fallbackSummary: cleaned || "As listed",
    };
  }
  return {
    mode: "custom" as const,
    quantity: "",
    unit: "",
    customDraft: cleaned,
    fallbackSummary: cleaned || "As listed",
  };
};

const estimateQuantityValue = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  let total = 0;
  let consumed = 0;
  for (const token of tokens) {
    if (/^\d+$/.test(token) || /^\d*\.\d+$/.test(token)) {
      total += Number(token);
      consumed += 1;
      continue;
    }
    if (/^\d+\/\d+$/.test(token)) {
      const [numerator, denominator] = token.split("/").map(Number);
      if (denominator) {
        total += numerator / denominator;
        consumed += 1;
        continue;
      }
    }
    if (UNICODE_FRACTIONS[token]) {
      total += UNICODE_FRACTIONS[token];
      consumed += 1;
      continue;
    }
    break;
  }
  return consumed ? total : null;
};

const formatStructuredDraft = (quantity: string, unit: string) => {
  const trimmedAmount = quantity.trim();
  if (!trimmedAmount) {
    return "";
  }
  if (!unit) {
    return trimmedAmount;
  }
  const amountValue = estimateQuantityValue(trimmedAmount);
  if (amountValue === null) {
    return `${trimmedAmount} ${unit}`.trim();
  }
  const unitLabel = getMeasureDisplay(unit, amountValue);
  return `${trimmedAmount} ${unitLabel}`.trim();
};

const normalizeUndoValue = (...parts: Array<string | null | undefined>) =>
  parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const entriesToUndoIngredients = (
  label: string,
  entries: QuantityEntry[]
): IncomingIngredient[] =>
  entries.map((entry) => {
    const rawQuantity = entry.quantityText?.trim() || "";
    const normalizedQuantity = rawQuantity.toLowerCase();
    const hasMeaningfulQuantity =
      normalizedQuantity.length > 0 && normalizedQuantity !== "as listed";
    const quantityText = hasMeaningfulQuantity ? rawQuantity : "";
    const measureText = entry.measureText?.trim() || "";
    const includeMeasure = !quantityText && measureText;
    return {
      value: normalizeUndoValue(
        quantityText || null,
        includeMeasure ? measureText : null,
        label
      ),
      recipeId: entry.sourceRecipeId ?? undefined,
      recipeTitle: entry.sourceRecipeTitle ?? undefined,
    };
  });

const fallbackUndoIngredient = (
  item: ShoppingListItem
): IncomingIngredient[] => {
  const hasInformativeSummary = (() => {
    if (!item.unitSummary) {
      return false;
    }
    const normalized = item.unitSummary.trim().toLowerCase();
    return (
      normalized.length > 1 && normalized !== "—" && normalized !== "as listed"
    );
  })();
  const summary = hasInformativeSummary
    ? `${item.unitSummary} ${item.label}`
    : item.label;
  return [
    {
      value: summary.replace(/\s+/g, " ").trim() || item.label,
    },
  ];
};

export default function ShoppingListPage() {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";
  const {
    addItems,
    items,
    lists,
    selectedListId,
    removeItem,
    clearList,
    reorderItems,
    setCrossedOff,
    getEntriesForItem,
    updateQuantity,
    totalItems,
    isSyncing,
    externalUpdateNotice,
    acknowledgeExternalUpdate,
    pantryItems,
    isPantrySyncing,
    addPantryItem,
    removePantryItem,
    refreshPantry,
  } = useShoppingList();
  const { showToast } = useToast();
  const { refreshCollaborations } = useCollaborationUI();
  const [quantityEditor, setQuantityEditor] =
    useState<QuantityEditorState | null>(null);
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [isQuantitySaving, setIsQuantitySaving] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [isQuickAddActive, setIsQuickAddActive] = useState(false);
  const [quickAddDraft, setQuickAddDraft] = useState("");
  const [quickAddError, setQuickAddError] = useState<string | null>(null);
  const [pantryDraft, setPantryDraft] = useState("");
  const [pantryError, setPantryError] = useState<string | null>(null);
  const [isPantrySaving, setIsPantrySaving] = useState(false);
  const [removingPantryId, setRemovingPantryId] = useState<string | null>(null);
  const swipeSessionRef = useRef<SwipeSession | null>(null);
  const quickAddInputRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const pendingOrderRestoresRef = useRef<
    Map<string, Map<string, { snapshot: string[]; attempts: number }>>
  >(new Map());
  const [swipePreview, setSwipePreview] = useState<SwipePreviewState>({
    key: null,
    deltaX: 0,
    isActive: false,
  });
  const activeList =
    lists.find((list) => list.ownerId === selectedListId) ?? lists[0] ?? null;
  const activeOwnerId = activeList?.ownerId ?? null;
  const emptyState = items.length === 0;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 120, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const sortableActiveKeys = useMemo(() => {
    if (!activeOwnerId) {
      return [];
    }
    return items
      .filter((item) => item.ownerId === activeOwnerId && !item.crossedOffAt)
      .map((item) => item.storageKey);
  }, [activeOwnerId, items]);

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!activeOwnerId || !over || active.id === over.id) {
        return;
      }
      const ownerItems = items.filter(
        (entry) => entry.ownerId === activeOwnerId
      );
      const activeKeys = ownerItems
        .filter((entry) => !entry.crossedOffAt)
        .map((entry) => entry.storageKey);
      const fromIndex = activeKeys.indexOf(active.id as string);
      const toIndex = activeKeys.indexOf(over.id as string);
      if (fromIndex === -1 || toIndex === -1) {
        return;
      }
      const nextActive = arrayMove(activeKeys, fromIndex, toIndex);
      const crossedKeys = ownerItems
        .filter((entry) => entry.crossedOffAt)
        .map((entry) => entry.storageKey);
      reorderItems([...nextActive, ...crossedKeys], activeOwnerId);
    },
    [activeOwnerId, items, reorderItems]
  );

  useEffect(() => {
    void refreshCollaborations();
  }, [isAuthenticated, refreshCollaborations]);

  useEffect(() => {
    if (!externalUpdateNotice) {
      return;
    }
    const listLabel = externalUpdateNotice.isSelf
      ? "your shopping list"
      : `${externalUpdateNotice.ownerLabel}'s list`;
    showToast(`A collaborator updated ${listLabel}.`, "info");
    acknowledgeExternalUpdate();
  }, [acknowledgeExternalUpdate, externalUpdateNotice, showToast]);

  useEffect(() => {
    if (
      quantityEditor &&
      quantityEditor.ownerId &&
      quantityEditor.ownerId !== activeOwnerId
    ) {
      setQuantityEditor(null);
      setQuantityError(null);
    }
  }, [activeOwnerId, quantityEditor]);

  useEffect(() => {
    if (!quantityEditor) return;
    const stillExists = items.some(
      (item) => item.storageKey === quantityEditor.key
    );
    if (!stillExists) {
      setQuantityEditor(null);
      setQuantityError(null);
    }
  }, [items, quantityEditor]);

  const beginQuantityEdit = useCallback(
    (storageKey: string, unitSummary: string) => {
      const editorFields = deriveQuantityEditorFields(unitSummary);
      setQuantityEditor({
        key: storageKey,
        ownerId: activeOwnerId,
        ...editorFields,
      });
      setQuantityError(null);
    },
    [activeOwnerId]
  );

  const cancelQuantityEdit = useCallback(() => {
    setQuantityEditor(null);
    setQuantityError(null);
    setIsQuantitySaving(false);
  }, []);

  const handleStructuredQuantityChange = useCallback((value: string) => {
    setQuantityEditor((current) =>
      current ? { ...current, quantity: value } : current
    );
  }, []);

  const handleStructuredUnitChange = useCallback((value: string) => {
    setQuantityEditor((current) =>
      current ? { ...current, unit: value } : current
    );
  }, []);

  const handleCustomDraftChange = useCallback((value: string) => {
    setQuantityEditor((current) =>
      current ? { ...current, customDraft: value } : current
    );
  }, []);

  const activateStructuredMode = useCallback(() => {
    setQuantityEditor((current) => {
      if (!current || current.mode === "structured") {
        return current;
      }
      const guess = guessStructuredFields(current.customDraft);
      return {
        ...current,
        mode: "structured",
        quantity: guess.quantity || "",
        unit: guess.unit || current.unit || "",
      };
    });
    setQuantityError(null);
  }, []);

  const activateCustomMode = useCallback(() => {
    setQuantityEditor((current) => {
      if (!current || current.mode === "custom") {
        return current;
      }
      const draftText =
        formatStructuredDraft(current.quantity, current.unit) ||
        current.customDraft;
      return {
        ...current,
        mode: "custom",
        customDraft: draftText,
      };
    });
    setQuantityError(null);
  }, []);

  const handleQuantitySubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!quantityEditor) {
        return;
      }
      if (!quantityEditor.ownerId) {
        setQuantityError("Select a shopping list first");
        return;
      }
      setIsQuantitySaving(true);
      setQuantityError(null);
      try {
        const fallbackSummary =
          quantityEditor.fallbackSummary.trim() || "As listed";
        const nextSummary = (() => {
          if (quantityEditor.mode === "structured") {
            const amountText = quantityEditor.quantity.trim();
            if (!amountText) {
              return fallbackSummary;
            }
            const unitValue = quantityEditor.unit.trim();
            if (!unitValue) {
              return amountText;
            }
            const amountValue = estimateQuantityValue(amountText);
            const unitLabel =
              amountValue === null
                ? unitValue
                : getMeasureDisplay(unitValue, amountValue);
            return `${amountText} ${unitLabel}`.trim();
          }
          return quantityEditor.customDraft.trim() || fallbackSummary;
        })();
        await updateQuantity(
          quantityEditor.key,
          nextSummary,
          quantityEditor.ownerId
        );
        setQuantityEditor(null);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to update quantity";
        setQuantityError(message);
      } finally {
        setIsQuantitySaving(false);
      }
    },
    [quantityEditor, updateQuantity]
  );

  const focusWithoutScroll = useCallback(
    (element: HTMLElement | null, position?: { x: number; y: number }) => {
      if (!element || typeof window === "undefined") {
        return;
      }
      const x = position?.x ?? window.scrollX;
      const y = position?.y ?? window.scrollY;
      try {
        element.focus({ preventScroll: true });
      } catch {
        element.focus();
      }
      window.scrollTo({ top: y, left: x, behavior: "auto" });
    },
    []
  );

  const handleCrossToggle = useCallback(
    (
      item: ShoppingListItem,
      nextCrossed: boolean,
      button?: HTMLButtonElement | null
    ) => {
      const ownerId = item.ownerId;
      const initialScroll =
        !nextCrossed && typeof window !== "undefined"
          ? { x: window.scrollX, y: window.scrollY }
          : null;
      setCrossedOff(item.storageKey, nextCrossed, ownerId);
      if (nextCrossed && item.isSelf && isAuthenticated) {
        showToast(`${item.label} checked off. Add to pantry?`, "success", {
          actionLabel: "Add to pantry",
          onClick: () => {
            void addPantryItem({ label: item.label })
              .then(() => showToast(`${item.label} saved to pantry.`))
              .catch((error) =>
                showToast(
                  error instanceof Error
                    ? error.message
                    : "Unable to save pantry item.",
                  "error"
                )
              );
          },
        });
      }
      if (!nextCrossed && button) {
        window.requestAnimationFrame(() => {
          if (!button.isConnected) {
            return;
          }
          focusWithoutScroll(button, initialScroll ?? undefined);
        });
      }
    },
    [
      addPantryItem,
      focusWithoutScroll,
      isAuthenticated,
      setCrossedOff,
      showToast,
    ]
  );

  const orderSnapshotRef = useRef<Map<string, Map<string, string[]>>>(
    new Map()
  );

  const flushPendingOrderRestores = useCallback(() => {
    const pendingEntries = Array.from(
      pendingOrderRestoresRef.current.entries()
    );
    pendingEntries.forEach(([ownerId, entries]) => {
      if (!entries.size) {
        pendingOrderRestoresRef.current.delete(ownerId);
        return;
      }
      const ownerKeys = new Set(
        itemsRef.current
          .filter((candidate) => candidate.ownerId === ownerId)
          .map((candidate) => candidate.storageKey)
      );
      const entryList = Array.from(entries.entries());
      entryList.forEach(([key, payload]) => {
        if (ownerKeys.has(key)) {
          entries.delete(key);
          if (!entries.size) {
            pendingOrderRestoresRef.current.delete(ownerId);
          }
          reorderItems(payload.snapshot, ownerId);
          return;
        }
        if (payload.attempts + 1 >= MAX_ORDER_RESTORE_ATTEMPTS) {
          entries.delete(key);
          if (!entries.size) {
            pendingOrderRestoresRef.current.delete(ownerId);
          }
          return;
        }
        payload.attempts += 1;
      });
    });
  }, [reorderItems]);

  useEffect(() => {
    flushPendingOrderRestores();
  }, [flushPendingOrderRestores, items]);

  const queueOrderRestore = useCallback(
    (ownerId: string, key: string, snapshot: string[]) => {
      if (!snapshot.length) {
        return;
      }
      const entries = pendingOrderRestoresRef.current.get(ownerId) ?? new Map();
      entries.set(key, { snapshot, attempts: 0 });
      pendingOrderRestoresRef.current.set(ownerId, entries);
      flushPendingOrderRestores();
    },
    [flushPendingOrderRestores]
  );

  const captureOwnerOrder = useCallback((ownerId: string, key: string) => {
    if (!key) {
      return;
    }
    const snapshots = orderSnapshotRef.current.get(ownerId) ?? new Map();
    const ownerItems = itemsRef.current
      .filter((candidate) => candidate.ownerId === ownerId)
      .map((candidate) => candidate.storageKey);
    snapshots.set(key, ownerItems);
    orderSnapshotRef.current.set(ownerId, snapshots);
  }, []);

  const restoreOwnerOrder = useCallback(
    (ownerId: string, key: string) => {
      if (!key) {
        return;
      }
      const snapshots = orderSnapshotRef.current.get(ownerId);
      if (!snapshots) {
        return;
      }
      const snapshot = snapshots.get(key);
      snapshots.delete(key);
      if (!snapshots.size) {
        orderSnapshotRef.current.delete(ownerId);
      }
      if (!snapshot?.length) {
        return;
      }
      queueOrderRestore(ownerId, key, snapshot);
    },
    [queueOrderRestore]
  );

  const handleDeleteItem = useCallback(
    (item: ShoppingListItem) => {
      const ownerId = item.ownerId;
      captureOwnerOrder(ownerId, item.storageKey);
      const entrySnapshots = getEntriesForItem(item.storageKey, ownerId);
      const undoPayload =
        entrySnapshots && entrySnapshots.length
          ? entriesToUndoIngredients(item.label, entrySnapshots)
          : fallbackUndoIngredient(item);
      const undoIngredients = undoPayload.map((ingredient) => ({
        ...ingredient,
      }));
      removeItem(item.storageKey, ownerId);
      showToast(`${item.label} removed`, "error", {
        actionLabel: "Undo",
        onClick: () => {
          addItems(undoIngredients, ownerId);
          restoreOwnerOrder(ownerId, item.storageKey);
        },
      });
    },
    [
      addItems,
      captureOwnerOrder,
      getEntriesForItem,
      removeItem,
      restoreOwnerOrder,
      showToast,
    ]
  );

  const handleRequestClear = useCallback(() => {
    setIsConfirmingClear(true);
  }, []);

  const handleCancelClear = useCallback(() => {
    setIsConfirmingClear(false);
  }, []);

  const handleStartQuickAdd = useCallback(() => {
    setIsQuickAddActive(true);
    setQuickAddError(null);
  }, []);

  const handleCancelQuickAdd = useCallback(() => {
    setIsQuickAddActive(false);
    setQuickAddDraft("");
    setQuickAddError(null);
  }, []);

  const handleConfirmClear = useCallback(() => {
    clearList(activeOwnerId ?? undefined);
    setIsConfirmingClear(false);
  }, [activeOwnerId, clearList]);

  const handleQuickAddChange = useCallback(
    (value: string) => {
      setQuickAddDraft(value);
      if (quickAddError) {
        setQuickAddError(null);
      }
    },
    [quickAddError]
  );

  const handleQuickAddSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = quickAddDraft.trim();
      if (!trimmed) {
        setQuickAddError("Enter an ingredient to add");
        return;
      }
      if (!activeOwnerId) {
        setQuickAddError("Select a shopping list first");
        return;
      }
      addItems([{ value: trimmed }], activeOwnerId, { position: "start" });
      setQuickAddDraft("");
      setQuickAddError(null);
    },
    [activeOwnerId, addItems, quickAddDraft]
  );

  const handlePantrySubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = pantryDraft.trim();
      if (!trimmed) {
        setPantryError("Enter a pantry staple");
        return;
      }
      setIsPantrySaving(true);
      try {
        await addPantryItem({ label: trimmed });
        setPantryDraft("");
        setPantryError(null);
        showToast("Saved to pantry.");
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to save pantry item.";
        setPantryError(message);
      } finally {
        setIsPantrySaving(false);
      }
    },
    [addPantryItem, pantryDraft, showToast]
  );

  const handlePantryRemove = useCallback(
    async (itemId: string, label: string) => {
      setRemovingPantryId(itemId);
      try {
        await removePantryItem(itemId);
        showToast(`${label} removed from pantry.`);
      } catch (error) {
        showToast(
          error instanceof Error
            ? error.message
            : "Unable to remove pantry item.",
          "error"
        );
      } finally {
        setRemovingPantryId(null);
      }
    },
    [removePantryItem, showToast]
  );

  const handleRefreshPantry = useCallback(async () => {
    if (!isAuthenticated) {
      return;
    }
    try {
      await refreshPantry();
      showToast("Pantry updated.");
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Unable to refresh pantry right now.",
        "error"
      );
    }
  }, [isAuthenticated, refreshPantry, showToast]);

  const resetSwipePreview = useCallback(() => {
    swipeSessionRef.current = null;
    setSwipePreview({ key: null, deltaX: 0, isActive: false });
  }, []);

  const handleSwipeStart = useCallback(
    (event: TouchEvent<HTMLDivElement>, item: ShoppingListItem) => {
      if (event.touches.length !== 1) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(INTERACTIVE_SWIPE_SELECTOR)
      ) {
        return;
      }
      const touch = event.touches[0];
      swipeSessionRef.current = {
        key: item.storageKey,
        startX: touch.clientX,
        startY: touch.clientY,
        deltaX: 0,
        direction: "pending",
      };
      setSwipePreview({ key: item.storageKey, deltaX: 0, isActive: true });
    },
    []
  );

  const handleSwipeMove = useCallback(
    (event: TouchEvent<HTMLDivElement>, item: ShoppingListItem) => {
      const session = swipeSessionRef.current;
      if (!session || session.key !== item.storageKey) {
        return;
      }
      if (event.touches.length !== 1) {
        resetSwipePreview();
        return;
      }
      const touch = event.touches[0];
      const deltaX = touch.clientX - session.startX;
      const deltaY = touch.clientY - session.startY;

      if (session.direction === "pending") {
        if (Math.abs(deltaX) < 6 && Math.abs(deltaY) < 6) {
          return;
        }
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          resetSwipePreview();
          return;
        }
        session.direction = "horizontal";
      }

      if (session.direction !== "horizontal") {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }
      const clamped = clamp(deltaX, -SWIPE_MAX_OFFSET, SWIPE_MAX_OFFSET);
      session.deltaX = clamped;
      setSwipePreview({ key: session.key, deltaX: clamped, isActive: true });
    },
    [resetSwipePreview]
  );

  const finalizeSwipe = useCallback(
    (item: ShoppingListItem, shouldCancel?: boolean) => {
      const session = swipeSessionRef.current;
      const isActiveSession = Boolean(
        session && session.key === item.storageKey
      );
      const deltaX = isActiveSession ? session!.deltaX : 0;
      const direction = isActiveSession ? session!.direction : "pending";
      resetSwipePreview();
      if (!isActiveSession || shouldCancel || direction !== "horizontal") {
        return;
      }
      if (deltaX <= -SWIPE_TRIGGER_THRESHOLD) {
        handleDeleteItem(item);
      } else if (deltaX >= SWIPE_TRIGGER_THRESHOLD) {
        const isCurrentlyCrossed = Boolean(item.crossedOffAt);
        handleCrossToggle(item, !isCurrentlyCrossed);
      }
    },
    [handleCrossToggle, handleDeleteItem, resetSwipePreview]
  );

  const handleSwipeEnd = useCallback(
    (item: ShoppingListItem) => finalizeSwipe(item, false),
    [finalizeSwipe]
  );

  const handleSwipeCancel = useCallback(
    (item: ShoppingListItem) => finalizeSwipe(item, true),
    [finalizeSwipe]
  );

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    if (isQuickAddActive) {
      quickAddInputRef.current?.focus();
    }
  }, [isQuickAddActive]);

  const heroStatusText = useMemo(() => {
    if (!hasHydrated) {
      return "Loading your list…";
    }
    if (emptyState) {
      return "No ingredients queued yet.";
    }
    return `${totalItems} item${totalItems === 1 ? "" : "s"} ready to shop.`;
  }, [emptyState, hasHydrated, totalItems]);

  const rawItems = hasHydrated ? items : [];

  const displayItems = useMemo(() => {
    if (!hasHydrated) {
      return rawItems;
    }
    return rawItems
      .map((item, index) => ({
        item,
        index,
        crossedAt: item.crossedOffAt ?? null,
      }))
      .sort((a, b) => {
        const aCrossed = a.crossedAt !== null;
        const bCrossed = b.crossedAt !== null;
        if (aCrossed && bCrossed) {
          if (a.crossedAt === b.crossedAt) {
            return a.index - b.index;
          }
          return (b.crossedAt ?? 0) - (a.crossedAt ?? 0);
        }
        if (aCrossed || bCrossed) {
          return aCrossed ? 1 : -1;
        }
        return a.index - b.index;
      })
      .map((entry) => entry.item);
  }, [hasHydrated, rawItems]);

  const completedItemsCount = useMemo(
    () => displayItems.filter((item) => Boolean(item.crossedOffAt)).length,
    [displayItems]
  );
  const hasCompletedItems = completedItemsCount > 0;

  const renderEmptyState = hasHydrated ? rawItems.length === 0 : true;
  const showEmptyState = renderEmptyState && !isSyncing;
  const clearButtonDisabled =
    !hasHydrated || renderEmptyState || isSyncing || !activeOwnerId;
  const editingItem = quantityEditor
    ? items.find((candidate) => candidate.storageKey === quantityEditor.key) ??
      null
    : null;

  const renderListItem = (item: ShoppingListItem) => {
    const layoutKey = `${item.ownerId}:${item.storageKey}`;
    const isCrossed = Boolean(item.crossedOffAt);
    const isSwipeTarget = swipePreview.key === item.storageKey;
    const swipeOffset = clamp(
      isSwipeTarget ? swipePreview.deltaX : 0,
      -SWIPE_MAX_OFFSET,
      SWIPE_MAX_OFFSET
    );
    const isSwipeActive = isSwipeTarget && swipePreview.isActive;
    const swipeBackdropVisible =
      isSwipeTarget && Math.abs(swipePreview.deltaX) > 4;

    const renderCard = (
      dragHandleProps: SortableRenderProps["dragHandleProps"] = null,
      isDragging = false
    ) => {
      const cardClasses = `flex select-none items-center gap-3 rounded-[28px] border px-4 py-3 text-sm shadow-sm transition-all duration-300 ease-out ${
        isDragging
          ? "border-rose-200 bg-rose-50/90 opacity-80 ring-2 ring-rose-100"
          : isCrossed
          ? "border-slate-100 bg-white/80 opacity-70"
          : "border-sky-100 bg-gradient-to-br from-white via-sky-50/80 to-white hover:shadow-md"
      }`;
      const resolvedHandleProps = (() => {
        if (!dragHandleProps) {
          return null;
        }
        const { style: handleStyle, ...rest } = dragHandleProps as {
          style?: CSSProperties;
        };
        return {
          ...rest,
          style: { ...(handleStyle ?? {}), touchAction: "none" },
        } as Record<string, unknown>;
      })();

      return (
        <>
          <div
            className={`pointer-events-none absolute inset-0 flex select-none items-center rounded-[32px] bg-gradient-to-r from-emerald-50 via-white to-rose-50 px-5 transition-opacity ${
              swipeBackdropVisible ? "opacity-100" : "opacity-0"
            }`}
          >
            <div className="flex flex-1 items-center text-2xl text-emerald-500">
              ✓
            </div>
            <div className="flex flex-1 items-center justify-end text-2xl text-rose-500">
              ✕
            </div>
          </div>
          <div
            className={`${cardClasses} relative z-10`}
            style={{
              transform: `translateX(${swipeOffset}px)`,
              transition: isSwipeActive ? "none" : "transform 0.2s ease",
              touchAction: isSwipeActive ? "none" : "pan-y",
            }}
            onTouchStart={(event) => handleSwipeStart(event, item)}
            onTouchMove={(event) => handleSwipeMove(event, item)}
            onTouchEnd={() => handleSwipeEnd(item)}
            onTouchCancel={() => handleSwipeCancel(item)}
          >
            <button
              type="button"
              aria-pressed={isCrossed}
              aria-label={
                isCrossed
                  ? `Restore ${item.label} to the active list`
                  : `Cross off ${item.label}`
              }
              onClick={(event) =>
                handleCrossToggle(item, !isCrossed, event.currentTarget)
              }
              className={`flex h-10 w-10 items-center justify-center rounded-full border-2 text-lg font-semibold transition ${
                isCrossed
                  ? "border-emerald-300 bg-emerald-50 text-emerald-600"
                  : "border-slate-300 bg-white text-slate-300 hover:border-emerald-300 hover:text-emerald-500"
              }`}
            >
              <span className={isCrossed ? "opacity-100" : "opacity-0"}>✓</span>
            </button>
            <div className="flex flex-1 flex-col gap-[6px]">
              <p
                className={`text-sm font-semibold ${
                  isCrossed ? "text-slate-400 line-through" : "text-slate-900"
                }`}
              >
                {item.label}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <button
                  type="button"
                  onClick={() =>
                    beginQuantityEdit(item.storageKey, item.unitSummary)
                  }
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] transition ${
                    isCrossed
                      ? "border-slate-200 text-slate-300"
                      : "border-slate-300 text-slate-600 hover:border-slate-400 hover:text-slate-900"
                  }`}
                  title="Adjust quantity"
                >
                  {item.unitSummary}
                </button>
                {quantityEditor?.key === item.storageKey && (
                  <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-sky-600">
                    Editing…
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 self-stretch">
              {!isCrossed && resolvedHandleProps && (
                <button
                  type="button"
                  aria-label={`Reorder ${item.label}`}
                  className="rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                  {...resolvedHandleProps}
                >
                  ⠿
                </button>
              )}
              <button
                type="button"
                onClick={() => handleDeleteItem(item)}
                className="rounded-full p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                aria-label={`Delete ${item.label}`}
              >
                ✕
              </button>
            </div>
          </div>
        </>
      );
    };

    if (isCrossed) {
      return (
        <motion.li
          layout
          layoutId={layoutKey}
          transition={LIST_LAYOUT_TRANSITION}
          initial={false}
          exit={{ opacity: 0, scale: 0.95 }}
          key={item.storageKey}
          className="relative"
        >
          {renderCard()}
        </motion.li>
      );
    }

    return (
      <SortableListItem key={item.storageKey} item={item}>
        {({ ref, style, dragHandleProps, isDragging }) => (
          <motion.li
            layout={!isDragging}
            layoutId={isDragging ? undefined : layoutKey}
            transition={isDragging ? { duration: 0 } : LIST_LAYOUT_TRANSITION}
            initial={false}
            exit={{ opacity: 0, scale: 0.95 }}
            className="relative"
            ref={ref}
            style={style}
          >
            {renderCard(dragHandleProps, isDragging)}
          </motion.li>
        )}
      </SortableListItem>
    );
  };

  const listElements = (() => {
    const elements: ReactNode[] = [];
    let completedToggleInserted = false;

    displayItems.forEach((item) => {
      const isCrossed = Boolean(item.crossedOffAt);
      if (isCrossed && hasCompletedItems && !completedToggleInserted) {
        completedToggleInserted = true;
        elements.push(
          <motion.li
            key="completed-toggle"
            layout
            layoutId="completed-toggle"
            transition={LIST_LAYOUT_TRANSITION}
            className="pt-6"
          >
            <button
              type="button"
              onClick={() => setShowCompleted((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-2xl border border-slate-100 bg-white/80 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-500 transition hover:border-slate-200"
            >
              <span>
                {showCompleted ? "Hide" : "Show"} completed (
                {completedItemsCount})
              </span>
              <span className="text-base">{showCompleted ? "-" : "+"}</span>
            </button>
          </motion.li>
        );
      }
      if (isCrossed && !showCompleted) {
        return;
      }
      elements.push(renderListItem(item));
    });

    return elements;
  })();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-sky-50 to-white px-4 py-8 text-slate-900 sm:py-12">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 sm:gap-8 lg:gap-10">
        <AppNav />
        <header className="rounded-3xl border border-white/60 bg-white/85 p-6 shadow-xl shadow-rose-100/60 backdrop-blur">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">
                Shopping list
              </h1>
              <p
                className="mt-1 text-sm text-slate-500"
                suppressHydrationWarning
              >
                {heroStatusText}
              </p>
            </div>
            <div className="flex flex-wrap gap-3 sm:justify-end">
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white/70 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm shadow-white/60 transition hover:border-slate-300"
              >
                Back to recipes
              </Link>
              <button
                type="button"
                onClick={handleRequestClear}
                disabled={clearButtonDisabled}
                className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-slate-900/25 transition disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isSyncing ? "Syncing…" : "Clear list"}
              </button>
            </div>
          </div>
          {!isAuthenticated && (
            <div className="mt-6 rounded-2xl border border-slate-200 bg-white/70 p-4 text-sm text-slate-600 shadow-inner shadow-white/60">
              <p className="font-semibold text-slate-900">
                You&rsquo;re browsing offline mode.
              </p>
              <p className="mt-1">
                Sign in with Google to sync this list across every device and
                keep your ingredients backed up.
              </p>
              <button
                type="button"
                onClick={() => void signIn("google")}
                className="mt-4 inline-flex items-center justify-center rounded-2xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-200/70 transition hover:scale-[1.01]"
              >
                Sign in to sync
              </button>
            </div>
          )}
        </header>
        <section className="rounded-3xl border border-white/70 bg-white/90 p-6 shadow-xl shadow-slate-200/70 backdrop-blur sm:p-8">
          <div className="lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-8">
            <div>
              <div className="rounded-2xl border border-sky-100 bg-gradient-to-r from-white via-sky-50 to-white px-4 py-3 shadow-inner shadow-sky-100/60 sm:py-4">
                {isQuickAddActive ? (
                  <form onSubmit={handleQuickAddSubmit} className="space-y-3">
                    <label className="block text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
                      Quick add ingredient
                      <input
                        ref={quickAddInputRef}
                        value={quickAddDraft}
                        onChange={(event) =>
                          handleQuickAddChange(event.target.value)
                        }
                        placeholder="e.g. 2 cups baby spinach"
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white/90 px-4 py-2 text-sm font-medium text-slate-900 outline-none transition focus:border-rose-400 focus:ring-4 focus:ring-rose-100"
                      />
                    </label>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                      <button
                        type="button"
                        onClick={handleCancelQuickAdd}
                        className="inline-flex items-center justify-center rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-300"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-slate-900/25 transition disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={
                          !quickAddDraft.trim() || !activeOwnerId || isSyncing
                        }
                      >
                        Add item
                      </button>
                    </div>
                    {/* <p className="text-[11px] uppercase tracking-[0.3em] text-slate-400">
                      Type any ingredient you need and we&rsquo;ll keep it with the
                      rest of your list.
                    </p> */}
                    {quickAddError && (
                      <p className="text-xs font-semibold text-rose-600">
                        {quickAddError}
                      </p>
                    )}
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={handleStartQuickAdd}
                    className="w-full rounded-2xl border border-dashed border-sky-200 bg-white/70 px-4 py-3 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-sky-300 hover:text-slate-900"
                  >
                    + Add ingredient
                  </button>
                )}
              </div>
              <div className="mt-4 sm:mt-6">
                {showEmptyState ? (
                  <div className="flex flex-col items-center gap-4 text-center text-slate-500">
                    <div className="text-6xl">🥕</div>
                    <p className="text-lg font-medium">No ingredients yet.</p>
                    <p>
                      Head back, pick a recipe, and we&rsquo;ll slot every
                      ingredient here automatically.
                    </p>
                  </div>
                ) : isSyncing && renderEmptyState ? (
                  <div className="flex flex-col items-center gap-4 text-center text-slate-500">
                    <div className="text-6xl animate-pulse">🛒</div>
                    <p className="text-lg font-medium">Syncing your list…</p>
                  </div>
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={sortableActiveKeys}
                      strategy={verticalListSortingStrategy}
                    >
                      <ul className="space-y-3">
                        <AnimatePresence initial={false} mode="sync">
                          {listElements}
                        </AnimatePresence>
                      </ul>
                    </SortableContext>
                  </DndContext>
                )}
              </div>
            </div>
            <aside className="mt-10 rounded-3xl border border-white/70 bg-white/85 p-6 shadow-xl shadow-slate-200/70 backdrop-blur lg:mt-0">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
                    Pantry staples
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-900">
                    Track what you already own
                  </h2>
                  <p className="mt-2 text-sm text-slate-500">
                    Ingredients saved here stay off your shopping list when you
                    import recipes.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {isAuthenticated ? (
                    <button
                      type="button"
                      onClick={handleRefreshPantry}
                      disabled={isPantrySyncing}
                      className="inline-flex items-center rounded-2xl border border-slate-200 bg-white/70 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isPantrySyncing ? "Refreshing…" : "Refresh"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => signIn()}
                      className="inline-flex items-center rounded-2xl border border-slate-200 bg-white/70 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:text-slate-900"
                    >
                      Sign in
                    </button>
                  )}
                </div>
              </div>
              {isAuthenticated ? (
                <>
                  {pantryItems.length ? (
                    <ul className="mt-6 space-y-3">
                      {pantryItems.map((item) => (
                        <li
                          key={item.id}
                          className="flex flex-col gap-2 rounded-2xl border border-slate-100 bg-white/80 px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {item.label}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              handlePantryRemove(item.id, item.label)
                            }
                            disabled={removingPantryId === item.id}
                            className="inline-flex items-center justify-center rounded-2xl border border-rose-200 px-4 py-2 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-wait disabled:opacity-70"
                          >
                            {removingPantryId === item.id
                              ? "Removing…"
                              : "Remove"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-5 text-sm text-slate-500">
                      No pantry staples yet. Check off ingredients or add one
                      below to start keeping your inventory in sync.
                    </p>
                  )}
                  <form
                    className="mt-6 flex flex-col gap-3 sm:flex-row"
                    onSubmit={handlePantrySubmit}
                  >
                    <div className="flex-1">
                      <label className="sr-only" htmlFor="pantry-add-input">
                        Add pantry staple
                      </label>
                      <input
                        id="pantry-add-input"
                        type="text"
                        value={pantryDraft}
                        onChange={(event) => {
                          setPantryDraft(event.target.value);
                          if (pantryError) {
                            setPantryError(null);
                          }
                        }}
                        placeholder="E.g. 2 Bell Peppers"
                        className="w-full rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50"
                      />
                      {pantryError && (
                        <p className="mt-1 text-xs font-semibold text-rose-600">
                          {pantryError}
                        </p>
                      )}
                    </div>
                    <button
                      type="submit"
                      disabled={isPantrySaving}
                      className="inline-flex items-center justify-center rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-200/70 transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isPantrySaving ? "Saving…" : "Save staple"}
                    </button>
                  </form>
                </>
              ) : (
                <p className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-5 text-sm text-slate-500">
                  Sign in to keep a pantry inventory so recipes automatically
                  skip your staples.
                </p>
              )}
            </aside>
          </div>
        </section>
        {isConfirmingClear && (
          <div className="fixed inset-0 z-60 flex items-center justify-center px-4 py-6">
            <button
              type="button"
              aria-label="Cancel clearing list"
              className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
              onClick={handleCancelClear}
            />
            <div className="relative z-10 w-full max-w-md rounded-3xl border border-white/40 bg-white/95 p-6 text-slate-900 shadow-2xl shadow-rose-200/70">
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
                Clear list
              </p>
              <p className="mt-2 text-lg font-semibold text-slate-900">
                Remove every ingredient?
              </p>
              <p className="mt-1 text-sm text-slate-500">
                This action removes all items from the active shopping list.
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={handleCancelClear}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-600 transition hover:border-slate-300 sm:w-auto"
                >
                  Keep list
                </button>
                <button
                  type="button"
                  onClick={handleConfirmClear}
                  className="w-full rounded-2xl bg-rose-500 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white shadow-lg shadow-rose-200/70 transition hover:bg-rose-600 sm:w-auto"
                >
                  Yes, clear it
                </button>
              </div>
            </div>
          </div>
        )}
        {quantityEditor && editingItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
            <button
              type="button"
              aria-label="Close quantity editor"
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              onClick={cancelQuantityEdit}
            />
            <div className="relative z-10 w-full max-w-lg rounded-3xl border border-white/40 bg-white/95 p-6 text-slate-900 shadow-2xl shadow-rose-200/70">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
                    Adjust quantity
                  </p>
                  <p className="mt-1 text-xl font-semibold text-slate-900">
                    {editingItem.label}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={cancelQuantityEdit}
                  className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-500 transition hover:border-slate-300"
                  aria-label="Close"
                >
                  Close
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Editing {editingItem.unitSummary || "this ingredient"}
              </p>
              <form
                className="mt-4 space-y-4 text-xs"
                onSubmit={handleQuantitySubmit}
              >
                <div className="inline-flex rounded-full border border-slate-200 bg-white/80 text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-500">
                  <button
                    type="button"
                    onClick={activateStructuredMode}
                    aria-pressed={quantityEditor.mode === "structured"}
                    className={`rounded-full px-4 py-1 transition ${
                      quantityEditor.mode === "structured"
                        ? "bg-slate-900 text-white shadow-sm shadow-slate-900/30"
                        : "hover:text-slate-900"
                    }`}
                  >
                    Structured
                  </button>
                  <button
                    type="button"
                    onClick={activateCustomMode}
                    aria-pressed={quantityEditor.mode === "custom"}
                    className={`rounded-full px-4 py-1 transition ${
                      quantityEditor.mode === "custom"
                        ? "bg-slate-900 text-white shadow-sm shadow-slate-900/30"
                        : "hover:text-slate-900"
                    }`}
                  >
                    Custom
                  </button>
                </div>
                {quantityEditor.mode === "structured" ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block font-semibold uppercase tracking-[0.3em] text-slate-400">
                        Amount
                        <input
                          value={quantityEditor.quantity}
                          onChange={(event) =>
                            handleStructuredQuantityChange(event.target.value)
                          }
                          className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none transition focus:border-rose-400 focus:ring-4 focus:ring-rose-100"
                          placeholder="16"
                        />
                      </label>
                      <label className="block font-semibold uppercase tracking-[0.3em] text-slate-400">
                        Unit
                        <select
                          value={quantityEditor.unit}
                          onChange={(event) =>
                            handleStructuredUnitChange(event.target.value)
                          }
                          className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none transition focus:border-rose-400 focus:ring-4 focus:ring-rose-100"
                        >
                          <option value="">No unit</option>
                          {MEASURE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Leave amount empty to fall back to the recipe&rsquo;s
                      original quantity.
                    </p>
                  </>
                ) : (
                  <label className="block font-semibold uppercase tracking-[0.3em] text-slate-400">
                    Custom quantity text
                    <input
                      value={quantityEditor.customDraft}
                      onChange={(event) =>
                        handleCustomDraftChange(event.target.value)
                      }
                      className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none transition focus:border-rose-400 focus:ring-4 focus:ring-rose-100"
                      placeholder="As listed"
                    />
                  </label>
                )}
                {quantityError && (
                  <p className="text-xs font-semibold text-rose-600">
                    {quantityError}
                  </p>
                )}
                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={cancelQuantityEdit}
                    className="w-full rounded-2xl border border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-600 transition hover:border-slate-300 sm:w-auto"
                    disabled={isQuantitySaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="w-full rounded-2xl bg-slate-900 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white shadow-lg shadow-slate-900/25 transition disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                    disabled={isQuantitySaving}
                  >
                    {isQuantitySaving ? "Saving…" : "Save"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
