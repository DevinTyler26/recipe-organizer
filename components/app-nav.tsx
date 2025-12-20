"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signIn, signOut, useSession } from "next-auth/react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useShoppingList } from "@/components/shopping-list-context";
import { useCollaborationUI } from "@/components/collaboration-ui-context";

type AppNavProps = {
  className?: string;
};

export function AppNav({ className = "" }: AppNavProps) {
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated";
  const isSessionLoading = status === "loading";
  const accountLabel = session?.user?.name || session?.user?.email || "Account";
  const isAdmin = Boolean(session?.user?.isAdmin);
  const currentUserId = session?.user?.id ?? null;
  const {
    lists,
    selectedListId,
    selectList,
    renameList,
    totalItems,
    hasLoadedStoredSelection,
  } = useShoppingList();
  const {
    collaborationRoster,
    isCollaborationsLoading,
    openInviteDialog,
    openRosterDialog,
  } = useCollaborationUI();
  const [isListMenuOpen, setIsListMenuOpen] = useState(false);
  const [isNavMenuOpen, setIsNavMenuOpen] = useState(false);
  const [isEditingListName, setIsEditingListName] = useState(false);
  const [listNameDraft, setListNameDraft] = useState("");
  const [isSavingListName, setIsSavingListName] = useState(false);
  const [listNameError, setListNameError] = useState<string | null>(null);
  const pathname = usePathname();
  const [isOnline, setIsOnline] = useState<boolean | null>(null);

  const activeShoppingList = useMemo(() => {
    if (!lists.length) {
      return null;
    }
    if (selectedListId) {
      const selected = lists.find((list) => list.ownerId === selectedListId);
      if (selected) {
        return selected;
      }
    }
    return lists[0] ?? null;
  }, [lists, selectedListId]);

  const activeListOwnerId = activeShoppingList?.ownerId ?? null;
  const activeListOwnerLabel = activeShoppingList?.ownerLabel ?? "";

  useEffect(() => {
    if (activeListOwnerId) {
      setListNameDraft(activeListOwnerLabel);
    } else {
      setListNameDraft("");
    }
  }, [activeListOwnerId, activeListOwnerLabel]);

  const shoppingListDestinationLabel =
    hasLoadedStoredSelection && activeShoppingList
      ? activeShoppingList.ownerLabel
      : isAuthenticated
      ? "your list"
      : "this device";

  const canShareShoppingList = Boolean(
    hasLoadedStoredSelection &&
      isAuthenticated &&
      activeShoppingList?.isSelf &&
      currentUserId
  );

  const canRenameActiveList = Boolean(
    hasLoadedStoredSelection && activeShoppingList?.isSelf
  );

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const syncOnlineStatus = () => {
      setIsOnline(window.navigator.onLine);
    };
    syncOnlineStatus();
    window.addEventListener("online", syncOnlineStatus);
    window.addEventListener("offline", syncOnlineStatus);
    return () => {
      window.removeEventListener("online", syncOnlineStatus);
      window.removeEventListener("offline", syncOnlineStatus);
    };
  }, []);

  useEffect(() => {
    if (!canRenameActiveList) {
      setIsEditingListName(false);
      setListNameError(null);
    }
  }, [canRenameActiveList]);

  const connectionLabel = useMemo(() => {
    if (!isAuthenticated) {
      return "Local";
    }
    if (isOnline === false) {
      return "Offline";
    }
    return "Synced";
  }, [isAuthenticated, isOnline]);

  const navLinks = useMemo(() => {
    const shoppingLabel = hasLoadedStoredSelection
      ? `Shopping list (${totalItems})`
      : "Shopping list (—)";
    return [
      { label: "Recipes", href: "/", show: true },
      {
        label: shoppingLabel,
        href: "/shopping-list",
        show: true,
      },
      { label: "Admin whitelist", href: "/whitelist", show: isAdmin },
    ].filter((item) => item.show);
  }, [hasLoadedStoredSelection, isAdmin, totalItems]);

  const isRouteActive = (href: string) => {
    if (!pathname) return false;
    if (href === "/") {
      return pathname === "/";
    }
    return pathname.startsWith(href);
  };

  useEffect(() => {
    if (!isListMenuOpen) {
      return;
    }
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest('[data-list-menu-root="true"]')) {
        return;
      }
      setIsListMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isListMenuOpen]);

  useEffect(() => {
    if (!isListMenuOpen) {
      setIsEditingListName(false);
      setListNameError(null);
    }
  }, [isListMenuOpen]);

  const handleInviteClick = () => {
    if (!currentUserId || !activeShoppingList) {
      return;
    }
    setIsListMenuOpen(false);
    openInviteDialog({
      resourceType: "SHOPPING_LIST",
      resourceId: currentUserId,
      resourceLabel: `${activeShoppingList.ownerLabel}'s list`,
      description:
        "Collaborators can add, remove, and reorder items on this list.",
    });
  };

  const handleViewCollaborators = () => {
    if (!currentUserId || !activeShoppingList) {
      return;
    }
    setIsListMenuOpen(false);
    openRosterDialog({
      title: `${activeShoppingList.ownerLabel}'s list`,
      collaborators: shoppingListCollaborators,
      resourceType: "SHOPPING_LIST",
      resourceId: currentUserId,
      allowRemoval: true,
    });
  };

  const handleListRenameSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeShoppingList) {
      return;
    }
    const draft = listNameDraft.trim();
    if (!draft) {
      setListNameError("Enter a list name.");
      return;
    }
    setIsSavingListName(true);
    setListNameError(null);
    try {
      await renameList(activeShoppingList.ownerId, draft);
      setIsEditingListName(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to rename this list.";
      setListNameError(message);
    } finally {
      setIsSavingListName(false);
    }
  };

  const renderListMenuContent = () => (
    <>
      {activeShoppingList ? (
        <>
          <p className="text-base font-semibold text-slate-900">
            {shoppingListDestinationLabel}
          </p>
          <p className="text-xs text-slate-500">
            {activeShoppingList.isSelf
              ? "Owned by you"
              : `Shared from ${
                  activeShoppingList.ownerDisplayName || "a collaborator"
                }`}
          </p>
          {canRenameActiveList && (
            <div className="mt-3 rounded-2xl border border-slate-100 bg-white/80 p-3 text-xs text-slate-600">
              {isEditingListName ? (
                <form className="space-y-2" onSubmit={handleListRenameSubmit}>
                  <label className="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-400">
                    List name
                    <input
                      value={listNameDraft}
                      onChange={(event) => setListNameDraft(event.target.value)}
                      className="rounded-xl border border-slate-200 bg-white/90 px-3 py-2 text-xs font-semibold tracking-[0.1em] text-slate-700 outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
                      disabled={isSavingListName}
                    />
                  </label>
                  {listNameError && (
                    <p className="text-[11px] font-semibold text-rose-500">
                      {listNameError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingListName(false);
                        setListNameError(null);
                        setListNameDraft(activeShoppingList.ownerLabel);
                      }}
                      className="rounded-full border border-slate-200 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-500"
                      disabled={isSavingListName}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="rounded-full bg-slate-900 px-4 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-white disabled:opacity-60"
                      disabled={isSavingListName}
                    >
                      {isSavingListName ? "Saving…" : "Save"}
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setListNameError(null);
                    setIsEditingListName(true);
                  }}
                  className="w-full rounded-full border border-slate-200 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-600 transition hover:border-slate-300"
                >
                  Rename list
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="text-slate-500">Select a list to manage it here.</p>
      )}
      {lists.length > 1 && (
        <div className="mt-4 flex flex-col gap-2">
          {lists.map((list) => {
            const isSelected =
              list.ownerId === (activeShoppingList?.ownerId ?? selectedListId);
            return (
              <button
                key={list.ownerId}
                type="button"
                onClick={() => {
                  selectList(list.ownerId);
                  setIsListMenuOpen(false);
                }}
                className={`rounded-2xl border px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.2em] transition ${
                  isSelected
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                }`}
              >
                {list.ownerLabel}
              </button>
            );
          })}
        </div>
      )}
      {canShareShoppingList && activeShoppingList && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleViewCollaborators}
            disabled={isCollaborationsLoading}
            className={`rounded-2xl border px-3 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition ${
              isCollaborationsLoading
                ? "border-slate-200 text-slate-400"
                : "border-slate-200 text-slate-600 hover:border-slate-300"
            }`}
          >
            {isCollaborationsLoading ? "Loading…" : "View collaborators"}
          </button>
          <button
            type="button"
            onClick={handleInviteClick}
            className="rounded-2xl bg-rose-500 px-3 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-white shadow-lg shadow-rose-200/80 transition hover:scale-[1.01]"
          >
            Invite
          </button>
        </div>
      )}
    </>
  );

  const canShowListControls =
    hasLoadedStoredSelection && isAuthenticated && lists.length > 0;

  const navZClass = canShowListControls && isListMenuOpen ? "z-30" : "z-50";

  return (
    <>
      <header
        className={`relative ${navZClass} rounded-3xl border border-white/60 bg-white/90 p-5 shadow-xl shadow-rose-100/50 backdrop-blur ${className}`}
      >
        <nav className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="flex flex-nowrap items-center gap-4">
            <div className="flex flex-col leading-tight">
              <p className="text-[11px] font-semibold uppercase tracking-[0.35em] text-rose-500">
                Recipe Organizer
              </p>
              <p className="text-base font-semibold text-slate-900">
                {isAuthenticated ? accountLabel : "Guest mode"}
              </p>
              <span className="text-[10px] font-semibold uppercase tracking-[0.35em] text-emerald-500">
                {connectionLabel}
              </span>
            </div>
            {canShowListControls && (
              <div className="relative" data-list-menu-root="true">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={isListMenuOpen}
                  onClick={() => setIsListMenuOpen((current) => !current)}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-left font-semibold text-slate-700 shadow-inner shadow-white/60 transition hover:border-slate-300"
                >
                  <span className="flex flex-col leading-tight">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.35em] text-slate-400">
                      Active list
                    </span>
                    <span className="text-slate-900">
                      {shoppingListDestinationLabel}
                    </span>
                  </span>
                  <svg
                    className={`h-4 w-4 text-slate-500 transition ${
                      isListMenuOpen ? "rotate-180" : ""
                    }`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.585l3.71-3.355a.75.75 0 0 1 1.02 1.1l-4.23 3.83a.75.75 0 0 1-1.02 0l-4.23-3.83a.75.75 0 0 1 .02-1.1z" />
                  </svg>
                </button>
                {isListMenuOpen && (
                  <div className="absolute left-auto right-0 z-50 mt-3 hidden w-[min(18rem,calc(100vw-2rem))] origin-top-right rounded-3xl border border-slate-100 bg-white/95 p-4 text-sm text-slate-600 shadow-2xl shadow-slate-200/80 sm:left-0 sm:right-auto sm:block sm:origin-top-left sm:w-72">
                    {renderListMenuContent()}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-3">
            <div className="hidden items-center gap-6 md:flex">
              {navLinks.map((item) => {
                const active = isRouteActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`text-sm font-semibold transition ${
                      active
                        ? "text-slate-900 underline decoration-2 decoration-rose-400"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                );
              })}
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
                className="text-sm font-semibold text-slate-600 transition hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isAuthenticated ? "Sign out" : "Sign in with Google"}
              </button>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white/80 p-2 text-slate-600 shadow-inner shadow-white/70 transition hover:border-slate-300 md:hidden"
              onClick={() => setIsNavMenuOpen((current) => !current)}
              aria-expanded={isNavMenuOpen}
              aria-controls="nav-quick-actions"
              aria-label={
                isNavMenuOpen ? "Close navigation menu" : "Open navigation menu"
              }
              title={isNavMenuOpen ? "Close" : "Menu"}
            >
              <span className="sr-only">
                {isNavMenuOpen ? "Close menu" : "Open menu"}
              </span>
              <span
                aria-hidden="true"
                className="flex flex-col items-center gap-1"
              >
                <span className="h-1 w-1 rounded-full bg-current" />
                <span className="h-1 w-1 rounded-full bg-current" />
                <span className="h-1 w-1 rounded-full bg-current" />
              </span>
            </button>
          </div>
        </nav>
        {isNavMenuOpen && (
          <div
            id="nav-quick-actions"
            className="mt-3 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/95 p-4 text-sm text-slate-700 md:hidden"
          >
            <div className="flex flex-col gap-2">
              {navLinks.map((item) => {
                const active = isRouteActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setIsNavMenuOpen(false)}
                    className={`text-base font-semibold transition ${
                      active
                        ? "text-slate-900"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
            <p className="text-xs text-slate-500">
              {isAuthenticated
                ? "Recipes and lists back up automatically across your devices."
                : "We will sync this library across devices when you sign in."}
            </p>
            <button
              type="button"
              disabled={isSessionLoading}
              onClick={() => {
                if (isAuthenticated) {
                  void signOut();
                } else {
                  void signIn("google");
                }
                setIsNavMenuOpen(false);
              }}
              className="text-sm font-semibold text-slate-600 transition hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isAuthenticated ? "Sign out" : "Sign in with Google"}
            </button>
          </div>
        )}
      </header>
      {canShowListControls && isListMenuOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center px-4 py-6 sm:hidden">
          <div
            role="presentation"
            aria-label="Close active list menu"
            className="absolute inset-0 z-0 cursor-pointer bg-slate-900/60 backdrop-blur-sm"
            onClick={() => setIsListMenuOpen(false)}
          />
          <div
            className="relative z-10 w-full max-w-md rounded-3xl border border-white/60 bg-white/95 p-5 text-sm text-slate-600 shadow-2xl shadow-slate-200/80"
            data-list-menu-root="true"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-slate-400">
                Active list
              </p>
              <button
                type="button"
                onClick={() => setIsListMenuOpen(false)}
                className="rounded-full border border-slate-200 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-500"
              >
                Close
              </button>
            </div>
            <div className="mt-3 space-y-4">{renderListMenuContent()}</div>
          </div>
        </div>
      )}
    </>
  );
}
