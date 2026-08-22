export type WorkspaceTarget = {
  editId?: string;
  fallbackSelector?: string;
  /**
   * Identifies one logical direct-text fragment owned by the matched element.
   * The historical field name is retained for protocol compatibility; the
   * index is not an individual DOM Text-node index. Comments, whitespace-only
   * nodes, hidden/out-of-flow children, and dianjing fragment wrappers do not
   * split the logical fragment.
   */
  textNodeIndex?: number;
};

export const workspaceTargetKey = (target: WorkspaceTarget) => {
  const base = target.editId
    ? `edit:${target.editId}`
    : `selector:${target.fallbackSelector ?? ''}`;
  return target.textNodeIndex === undefined ? base : `${base}::text:${target.textNodeIndex}`;
};

export const workspaceTargetFromKey = (key: string): WorkspaceTarget | null => {
  const textMatch = key.match(/::text:(\d+)$/);
  const textNodeIndex = textMatch ? Number(textMatch[1]) : undefined;
  const base = textMatch ? key.slice(0, -textMatch[0].length) : key;
  if (base.startsWith('edit:')) {
    const editId = base.slice('edit:'.length);
    return editId ? { editId, ...(textNodeIndex === undefined ? {} : { textNodeIndex }) } : null;
  }
  if (base.startsWith('selector:')) {
    const fallbackSelector = base.slice('selector:'.length);
    return fallbackSelector
      ? { fallbackSelector, ...(textNodeIndex === undefined ? {} : { textNodeIndex }) }
      : null;
  }
  return null;
};

export type WorkspaceObjectCapability = 'direct' | 'whole-object' | 'style-only' | 'unstable';

export type WorkspaceValueSource = 'inline' | 'computed' | 'observed' | 'unknown';

export type WorkspaceElement = {
  id: string;
  target: WorkspaceTarget;
  parentId?: string;
  hasChildren: boolean;
  /** Whether the current state contains the complete direct-child list. */
  childrenLoaded?: boolean;
  depth: number;
  tag: string;
  label: string;
  role: string;
  text: string;
  capability: WorkspaceObjectCapability;
  styles: Record<string, string>;
};

/**
 * The complete, lightweight object index used for canvas selection and
 * navigation. `WorkspacePageState.elements` remains a render projection for
 * the current tree expansion; this index must not be pruned with that view.
 */
export type WorkspaceSelectableTarget = {
  id: string;
  target: WorkspaceTarget;
  parentId?: string;
  hasChildren: boolean;
  depth: number;
  tag: string;
  label: string;
  role: string;
  text: string;
  regionId?: string;
  regionLabel?: string;
};

export type WorkspaceHistoryEntry = {
  id: string;
  label: string;
  targetLabel: string;
  createdAt: string;
  kind?: 'text' | 'style' | 'structure' | 'layout';
  property?: string;
  before?: string;
  after?: string;
  beforeSource?: WorkspaceValueSource;
  semanticPath?: string;
  target?: WorkspaceTarget;
  textNodeIndex?: number;
  cancelled?: boolean;
};

export type WorkspacePageState = {
  sessionId?: string;
  sourceTabId?: number;
  url: string;
  title: string;
  capabilityLabel: string;
  capabilityStatus: string;
  selectedIds: string[];
  elements: WorkspaceElement[];
  selectableTargets?: WorkspaceSelectableTarget[];
  history: WorkspaceHistoryEntry[];
  futureCount: number;
  snapshotHtml: string;
  notice: string;
  capturedAt: string;
  /**
   * The source page viewport at the time the workspace state was captured.
   * This is intentionally optional so older content-script sessions and
   * fixtures can still be consumed by the workspace.
   */
  canvas?: {
    width: number;
    height: number;
  };
};

export type WorkspaceExportProgress = {
  stage: 'scan' | 'canvas' | 'styles' | 'resources' | 'finalize';
  completed: number;
  total: number;
  label: string;
};

export type WorkspaceGuide = {
  orientation: 'vertical' | 'horizontal';
  position: number;
};

export type WorkspaceChange = {
  target: WorkspaceTarget;
  kind: 'text' | 'style';
  property: string;
  textNodeIndex?: number;
  after: string;
  label: string;
};

export type WorkspaceCommand =
  | { action: 'get-state'; expandedTargets?: WorkspaceTarget[] }
  | { action: 'select'; targets: WorkspaceTarget[] }
  | { action: 'change'; change: WorkspaceChange }
  | {
      action: 'align';
      targets: WorkspaceTarget[];
      alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
      guide?: WorkspaceGuide;
    }
  | { action: 'distribute'; targets: WorkspaceTarget[]; direction: 'horizontal' | 'vertical' }
  | {
      action: 'gap';
      targets: WorkspaceTarget[];
      direction: 'horizontal' | 'vertical';
      value: number;
    }
  | { action: 'size'; targets: WorkspaceTarget[]; dimension: 'width' | 'height' | 'both' }
  | { action: 'group'; targets: WorkspaceTarget[] }
  | {
      action: 'place';
      target: WorkspaceTarget;
      destination: WorkspaceTarget;
      position: 'before' | 'after' | 'inside';
    }
  | {
      action: 'place-many';
      targets: WorkspaceTarget[];
      destination: WorkspaceTarget;
      position: 'before' | 'after' | 'inside';
    }
  | { action: 'undo' }
  | { action: 'redo' }
  | { action: 'cancel-history'; id: string }
  | { action: 'move'; target: WorkspaceTarget; delta: -1 | 1 }
  | { action: 'duplicate'; target: WorkspaceTarget }
  | { action: 'delete'; target: WorkspaceTarget }
  | { action: 'move-text'; target: WorkspaceTarget; deltaX: number; deltaY: number }
  | { action: 'export-html' };

export type WorkspaceSourceMode = 'local-page' | 'web-copy';

export type WorkspaceSessionRecord = {
  sessionId: string;
  sourceTabId: number;
  workspaceTabId?: number;
  sourceUrl: string;
  sourceTitle: string;
  sourceMode: WorkspaceSourceMode;
  createdAt: string;
};
