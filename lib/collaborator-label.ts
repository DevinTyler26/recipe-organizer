import type { CollaboratorSummary } from "@/types/collaboration";

export const formatCollaboratorLabel = (
  collaborator: CollaboratorSummary
): string => collaborator.name?.trim() || collaborator.email || "Unnamed collaborator";
