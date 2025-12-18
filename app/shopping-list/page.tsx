"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useState, type DragEvent } from "react";
import { useShoppingList } from "@/components/shopping-list-context";

export default function ShoppingListPage() {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";
  const {
    items,
    removeItem,
    clearList,
    reorderItems,
    totalItems,
    isSyncing,
    isRemote,
  } = useShoppingList();
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const emptyState = items.length === 0;
  const showEmptyState = emptyState && !isSyncing;
  const syncStatusLabel = isAuthenticated
    ? isRemote
      ? "Synced to your account"
      : "Syncing your account list"
    : "Local to this device";

  const beginDrag = (key: string, event: DragEvent<HTMLLIElement>) => {
    setDraggingKey(key);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
  };

  const finalizeDrag = () => {
    setDraggingKey(null);
  };

  const reorderRelative = (targetKey: string | null, placeAfter: boolean) => {
    if (!draggingKey) return;
    const orderedKeys = items
      .map((item) => item.key)
      .filter((key) => key !== draggingKey);
    if (targetKey === null) {
      orderedKeys.push(draggingKey);
    } else {
      const targetIndex = orderedKeys.indexOf(targetKey);
      if (targetIndex === -1) return;
      const insertIndex = targetIndex + (placeAfter ? 1 : 0);
      orderedKeys.splice(insertIndex, 0, draggingKey);
    }
    reorderItems(orderedKeys);
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-rose-50 to-white px-4 py-12 text-slate-900">
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-10">
        <header className="rounded-3xl border border-white/60 bg-white/85 p-8 shadow-xl shadow-rose-100/60 backdrop-blur">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-rose-500">
            Shopping list
          </p>
          <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-4xl font-semibold text-slate-900">
                All your ingredients in one pulse.
              </h1>
              <p className="mt-2 text-base text-slate-600">
                {isSyncing
                  ? "Syncing your latest shopping list entries..."
                  : emptyState
                  ? "Select a recipe on the home page to populate your list."
                  : "Tap an item when you drop it in the cart or clear everything once you&rsquo;re done cooking."}
              </p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-[0.3em] text-amber-500">
                {syncStatusLabel}
              </p>
            </div>
            <div className="flex gap-3">
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white/70 px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm shadow-white/60 transition hover:border-slate-300"
              >
                Back to recipes
              </Link>
              <button
                type="button"
                onClick={clearList}
                disabled={emptyState || isSyncing}
                className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-900/25 transition disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isSyncing ? "Syncing…" : `Clear list (${totalItems})`}
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
          ) : isSyncing && emptyState ? (
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
              {items.map((item) => (
                <li
                  key={item.key}
                  draggable
                  onDragStart={(event) => beginDrag(item.key, event)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => handleItemDrop(event, item.key)}
                  onDragEnd={finalizeDrag}
                  aria-grabbed={draggingKey === item.key}
                  className={`flex cursor-grab items-center justify-between rounded-2xl border border-slate-100 bg-white/90 px-5 py-4 shadow-sm shadow-slate-100 transition active:cursor-grabbing ${
                    draggingKey === item.key
                      ? "opacity-60 ring-2 ring-rose-200"
                      : "hover:-translate-y-0.5"
                  }`}
                >
                  <div>
                    <p className="text-base font-semibold text-slate-900">
                      {item.label}
                    </p>
                    <p className="text-xs font-semibold text-slate-500">
                      {item.unitSummary}
                    </p>
                    {item.sources.length > 0 && (
                      <p className="text-[11px] uppercase tracking-[0.3em] text-rose-400">
                        From {item.sources.join(" · ")}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(item.key)}
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
