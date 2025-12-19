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
import { formatCollaboratorLabel } from "@/lib/collaborator-label";

export default function ShoppingListPage() {
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated";
  const {
    items,
    lists,
    selectedListId,
    selectList,
    removeItem,
    clearList,
    reorderItems,
    updateQuantity,
    totalItems,
    isSyncing,
    isRemote,
    externalUpdateNotice,
    acknowledgeExternalUpdate,
  } = useShoppingList();
  const { showToast } = useToast();
  const {
    collaborationRoster,
    isCollaborationsLoading,
    refreshCollaborations,
    openInviteDialog,
  } = useCollaborationUI();
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [quantityEditor, setQuantityEditor] = useState<{
    key: string;
    ownerId: string | null;
    draft: string;
  } | null>(null);
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [isQuantitySaving, setIsQuantitySaving] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const activeList =
    lists.find((list) => list.ownerId === selectedListId) ?? lists[0] ?? null;
  const activeOwnerId = activeList?.ownerId ?? null;
  const activeListLabel =
    activeList?.ownerLabel ?? (isAuthenticated ? "Your list" : "This device");
  const currentUserId = session?.user?.id ?? null;
  const canShareActiveList = Boolean(
    isAuthenticated && activeList?.isSelf && currentUserId
  );
  const shoppingListCollaborators =
    canShareActiveList &&
    collaborationRoster?.shoppingList?.ownerId === currentUserId
      ? collaborationRoster.shoppingList.collaborators
      : [];
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
      setQuantityEditor({
        key: storageKey,
        ownerId: activeOwnerId,
        draft: unitSummary === "—" ? "" : unitSummary,
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

  const handleQuantityDraftChange = useCallback((value: string) => {
    setQuantityEditor((current) =>
      current ? { ...current, draft: value } : current
    );
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
        await updateQuantity(
          quantityEditor.key,
          quantityEditor.draft,
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
  const renderLists = hasHydrated ? lists : [];
  const renderActiveList = hasHydrated ? activeList : null;
  const renderEmptyState = hasHydrated ? emptyState : true;
  const renderCanShareActiveList = hasHydrated ? canShareActiveList : false;
  const showEmptyState = renderEmptyState && !isSyncing;
  const totalItemsLabel = hasHydrated
    ? `${totalItems} item${totalItems === 1 ? "" : "s"}`
    : "—";
  const clearButtonDisabled =
    !hasHydrated || renderEmptyState || isSyncing || !activeOwnerId;

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
          {renderActiveList && (
            <>
              <div className="mt-6 rounded-2xl border border-slate-100 bg-white/80 p-4 text-sm text-slate-600 shadow-inner shadow-white/60">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400">
                      Active list
                    </p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                      {activeListLabel}
                      {!renderActiveList.isSelf && (
                        <span className="ml-3 rounded-full bg-rose-100 px-3 py-0.5 text-[10px] font-semibold uppercase tracking-[0.3em] text-rose-500">
                          Shared
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2 text-right">
                    <p className="text-xs font-semibold text-slate-500">
                      {totalItemsLabel}
                    </p>
                    {renderCanShareActiveList && (
                      <button
                        type="button"
                        onClick={() => {
                          if (!currentUserId || !renderActiveList) {
                            return;
                          }
                          openInviteDialog({
                            resourceType: "SHOPPING_LIST",
                            resourceId: currentUserId,
                            resourceLabel: renderActiveList.ownerLabel,
                            description:
                              "Collaborators can add, remove, and reorder items on this list.",
                          });
                        }}
                        className="rounded-full border border-rose-200 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.3em] text-rose-500 transition hover:bg-rose-50"
                      >
                        Invite collaborator
                      </button>
                    )}
                  </div>
                </div>
                {renderLists.length > 1 && (
                  <div className="mt-4 flex flex-wrap gap-3">
                    {renderLists.map((list) => {
                      const isSelected = list.ownerId === activeOwnerId;
                      return (
                        <button
                          key={list.ownerId}
                          type="button"
                          onClick={() => selectList(list.ownerId)}
                          className={`flex flex-col rounded-2xl border px-4 py-3 text-left shadow-sm transition ${
                            isSelected
                              ? "border-rose-300 bg-rose-50/80 text-rose-700"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                          }`}
                        >
                          <span className="text-sm font-semibold text-slate-900">
                            {list.ownerLabel}
                            {!list.isSelf && (
                              <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-rose-500">
                                Shared
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-slate-500">
                            {list.totalItems} item
                            {list.totalItems === 1 ? "" : "s"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {renderCanShareActiveList && (
                <div className="mt-4 rounded-2xl border border-rose-100 bg-rose-50/70 p-4 text-xs text-rose-600">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-rose-400">
                    Collaborators
                  </p>
                  {isCollaborationsLoading ? (
                    <p className="mt-2 text-rose-400">Loading roster…</p>
                  ) : shoppingListCollaborators.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {shoppingListCollaborators.map((collaborator) => (
                        <span
                          key={`shopping-list-page-collaborator-${collaborator.id}`}
                          className="rounded-full border border-rose-100 bg-white/80 px-3 py-1 text-[11px] font-semibold text-rose-600 shadow-inner shadow-white/60"
                        >
                          {formatCollaboratorLabel(collaborator)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-rose-400">
                      Only you can edit this list right now.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
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
                  className={`flex cursor-grab items-center justify-between rounded-2xl border border-slate-100 bg-white/90 px-5 py-4 shadow-sm shadow-slate-100 transition active:cursor-grabbing ${
                    draggingKey === item.storageKey
                      ? "opacity-60 ring-2 ring-rose-200"
                      : "hover:-translate-y-0.5"
                  }`}
                >
                  <div>
                    <p className="text-base font-semibold text-slate-900">
                      {item.label}
                    </p>
                    {quantityEditor?.key === item.storageKey ? (
                      <form
                        className="mt-2 space-y-2 text-xs"
                        onSubmit={handleQuantitySubmit}
                      >
                        <label className="block font-semibold uppercase tracking-[0.3em] text-slate-400">
                          Needed quantity
                          <input
                            value={quantityEditor.draft}
                            onChange={(event) =>
                              handleQuantityDraftChange(event.target.value)
                            }
                            className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none transition focus:border-rose-400 focus:ring-4 focus:ring-rose-100"
                            placeholder="As listed"
                          />
                        </label>
                        {quantityError && (
                          <p className="text-xs font-semibold text-rose-600">
                            {quantityError}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={cancelQuantityEdit}
                            className="rounded-2xl border border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-600 transition hover:border-slate-300"
                            disabled={isQuantitySaving}
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="rounded-2xl bg-slate-900 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white shadow-lg shadow-slate-900/25 transition disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={isQuantitySaving}
                          >
                            {isQuantitySaving ? "Saving…" : "Save"}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-500">
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
                      </div>
                    )}
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
                    className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 transition hover:border-rose-200 hover:text-rose-500"
                  >
                    Cross off item
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
