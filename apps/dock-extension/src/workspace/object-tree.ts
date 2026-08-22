import type { WorkspaceElement } from '../shared/workspace-protocol';

export type ObjectTreeMode = 'edit' | 'full';

export type ObjectTreeObjectRow = {
  kind: 'object';
  element: WorkspaceElement;
  depth: number;
  actualDepth: number;
  ancestorIds: string[];
};

export type ObjectTreeCompressionRow = {
  kind: 'compression';
  key: string;
  depth: number;
  actualDepth: number;
  count: number;
  hiddenIds: string[];
  terminalId: string;
  ancestorIds: string[];
  expanded: boolean;
};

export type ObjectTreeRow = ObjectTreeObjectRow | ObjectTreeCompressionRow;

export type ObjectTreeRowsOptions = {
  mode: ObjectTreeMode;
  expandedIds: ReadonlySet<string>;
  expandedCompressionKeys?: ReadonlySet<string>;
  selectedIds?: readonly string[];
  filter?: string;
};

const EDIT_TREE_SELECTED_TAIL_LENGTH = 1;

const layoutContainerTags = new Set([
  'div',
  'span',
  'main',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'aside',
]);

/**
 * The edit tree is an operational projection rather than a DOM mirror. A
 * loaded, non-root layout container with one effective child adds depth but
 * no editing choice, so it can be represented by a path-compression row.
 * Labels are intentionally not part of this decision: real pages commonly
 * assign semantic names to every wrapper in an otherwise linear chain.
 */
export const isEditTreeWrapper = (element: WorkspaceElement, childCount: number) =>
  Boolean(element.parentId) &&
  layoutContainerTags.has(element.tag.toLowerCase()) &&
  element.role === '元素' &&
  element.capability !== 'direct' &&
  element.hasChildren &&
  element.childrenLoaded !== false &&
  childCount === 1;

const matchesFilter = (element: WorkspaceElement, filter: string) =>
  `${element.label} ${element.role} ${element.tag} ${element.text}`.toLowerCase().includes(filter);

const createIndex = (elements: WorkspaceElement[]) => {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const children = new Map<string | undefined, WorkspaceElement[]>();
  elements.forEach((element) => {
    const list = children.get(element.parentId) ?? [];
    list.push(element);
    children.set(element.parentId, list);
  });
  return { byId, children };
};

const compressionFor = (
  start: WorkspaceElement,
  children: ReadonlyMap<string | undefined, WorkspaceElement[]>,
) => {
  const hidden: WorkspaceElement[] = [];
  const visited = new Set<string>();
  let current = start;
  while (!visited.has(current.id)) {
    visited.add(current.id);
    const directChildren = children.get(current.id) ?? [];
    if (!isEditTreeWrapper(current, directChildren.length)) break;
    hidden.push(current);
    current = directChildren[0]!;
  }
  return hidden.length >= 2 ? { hidden, terminal: current } : null;
};

const objectRow = (
  element: WorkspaceElement,
  depth: number,
  ancestorIds: string[],
): ObjectTreeObjectRow => ({
  kind: 'object',
  element,
  depth,
  actualDepth: element.depth,
  ancestorIds,
});

