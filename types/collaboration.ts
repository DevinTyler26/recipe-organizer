export type CollaboratorSummary = {
  id: string;
  name: string | null;
  email: string | null;
};

export type RecipeCollaborationRosterEntry = {
  resourceId: string;
  resourceLabel: string;
  collaborators: CollaboratorSummary[];
};

export type ShoppingListCollaborationRoster = {
  ownerId: string;
  ownerLabel: string;
  collaborators: CollaboratorSummary[];
};

export type CollaborationRoster = {
  recipes: RecipeCollaborationRosterEntry[];
  shoppingList: ShoppingListCollaborationRoster | null;
};
