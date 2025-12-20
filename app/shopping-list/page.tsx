"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { AppNav } from "@/components/app-nav";
import { useCollaborationUI } from "@/components/collaboration-ui-context";
import { useShoppingList } from "@/components/shopping-list-context";
import { useToast } from "@/components/toast-provider";
import {
  getMeasureDisplay,
  MEASURE_OPTIONS,
  normalizeMeasureText,
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

export default function ShoppingListPage() {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";
  const {
    items,
    lists,
    selectedListId,
    removeItem,
    clearList,
    reorderItems,
    updateQuantity,
    totalItems,
    isSyncing,
    externalUpdateNotice,
    acknowledgeExternalUpdate,
  } = useShoppingList();
  const { showToast } = useToast();
  const { refreshCollaborations } = useCollaborationUI();
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [quantityEditor, setQuantityEditor] =
    useState<QuantityEditorState | null>(null);
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [isQuantitySaving, setIsQuantitySaving] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const activeList =
    lists.find((list) => list.ownerId === selectedListId) ?? lists[0] ?? null;
  const activeOwnerId = activeList?.ownerId ?? null;
  const emptyState = items.length === 0;
  const beginDrag = (key: string, event: DragEvent<HTMLLIElement>) => {
    setDraggingKey(key);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
  };

  const finalizeDrag = () => {
    setDraggingKey(null);
  };

  const reorderRelative = (targetKey: string | null, placeAfter: boolean) => {
    if (!draggingKey || !activeOwnerId) return;
    const orderedKeys = items
      .map((item) => item.storageKey)
      .filter((key) => key !== draggingKey);
    if (targetKey === null) {
      orderedKeys.push(draggingKey);
    } else {
      const targetIndex = orderedKeys.indexOf(targetKey);
      if (targetIndex === -1) return;
      const insertIndex = targetIndex + (placeAfter ? 1 : 0);
      orderedKeys.splice(insertIndex, 0, draggingKey);
    }
    reorderItems(orderedKeys, activeOwnerId);
    finalizeDrag();
  };

  const handleItemDrop = (
    event: DragEvent<HTMLLIElement>,
    targetKey: string
  ) => {
    event.preventDefault();
    if (!draggingKey) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const shouldPlaceAfter = event.clientY > rect.top + rect.height / 2;
    reorderRelative(targetKey, shouldPlaceAfter);
  };

  const handleListDrop = (event: DragEvent<HTMLUListElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    if (!draggingKey) return;
    reorderRelative(null, true);
  };

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

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  const heroStatusText = useMemo(() => {
    if (!hasHydrated) {
      return "Loading your list…";
    }
    if (emptyState) {
      return "No ingredients queued yet.";
    }
    return `${totalItems} item${totalItems === 1 ? "" : "s"} ready to shop.`;
  }, [emptyState, hasHydrated, totalItems]);

  const renderItems = hasHydrated ? items : [];
  const renderEmptyState = hasHydrated ? emptyState : true;
  const showEmptyState = renderEmptyState && !isSyncing;
  const clearButtonDisabled =
    !hasHydrated || renderEmptyState || isSyncing || !activeOwnerId;
  const editingItem = quantityEditor
    ? items.find((candidate) => candidate.storageKey === quantityEditor.key) ??
      null
    : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-rose-50 to-white px-4 py-12 text-slate-900">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-10">
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
                onClick={() => clearList(activeOwnerId ?? undefined)}
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
        <section className="rounded-3xl border border-white/70 bg-white/90 p-8 shadow-xl shadow-slate-200/70 backdrop-blur">
          {showEmptyState ? (
            <div className="flex flex-col items-center gap-4 text-center text-slate-500">
              <div className="text-6xl">🥕</div>
              <p className="text-lg font-medium">No ingredients yet.</p>
              <p>
                Head back, pick a recipe, and we&rsquo;ll slot every ingredient
                here automatically.
              </p>
            </div>
          ) : isSyncing && renderEmptyState ? (
            <div className="flex flex-col items-center gap-4 text-center text-slate-500">
              <div className="text-6xl animate-pulse">🛒</div>
              <p className="text-lg font-medium">Syncing your list…</p>
            </div>
          ) : (
            <ul
              className="space-y-3"
              onDragOver={(event) => {
                if (event.target === event.currentTarget) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={handleListDrop}
            >
              {renderItems.map((item) => (
                <li
                  key={item.id}
                  draggable
                  onDragStart={(event) => beginDrag(item.storageKey, event)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => handleItemDrop(event, item.storageKey)}
                  onDragEnd={finalizeDrag}
                  aria-grabbed={draggingKey === item.storageKey}
                  className={`flex flex-col gap-4 cursor-grab rounded-2xl border border-slate-100 bg-white/90 px-5 py-4 shadow-sm shadow-slate-100 transition active:cursor-grabbing sm:flex-row sm:items-center sm:justify-between ${
                    draggingKey === item.storageKey
                      ? "opacity-60 ring-2 ring-rose-200"
                      : "hover:-translate-y-0.5"
                  }`}
                >
                  <div className="w-full flex flex-col gap-3">
                    <p className="text-base font-semibold text-slate-900">
                      {item.label}
                    </p>
                    <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-500">
                      <button
                        type="button"
                        onClick={() =>
                          beginQuantityEdit(item.storageKey, item.unitSummary)
                        }
                        className="inline-flex items-center rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                        title="Adjust quantity"
                      >
                        {item.unitSummary}
                      </button>
                      {quantityEditor?.key === item.storageKey && (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-amber-600">
                          Editing…
                        </span>
                      )}
                    </div>
                    {item.sources.length > 0 && (
                      <p className="text-[11px] uppercase tracking-[0.3em] text-rose-400">
                        From {item.sources.join(" · ")}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      removeItem(item.storageKey, activeOwnerId ?? undefined)
                    }
                    className="w-full rounded-full border border-slate-200 px-4 py-2 text-center text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 transition hover:border-rose-200 hover:text-rose-500 sm:w-auto"
                  >
                    Cross off item
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
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
