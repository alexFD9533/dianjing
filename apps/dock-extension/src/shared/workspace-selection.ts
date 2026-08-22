export type WorkspaceSelectionItem = { id: string };

export const availableWorkspaceSelectionIds = (
  ids: readonly string[],
  elements: readonly WorkspaceSelectionItem[],
) => {
  const availableIds = new Set(elements.map((element) => element.id));
  return ids.filter((id) => availableIds.has(id));
};

/**
 * Keeps the workspace's local selection while it is still valid, then falls
 * back to the source page selection. Invalid source IDs must never be revived.
 */
export const reconcileWorkspaceSelectionIds = (
  currentIds: readonly string[],
  sourceIds: readonly string[],
  elements: readonly WorkspaceSelectionItem[],
) => {
  const current = availableWorkspaceSelectionIds(currentIds, elements);
  return current.length ? current : availableWorkspaceSelectionIds(sourceIds, elements);
};