export const buildObjectTreeRows = (
  elements: WorkspaceElement[],
  options: ObjectTreeRowsOptions,
): ObjectTreeRow[] => {
  const { byId, children } = createIndex(elements);
  const filter = options.filter?.trim().toLowerCase() ?? '';
  if (filter)
    return elements
      .filter((element) => matchesFilter(element, filter))
      .map((element) => objectRow(element, 0, []));

  const rows: ObjectTreeRow[] = [];
  const selectedIds = new Set(options.selectedIds ?? []);
  const expandedCompressionKeys = options.expandedCompressionKeys ?? new Set<string>();

  const appendObject = (
    element: WorkspaceElement,
    depth: number,
    ancestorIds: string[],
    allowCompression = true,
  ) => {
    const directChildren = children.get(element.id) ?? [];
    const compression =
      options.mode === 'edit' && allowCompression ? compressionFor(element, children) : null;

    if (compression) {
      const hiddenIds = compression.hidden.map((item) => item.id);
      const key = hiddenIds.join('>');
      const expanded =
        expandedCompressionKeys.has(key) || hiddenIds.some((id) => selectedIds.has(id));
      rows.push({
        kind: 'compression',
        key,
        depth,
        actualDepth: compression.hidden[0]?.depth ?? element.depth,
        count: compression.hidden.length,
        hiddenIds,
        terminalId: compression.terminal.id,
        ancestorIds,
        expanded,
      });

      if (expanded) {
        let visibleAncestors = [...ancestorIds];
        compression.hidden.forEach((hidden, index) => {
          rows.push(objectRow(hidden, depth + index + 1, visibleAncestors));
          visibleAncestors = [...visibleAncestors, hidden.id];
        });
        appendObject(compression.terminal, depth + compression.hidden.length + 1, visibleAncestors);
      } else {
        appendObject(compression.terminal, depth + 1, [...ancestorIds, ...hiddenIds]);
      }
      return;
    }

    rows.push(objectRow(element, depth, ancestorIds));
    if (!element.hasChildren || !options.expandedIds.has(element.id)) return;
    directChildren.forEach((child) => appendObject(child, depth + 1, [...ancestorIds, element.id]));
  };

  const primarySelectedId = options.selectedIds?.at(-1);
  const selectedPath: WorkspaceElement[] = [];
  const selectedPathVisited = new Set<string>();
  let selectedPathElement = primarySelectedId ? byId.get(primarySelectedId) : undefined;
  while (selectedPathElement && !selectedPathVisited.has(selectedPathElement.id)) {
    selectedPathVisited.add(selectedPathElement.id);
    selectedPath.unshift(selectedPathElement);
    selectedPathElement = selectedPathElement.parentId
      ? byId.get(selectedPathElement.parentId)
      : undefined;
  }

  const hiddenSelectedAncestors = selectedPath.slice(0, -EDIT_TREE_SELECTED_TAIL_LENGTH);
  const selectedContextRoot = selectedPath.at(-EDIT_TREE_SELECTED_TAIL_LENGTH);
  if (
    options.mode === 'edit' &&
    selectedContextRoot &&
    hiddenSelectedAncestors.length >= 1
  ) {
    const hiddenIds = hiddenSelectedAncestors.map((element) => element.id);
    const key = `selected>${hiddenIds.join('>')}`;
    const expanded = expandedCompressionKeys.has(key);
    rows.push({
      kind: 'compression',
      key,
      depth: 0,
      actualDepth: hiddenSelectedAncestors[0]?.depth ?? 0,
      count: hiddenIds.length,
      hiddenIds,
      terminalId: selectedContextRoot.id,
      ancestorIds: [],
      expanded,
    });

    if (expanded) {
      let visibleAncestors: string[] = [];
      hiddenSelectedAncestors.forEach((element, index) => {
        rows.push(objectRow(element, index + 1, visibleAncestors));
        visibleAncestors = [...visibleAncestors, element.id];
      });
      const directParent = hiddenSelectedAncestors.at(-1);
      const contextPeers = directParent
        ? (children.get(directParent.id) ?? [selectedContextRoot])
        : [selectedContextRoot];
      contextPeers.forEach((element) =>
        appendObject(element, hiddenSelectedAncestors.length + 1, visibleAncestors, false),
      );
    } else {
      const contextPeers = selectedContextRoot.parentId
        ? (children.get(selectedContextRoot.parentId) ?? [selectedContextRoot])
        : [selectedContextRoot];
      contextPeers.forEach((element) => appendObject(element, 1, hiddenIds, false));
    }
    return rows;
  }

  const roots = elements.filter((element) => !element.parentId || !byId.has(element.parentId));
  roots.forEach((root) => appendObject(root, 0, []));
  return rows;
};

export const objectTreePathFor = (
  elements: WorkspaceElement[],
  objectId: string | undefined,
): WorkspaceElement[] => {
  if (!objectId) return [];
  const { byId } = createIndex(elements);
  const path: WorkspaceElement[] = [];
  const visited = new Set<string>();
  let current = byId.get(objectId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
};
