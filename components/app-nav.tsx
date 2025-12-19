"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signIn, signOut, useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const { lists, selectedListId, selectList, totalItems } = useShoppingList();
  const {
    collaborationRoster,
    isCollaborationsLoading,
    openInviteDialog,
    openRosterDialog,
  } = useCollaborationUI();
  const [isListMenuOpen, setIsListMenuOpen] = useState(false);
  const [isNavMenuOpen, setIsNavMenuOpen] = useState(false);
  const listMenuRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();
  const [hasHydrated, setHasHydrated] = useState(false);
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

  const shoppingListDestinationLabel = activeShoppingList
    ? activeShoppingList.ownerLabel
    : isAuthenticated
    ? "your list"
    : "this device";

  const canShareShoppingList = Boolean(
    isAuthenticated && activeShoppingList?.isSelf && currentUserId
  );

  const shoppingListCollaborators = useMemo(() => {
    if (
      !collaborationRoster?.shoppingList ||
      collaborationRoster.shoppingList.ownerId !== currentUserId
    ) {
      return [];
    }
    return collaborationRoster.shoppingList.collaborators;
  }, [collaborationRoster, currentUserId]);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

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
    const shoppingLabel = hasHydrated
      ? `Shopping list (${totalItems})`
      : "Shopping list";
    return [
      { label: "Recipes", href: "/", show: true },
      {
        label: shoppingLabel,
        href: "/shopping-list",
        show: true,
      },
      { label: "Admin whitelist", href: "/whitelist", show: isAdmin },
    ].filter((item) => item.show);
  }, [hasHydrated, isAdmin, totalItems]);

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
      if (!listMenuRef.current?.contains(event.target as Node)) {
        setIsListMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
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

  return (
    <header
      className={`relative z-50 rounded-3xl border border-white/60 bg-white/90 p-5 shadow-xl shadow-rose-100/50 backdrop-blur ${className}`}
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
          {isAuthenticated && lists.length > 0 && (
            <div className="relative" ref={listMenuRef}>
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
                <div className="absolute left-0 z-50 mt-3 w-72 rounded-3xl border border-slate-100 bg-white/95 p-4 text-sm text-slate-600 shadow-2xl shadow-slate-200/80">
                  {activeShoppingList ? (
                    <>
                      <p className="text-base font-semibold text-slate-900">
                        {shoppingListDestinationLabel}
                      </p>
                      <p className="text-xs text-slate-500">
                        {activeShoppingList.isSelf
                          ? "Owned by you"
                          : `Shared from ${activeShoppingList.ownerLabel}`}
                      </p>
                    </>
                  ) : (
                    <p className="text-slate-500">
                      Select a list to manage it here.
                    </p>
                  )}
                  {lists.length > 1 && (
                    <div className="mt-4 flex flex-col gap-2">
                      {lists.map((list) => {
                        const isSelected =
                          list.ownerId ===
                          (activeShoppingList?.ownerId ?? selectedListId);
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
                        {isCollaborationsLoading
                          ? "Loading…"
                          : "View collaborators"}
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
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-sm font-semibold text-slate-700 shadow-inner shadow-white/60 transition hover:border-slate-300 md:hidden"
            onClick={() => setIsNavMenuOpen((current) => !current)}
            aria-expanded={isNavMenuOpen}
            aria-controls="nav-quick-actions"
          >
            {isNavMenuOpen ? "Close" : "Menu"}
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
  );
}
