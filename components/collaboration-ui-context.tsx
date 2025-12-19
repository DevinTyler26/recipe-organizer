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
import { CollaborationInviteDialog } from "@/components/collaboration-invite-dialog";
import { CollaboratorRosterDialog } from "@/components/collaborator-roster-dialog";
import { useToast } from "@/components/toast-provider";
import type {
  CollaborationRoster,
  CollaboratorSummary,
} from "@/types/collaboration";

type InviteTarget = {
  resourceType: "RECIPE" | "SHOPPING_LIST";
  resourceId: string;
  resourceLabel: string;
  description?: string;
};

type CollaboratorRosterModalConfig = {
  title: string;
  collaborators: CollaboratorSummary[];
  resourceType: "RECIPE" | "SHOPPING_LIST";
  resourceId: string;
  allowRemoval?: boolean;
};

type CollaborationUIContextValue = {
  collaborationRoster: CollaborationRoster | null;
  isCollaborationsLoading: boolean;
  refreshCollaborations: () => Promise<void>;
  openInviteDialog: (target: InviteTarget) => void;
  openRosterDialog: (config: CollaboratorRosterModalConfig) => void;
};

const CollaborationUIContext = createContext<
  CollaborationUIContextValue | undefined
>(undefined);

export function CollaborationUIProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated";
  const { showToast } = useToast();
  const [collaborationRoster, setCollaborationRoster] =
    useState<CollaborationRoster | null>(null);
  const [isCollaborationsLoading, setIsCollaborationsLoading] = useState(false);
  const [inviteTarget, setInviteTarget] = useState<InviteTarget | null>(null);
  const [rosterModal, setRosterModal] =
    useState<CollaboratorRosterModalConfig | null>(null);
  const [removingCollaboratorId, setRemovingCollaboratorId] = useState<
    string | null
  >(null);

  const refreshCollaborations = useCallback(async () => {
    if (!isAuthenticated) {
      setCollaborationRoster(null);
      return;
    }
    setIsCollaborationsLoading(true);
    try {
      const response = await fetch("/api/collaborations", {
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as
        | CollaborationRoster
        | { error?: string }
        | null;
      if (!response.ok || !body || ("error" in body && body.error)) {
        throw new Error(body && "error" in body ? body.error : undefined);
      }
      setCollaborationRoster(body as CollaborationRoster);
    } catch (error) {
      console.error("Failed to load collaboration roster", error);
    } finally {
      setIsCollaborationsLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void refreshCollaborations();
  }, [refreshCollaborations]);

  useEffect(() => {
    if (!isAuthenticated) {
      setInviteTarget(null);
      setRosterModal(null);
      setRemovingCollaboratorId(null);
    }
  }, [isAuthenticated]);

  const openInviteDialog = useCallback((target: InviteTarget) => {
    setInviteTarget(target);
  }, []);

  const openRosterDialog = useCallback(
    (config: CollaboratorRosterModalConfig) => {
      setRosterModal(config);
    },
    []
  );

  const handleInviteSubmit = useCallback(
    async (email: string) => {
      const target = inviteTarget;
      if (!target) {
        throw new Error("Select something to share first");
      }
      const response = await fetch("/api/collaborations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceType: target.resourceType,
          resourceId: target.resourceId,
          email,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to send invite");
      }
      showToast(`Shared ${target.resourceLabel} with ${email}.`);
      void refreshCollaborations();
    },
    [inviteTarget, refreshCollaborations, showToast]
  );

  const handleRemoveCollaborator = useCallback(
    async (collaboratorId: string) => {
      const modalContext = rosterModal;
      if (!modalContext) {
        return;
      }
      setRemovingCollaboratorId(collaboratorId);
      try {
        const response = await fetch("/api/collaborations", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resourceType: modalContext.resourceType,
            resourceId: modalContext.resourceId,
            collaboratorId,
          }),
        });
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(body?.error ?? "Failed to remove collaborator");
        }
        setRosterModal((current) =>
          current
            ? {
                ...current,
                collaborators: current.collaborators.filter(
                  (entry) => entry.id !== collaboratorId
                ),
              }
            : current
        );
        showToast("Collaborator removed.", "info");
        void refreshCollaborations();
      } catch (error) {
        console.error("Failed to remove collaborator", error);
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Unable to remove collaborator.";
        showToast(message, "error");
      } finally {
        setRemovingCollaboratorId(null);
      }
    },
    [refreshCollaborations, rosterModal, showToast]
  );

  const contextValue = useMemo<CollaborationUIContextValue>(
    () => ({
      collaborationRoster,
      isCollaborationsLoading,
      refreshCollaborations,
      openInviteDialog,
      openRosterDialog,
    }),
    [
      collaborationRoster,
      isCollaborationsLoading,
      openInviteDialog,
      openRosterDialog,
      refreshCollaborations,
    ]
  );

  return (
    <CollaborationUIContext.Provider value={contextValue}>
      {children}
      <CollaborationInviteDialog
        open={Boolean(inviteTarget)}
        title={
          inviteTarget?.resourceType === "SHOPPING_LIST"
            ? "Share your shopping list"
            : "Share this recipe"
        }
        description={
          inviteTarget?.description ??
          (inviteTarget?.resourceType === "SHOPPING_LIST"
            ? "Invite someone to edit and organize groceries with you."
            : "Give another cook edit access to this recipe.")
        }
        resourceLabel={inviteTarget?.resourceLabel ?? ""}
        onClose={() => setInviteTarget(null)}
        onSubmit={handleInviteSubmit}
      />
      <CollaboratorRosterDialog
        open={Boolean(rosterModal)}
        title={rosterModal?.title ?? ""}
        collaborators={rosterModal?.collaborators ?? []}
        onClose={() => setRosterModal(null)}
        onRemoveCollaborator={
          rosterModal?.allowRemoval ? handleRemoveCollaborator : undefined
        }
        removingCollaboratorId={removingCollaboratorId}
      />
    </CollaborationUIContext.Provider>
  );
}

export function useCollaborationUI() {
  const context = useContext(CollaborationUIContext);
  if (!context) {
    throw new Error(
      "useCollaborationUI must be used within a CollaborationUIProvider"
    );
  }
  return context;
}
