import type {
  WorkspaceCommand,
  WorkspaceChange,
  WorkspaceElement,
  WorkspaceExportProgress,
  WorkspaceGuide,
  WorkspacePageState,
  WorkspaceSelectableTarget,
  WorkspaceTarget,
} from '../shared/workspace-protocol';
import { workspaceTargetFromKey, workspaceTargetKey } from '../shared/workspace-protocol';
import { reconcileWorkspaceSelectionIds } from '../shared/workspace-selection';
import { textFragmentClientRect } from '../content/text-fragment';
import {
  materializeWorkspaceLayoutHandle,
  resolveWorkspaceTargetHandle,
} from '../shared/workspace-target';
import {
  buildAiPromptPacket,
  type PromptOperationInput,
  type PromptOperationKind,
} from '../shared/ai-prompt';
import { prepareLocalHtmlDocument } from '../shared/local-html-document';
import { objectMovePosition, type ObjectMovePosition } from '../shared/object-position';
import { buildObjectTreeRows, objectTreePathFor, type ObjectTreeMode } from './object-tree';
import './style.css';

type WorkspaceResponse = {
  ok: boolean;
  state?: WorkspacePageState;
  html?: string;
  error?: string;
  warnings?: string[];
  session?: { sourceTabId: number; sourceMode?: 'local-page' | 'web-copy' };
};

const searchParams = new URLSearchParams(location.search);
const sessionId = searchParams.get('session') ?? '';
const entryMode = searchParams.get('entry') ?? '';
const entryReason = searchParams.get('reason') ?? '';
const app = document.querySelector<HTMLDivElement>('#app')!;
let pageState: WorkspacePageState | null = null;
let selectedIds: string[] = [];
let activeInspector: 'object' | 'history' | 'delivery' = 'object';
let activeTask: 'properties' | 'layout' = 'properties';
let filter = '';
let treeMode: ObjectTreeMode = 'edit';
const expandedIds = new Set<string>();
const expandedCompressionKeys = new Set<string>();
const knownTreeRootIds = new Set<string>();
const scheduledChanges = new Map<string, { timer: number; change: WorkspaceChange }>();
const pendingRelativePositionIds = new Set<string>();
let changeQueue: Promise<void> = Promise.resolve();
let selectionQueue: Promise<void> = Promise.resolve();
let selectionRequestId = 0;
let lastStableSelectionIds: string[] = [];
let lastStablePageState: WorkspacePageState | null = null;
let guidesEnabled = false;
type WorkspaceGuideState = WorkspaceGuide & { id: string };
let workspaceGuides: WorkspaceGuideState[] = [];
let currentGuideId: string | null = null;
let guideSequence = 0;
let rulerPreview: { orientation: WorkspaceGuide['orientation']; position: number } | null = null;
let rulerDragStart: {
  orientation: WorkspaceGuide['orientation'];
  pointerId: number;
} | null = null;
let canvasMode: 'select' | 'pan' = 'select';
let draggedId: string | null = null;
let draggedTreeIds: string[] = [];
let localFileName = '';
let localSourceActive = false;
let webCopyMode = false;
let deletePendingId: string | null = null;
let exportProgress: WorkspaceExportProgress | null = null;
let exportReport: { tone: 'complete' | 'failed'; message: string } | null = null;
let exportingHtml = false;
let promptCopyStatus: 'idle' | 'copying' | 'success' | 'error' = 'idle';

type LocalCanvasWindow = Window & {
  __dianjingWorkspaceCommand?: (
    command: WorkspaceCommand,
    onProgress?: (progress: WorkspaceExportProgress) => void,
  ) => Promise<WorkspaceResponse>;
};

function receiveExportProgress(progress: WorkspaceExportProgress) {
  if (!exportingHtml) return;
  exportProgress = progress;
  if (activeInspector === 'delivery') renderInspector();
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );

const request = async (command: WorkspaceCommand): Promise<WorkspaceResponse> => {
  if (localSourceActive) {
    const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
    const canvasWindow = frame?.contentWindow as LocalCanvasWindow | null;
    const bridge = canvasWindow?.__dianjingWorkspaceCommand;
    if (!bridge) return { ok: false, error: '本地文件画布尚未准备完成，请稍后重试' };
    const response = await bridge(
      command,
      command.action === 'export-html' ? receiveExportProgress : undefined,
    );
    if (response.state) {
      response.state.title ||= localFileName.replace(/\.html?$/i, '') || '本地 HTML';
      response.state.url = `本地文件 · ${localFileName}`;
    }
    return response;
  }
  if (!sessionId) return { ok: false, error: '缺少工作台会话，请从 Dock 重新进入' };
  return chrome.runtime.sendMessage({ type: 'workspace/request', sessionId, command });
};

const selectedElements = () =>
  selectedIds
    .map((id) => pageState?.elements.find((element) => element.id === id))
    .filter((element): element is WorkspaceElement => Boolean(element));

const primaryElement = () => selectedElements().at(-1);

const selectableTargets = (): WorkspaceSelectableTarget[] =>
  pageState?.selectableTargets ?? pageState?.elements ?? [];

const workspaceTargetForId = (id: string): WorkspaceTarget | null =>
  pageState?.elements.find((element) => element.id === id)?.target ??
  selectableTargets().find((element) => element.id === id)?.target ??
  null;

const targetKey = workspaceTargetKey;
const targetFromKey = workspaceTargetFromKey;

const expandedTargets = () =>
  pageState?.elements
    .filter((element) => expandedIds.has(element.id))
    .map((element) => element.target) ?? [];

const initializeTreeHierarchy = () => {
  if (!pageState) return;
  pageState.elements
    .filter((element) => !element.parentId && element.hasChildren)
    .forEach((element) => {
      if (!knownTreeRootIds.has(element.id)) expandedIds.add(element.id);
      knownTreeRootIds.add(element.id);
    });
};

const changeKey = (change: WorkspaceChange) =>
  `${targetKey(change.target)}::${change.kind}::${change.property}`;

const icon = (
  name:
    | 'brand'
    | 'back'
    | 'refresh'
    | 'undo'
    | 'redo'
    | 'export'
    | 'copy'
    | 'delete'
    | 'file'
    | 'link'
    | 'select'
    | 'hand'
    | 'fit'
    | 'history'
    | 'capability-checking'
    | 'capability-edit-export'
    | 'capability-edit-only'
    | 'capability-export-only'
    | 'capability-preview-only'
    | 'capability-error',
) => {
  if (name === 'brand') return '<img src="icons/icon-128.png" alt="" />';
  const paths = {
    back: '<path d="m14 6-6 6 6 6M8 12h11"/>',
    refresh: '<path d="M19 8a7 7 0 1 0 1 5M19 4v4h-4"/>',
    undo: '<path d="m8 7-4 4 4 4M5 11h8a6 6 0 0 1 6 6"/>',
    redo: '<path d="m16 7 4 4-4 4M19 11h-8a6 6 0 0 0-6 6"/>',
    export: '<path d="M12 4v11m-4-4 4 4 4-4M5 20h14"/>',
    copy: '<rect x="8" y="8" width="10" height="10" rx="1.5"/><path d="M6 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V6"/>',
    delete: '<path d="M4.5 7h15M9 4h6l1 3H8zM7 7l.7 13h8.6L17 7M10 10.5v6M14 10.5v6"/>',
    file: '<path d="M3.5 7.5h6l1.7-2h3.3a2 2 0 0 1 2 2v1"/><path d="M4 8.5h15.2a1.3 1.3 0 0 1 1.2 1.7l-2.3 8a2 2 0 0 1-1.9 1.4H5.8a2 2 0 0 1-2-1.8L2.5 10a1.3 1.3 0 0 1 1.5-1.5Z"/>',
    link: '<path d="M10.2 13.8a4 4 0 0 0 5.7.1l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M13.8 10.2a4 4 0 0 0-5.7-.1l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
    select: '<path d="m5 3 13 8-6 2-3 6z"/>',
    hand: '<path d="M8 11V6.5a1.5 1.5 0 0 1 3 0V10m0-4.5a1.5 1.5 0 0 1 3 0V10m0-3a1.5 1.5 0 0 1 3 0v5m0-2a1.5 1.5 0 0 1 3 0v3.5C20 18 17 21 12.5 21 8 21 5 18.5 4 15l-1-3a1.6 1.6 0 0 1 3-1l2 3"/>',
    fit: '<path d="M8 4H4v4M16 4h4v4M4 16v4h4M20 16v4h-4"/>',
    history: '<path d="M5.2 7.5A8 8 0 1 1 4 13M3.5 5.5v4h4M12 7.5v4.8l3.2 1.8"/>',
    'capability-checking': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v4.8l3 1.8"/>',
    'capability-edit-export':
      '<path d="m5 17.8-.8 3 3-.8L18 9.2 14.8 6z"/><path d="m13.5 7.3 3.2 3.2"/><path d="M16 18.5h4M18 16.5v4"/>',
    'capability-edit-only':
      '<path d="m5 17.8-.8 3 3-.8L18 9.2 14.8 6z"/><path d="m13.5 7.3 3.2 3.2"/>',
    'capability-export-only': '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19.5h14"/>',
    'capability-preview-only':
      '<path d="M3.5 12s3.2-5 8.5-5 8.5 5 8.5 5-3.2 5-8.5 5-8.5-5-8.5-5Z"/><circle cx="12" cy="12" r="2"/>',
    'capability-error': '<path d="M12 3.5 21 19H3L12 3.5Z"/><path d="M12 9v4M12 16.5h.01"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};

type PageCapabilityIcon =
  | 'capability-checking'
  | 'capability-edit-export'
  | 'capability-edit-only'
  | 'capability-export-only'
  | 'capability-preview-only'
  | 'capability-error'
  | 'copy';

type PageCapabilityTone =
  'checking' | 'editable' | 'exportable' | 'preview' | 'web-copy' | 'waiting' | 'error';

const capabilityIconFor = (status: string): PageCapabilityIcon =>
  status === 'editable-exportable'
    ? 'capability-edit-export'
    : status === 'editable-only'
      ? 'capability-edit-only'
      : status === 'exportable-only'
        ? 'capability-export-only'
        : status === 'preview-only'
          ? 'capability-preview-only'
          : 'capability-checking';

const capabilityToneFor = (status: string): PageCapabilityTone =>
  status === 'editable-exportable' || status === 'editable-only'
    ? 'editable'
    : status === 'exportable-only'
      ? 'exportable'
      : status === 'preview-only'
        ? 'preview'
        : 'checking';

const capabilityDescriptionFor = (status: string) =>
  status === 'editable-exportable'
    ? '可以直接修改当前页面，也可以导出当前页面的静态 HTML 副本。'
    : status === 'editable-only'
      ? '可以直接修改当前页面，但当前页面无法生成静态 HTML。'
      : status === 'exportable-only'
        ? '可以生成当前页面的静态 HTML 副本，但没有可安全直接修改的页面对象。'
        : status === 'preview-only'
          ? '当前页面只能查看，暂不支持直接修改或导出 HTML。'
          : '正在确认当前页面是否可编辑、是否可导出 HTML。';

const setPageCapability = (view: {
  icon: PageCapabilityIcon;
  tone: PageCapabilityTone;
  label: string;
  description: string;
}) => {
  const indicator = app.querySelector<HTMLElement>('[data-page-capability]');
  if (!indicator) return;
  indicator.className = `page-capability page-capability--${view.tone}`;
  indicator.setAttribute('aria-label', view.label);
  indicator.setAttribute('data-tooltip', `${view.label}：${view.description}`);
  indicator.title = view.label;
  indicator.innerHTML = icon(view.icon);
};

const shell = () => {
  app.innerHTML = `<div class="workspace-shell">
    <header class="topbar">
      <div class="brand" aria-label="点睛 · AI 创作的最后一笔">${icon('brand')}<div class="brand-copy"><strong>点睛</strong><span class="brand-promise">AI 创作 · 最后一笔</span></div></div>
      <div class="page-session"><div class="page-identity"><div class="page-title-row"><span class="page-capability page-capability--checking" data-page-capability role="img" tabindex="0" aria-label="正在连接原页面" data-tooltip="正在连接原页面" title="正在连接原页面">${icon('capability-checking')}</span><strong data-page-title>正在连接原页面…</strong></div><span class="page-url" data-page-url></span><span class="page-snapshot" data-page-snapshot>正在同步页面快照…</span></div><div class="source-actions"><button class="open-html" data-action="open-html">${icon('file')}打开 HTML</button><button class="open-url" data-action="open-url">${icon('link')}打开链接</button></div><input class="visually-hidden" type="file" accept=".html,.htm,text/html" data-html-input /></div>
      <div class="canvas-controls" aria-label="画布工具"><button class="tool-button is-active" data-canvas-mode="select">${icon('select')}选择</button><button class="tool-button" data-canvas-mode="pan" data-wb-pan>${icon('hand')}平移</button><button class="guide-toggle" data-action="toggle-guides" aria-pressed="false"><span>参考线</span><i></i></button><span class="control-divider"></span><div class="canvas-size-controls" aria-label="页面尺寸"><label><span>宽</span><input type="number" min="320" max="2560" step="1" data-canvas-width data-page-width data-wb-page-width aria-label="页面逻辑宽度" /></label><label><span>高</span><input type="number" min="320" max="2560" step="1" data-canvas-height data-page-height data-wb-page-height aria-label="页面逻辑高度" /></label></div><span class="control-divider"></span><button class="icon-button" data-action="zoom-out" aria-label="缩小" title="缩小画布">−</button><output data-zoom data-zoom-readout data-wb-zoom-readout data-action="zoom-100" role="button" tabindex="0" title="回到 100% · 画布内 Ctrl+滚轮可缩放">100%</output><button class="icon-button" data-action="zoom-in" aria-label="放大" title="放大画布">＋</button><button class="tool-button" data-action="fit-canvas">${icon('fit')}适应</button></div>
      <div class="top-actions">
        <button class="icon-button" data-action="undo" title="撤销">${icon('undo')}</button>
        <button class="icon-button" data-action="redo" title="重做">${icon('redo')}</button>
        <button class="change-button" data-action="show-history">${icon('history')}变更 <b data-change-count>0</b></button>
        <button data-action="show-delivery">交付</button>
        <button data-action="refresh" title="重新读取原页面并刷新画布">${icon('refresh')}同步页面</button>
        <button class="return-button" data-action="return-source">${icon('back')}返回原页面</button>
      </div>
    </header>
    <aside class="object-panel">
      <div class="panel-title"><div><strong>页面结构</strong><span data-object-count>0 个对象</span></div><button data-action="collapse-all">全部收起</button></div>
      <label class="search"><span>⌕</span><input type="search" placeholder="搜索对象、文字或标签" data-object-filter /></label>
      <div class="region-navigation" data-region-navigation aria-label="页面一级区域"></div>
      <div class="selection-summary"><span data-selection-count>未选择对象</span><span class="selection-summary-actions"><button data-action="focus-selection" disabled>聚焦</button><button data-action="clear-selection">清除</button></span></div>
      <div class="tree-view-controls" role="group" aria-label="对象树视图"><span>查看</span><div class="tree-mode-toggle"><button type="button" data-tree-mode="edit" aria-pressed="true">编辑树</button><button type="button" data-tree-mode="full" aria-pressed="false">完整结构</button></div></div>
      <div class="object-tree" role="tree" data-object-tree></div>
    </aside>
    <main class="canvas-area">
      <div class="canvas-viewport" data-canvas-viewport>
        <div class="workspace-rulers" data-rulers aria-label="页面坐标标尺"><div class="ruler-corner" aria-hidden="true"></div><div class="workspace-ruler workspace-ruler--top" data-ruler="top" role="button" tabindex="0" aria-label="从顶部标尺拖出竖直参考线"><div class="workspace-ruler-ticks" data-ruler-ticks="top"></div></div><div class="workspace-ruler workspace-ruler--left" data-ruler="left" role="button" tabindex="0" aria-label="从左侧标尺拖出水平参考线"><div class="workspace-ruler-ticks" data-ruler-ticks="left"></div></div></div>
        <div class="canvas-stage" data-canvas-stage data-wb-canvas>
          <div class="canvas-loading" data-canvas-loading><strong>正在读取原页面</strong><span>建立对象、历史和页面快照连接</span></div>
          <div class="canvas-content" data-canvas-content><div class="canvas-page" data-canvas-page><iframe title="原页面实时快照" sandbox="allow-same-origin" data-page-frame></iframe><button class="canvas-resize-handle canvas-resize-handle--right" data-canvas-resize="right" data-wb-page-resize="right" data-resize="right" aria-label="调整页面宽度"></button><button class="canvas-resize-handle canvas-resize-handle--bottom" data-canvas-resize="bottom" data-wb-page-resize="bottom" data-resize="bottom" aria-label="调整页面高度"></button><button class="canvas-resize-handle canvas-resize-handle--corner" data-canvas-resize="corner" data-wb-page-resize="corner" data-resize="corner" aria-label="同时调整页面宽高"></button></div></div>
          <div class="selection-overlay-layer" data-selection-overlay-layer aria-hidden="true"></div><div class="guide-overlay-layer" data-guide-overlay-layer aria-label="参考线辅助层"></div>
          <div class="measure-overlay" data-measure-overlay hidden><i class="edge top"></i><i class="edge right"></i><i class="edge bottom"></i><i class="edge left"></i><span></span></div>
        </div>
      </div>
      <div class="canvas-status"><span data-notice>等待原页面状态</span><span><kbd>Space</kbd> 拖动画布 · 悬浮查看标尺 · <kbd>Ctrl/⌘</kbd> 多选</span></div>
    </main>
    <aside class="inspector-panel">
      <div class="inspector-content" data-inspector-content></div>
    </aside>
    <dialog class="open-url-dialog" data-open-url-dialog aria-labelledby="open-url-title"><form data-open-url-form><header><div><strong id="open-url-title">打开网页链接</strong><span>链接打开后会进入当前工作台进行调整</span></div><button type="button" data-action="close-url-dialog" aria-label="关闭">×</button></header><label><span>网页地址</span><input type="text" inputmode="url" data-open-url-input placeholder="https://example.com/page" required /></label><p>首次打开某个站点时，会请求该站点的访问授权；浏览器中已有同一地址时会直接复用，不新增重复标签页。</p><footer><button type="button" data-action="close-url-dialog">取消</button><button type="submit" class="primary">打开并进入工作台</button></footer></form></dialog>
  </div>`;
};

type TreeScrollAnchor = {
  candidates: Array<{ selector: string; viewportTop: number }>;
  scrollTop: number;
};

let pendingTreeScrollAnchor: TreeScrollAnchor | null = null;

const captureTreeScrollAnchor = (fallbackSelector?: string) => {
  const tree = app.querySelector<HTMLElement>('[data-object-tree]');
  if (!tree) return;
  const treeRect = tree.getBoundingClientRect();
  const selectors: string[] = [];
  const primaryId = primaryElement()?.id;
  if (primaryId) selectors.push(`[data-object-id="${CSS.escape(primaryId)}"]`);
  if (fallbackSelector && !selectors.includes(fallbackSelector)) selectors.push(fallbackSelector);
  const candidates = selectors.flatMap((selector) => {
    const row = tree.querySelector<HTMLElement>(selector);
    if (!row) return [];
    const rowRect = row.getBoundingClientRect();
    const visible = rowRect.bottom > treeRect.top && rowRect.top < treeRect.bottom;
    if (!visible && selector !== fallbackSelector) return [];
    return [{ selector, viewportTop: rowRect.top - treeRect.top }];
  });
  pendingTreeScrollAnchor = { candidates, scrollTop: tree.scrollTop };
};

const restoreTreeScrollAnchor = (tree: HTMLElement) => {
  const anchor = pendingTreeScrollAnchor;
  pendingTreeScrollAnchor = null;
  if (!anchor) return;
  const treeRect = tree.getBoundingClientRect();
  for (const candidate of anchor.candidates) {
    const row = tree.querySelector<HTMLElement>(candidate.selector);
    if (!row) continue;
    tree.scrollTop += row.getBoundingClientRect().top - treeRect.top - candidate.viewportTop;
    return;
  }
  tree.scrollTop = anchor.scrollTop;
};

const renderRegionNavigation = () => {
  const navigation = app.querySelector<HTMLElement>('[data-region-navigation]');
  if (!navigation) return;
  const index = selectableTargets();
  const byId = new Map(index.map((item) => [item.id, item]));
  const regions = new Map<string, WorkspaceSelectableTarget>();
  index.forEach((item) => {
    if (item.regionId && !regions.has(item.regionId)) {
      const region = byId.get(item.regionId);
      if (region) regions.set(item.regionId, region);
    }
  });
  if (!regions.size) {
    navigation.innerHTML = '<span class="region-navigation-empty">当前页面未识别出一级区域</span>';
    return;
  }
  const selectedRegionId = selectableTargets().find(
    (item) => item.id === primaryElement()?.id,
  )?.regionId;
  navigation.innerHTML = `<span class="region-navigation-label">区域</span><div class="region-navigation-list">${[
    ...regions.values(),
  ]
    .map(
      (region) =>
        `<button type="button" class="region-chip ${region.id === selectedRegionId ? 'is-active' : ''}" data-region-target-id="${escapeHtml(region.id)}" title="定位到${escapeHtml(region.label)}">${escapeHtml(region.label)}</button>`,
    )
    .join('')}</div>`;
};

const searchResultMarkup = (item: WorkspaceSelectableTarget) => {
  const selected = selectedIds.includes(item.id);
  const primary = primaryElement()?.id === item.id;
  const region = item.regionLabel ? ` · ${item.regionLabel}` : '';
  return `<button type="button" class="tree-search-result ${selected ? 'is-selected' : ''} ${primary ? 'is-primary' : ''}" role="treeitem" aria-selected="${String(selected)}" data-object-id="${escapeHtml(item.id)}"><span class="tree-search-result-icon">${item.tag === '#text' || /^h[1-6]$/.test(item.tag) ? 'T' : item.tag === 'button' ? 'B' : '◇'}</span><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.role)} · ${escapeHtml(item.tag)}${escapeHtml(region)}</small></span></button>`;
};

const renderObjectTree = () => {
  const tree = app.querySelector<HTMLElement>('[data-object-tree]');
  if (!tree || !pageState) return;
  const path = objectTreePathFor(pageState.elements, primaryElement()?.id);
  const pathIds = new Set(path.slice(0, -1).map((element) => element.id));
  const searchResults = filter
    ? selectableTargets()
        .filter((element) =>
          `${element.label} ${element.role} ${element.tag} ${element.text} ${element.regionLabel ?? ''}`
            .toLowerCase()
            .includes(filter.trim().toLowerCase()),
        )
        .slice(0, 100)
    : [];
  const rows = buildObjectTreeRows(pageState.elements, {
    mode: treeMode,
    expandedIds,
    expandedCompressionKeys,
    selectedIds,
    filter: '',
  });

  app.querySelectorAll<HTMLButtonElement>('[data-tree-mode]').forEach((button) => {
    const active = button.dataset.treeMode === treeMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  const location = path.length
    ? `<div class="tree-location" data-tree-location><span class="tree-location-label">当前位置</span><div class="tree-location-path" aria-label="当前选中对象祖先路径">${path
        .map(
          (element, index) =>
            `<button type="button" class="tree-path-item ${index === path.length - 1 ? 'is-current' : ''}" data-object-id="${escapeHtml(element.id)}" title="选中${escapeHtml(element.label)}">${escapeHtml(element.label)}</button>`,
        )
        .join('<span class="tree-path-separator" aria-hidden="true">›</span>')}</div></div>`
    : '<div class="tree-location tree-location--empty" data-tree-location><span class="tree-location-label">当前位置</span><span>未选择对象</span></div>';

  const rowsMarkup = filter
    ? searchResults.map(searchResultMarkup).join('')
    : rows
        .map((row) => {
          if (row.kind === 'compression') {
            const ancestor =
              row.hiddenIds.some((id) => pathIds.has(id)) || pathIds.has(row.terminalId);
            const selectedPathCompression = row.key.startsWith('selected>');
            return `<button type="button" class="tree-compression ${ancestor ? 'is-ancestor' : ''} ${row.expanded ? 'is-expanded' : ''}" role="treeitem" aria-level="${row.depth + 1}" aria-expanded="${String(row.expanded)}" data-tree-compression="${escapeHtml(row.key)}" style="--depth:${row.depth}"><span class="tree-compression-mark" aria-hidden="true">⋮</span><span><strong>${row.expanded ? '收起' : '省略'} ${row.count} 层${selectedPathCompression ? '上级结构' : '容器'}</strong><small>${row.expanded ? '恢复编辑树路径' : '点击展开真实层级'}</small></span><span class="tree-compression-action" aria-hidden="true">${row.expanded ? '⌃' : '⌄'}</span></button>`;
          }

          const { element } = row;
          const hasChildren = element.hasChildren;
          const expanded = hasChildren && expandedIds.has(element.id);
          const hidden = (element.styles.visibility ?? 'visible') === 'hidden';
          const treeState = hidden
            ? '<em class="tree-visibility tree-visibility--hidden" title="当前对象已隐藏">隐</em>'
            : `<em class="capability capability--${element.capability}" title="${element.capability}"></em>`;
          const selected = selectedIds.includes(element.id);
          const primary = primaryElement()?.id === element.id;
          const ancestor = pathIds.has(element.id);
          const nonEditableWrapper = element.hasChildren && element.capability !== 'direct';
          const iconLabel =
            element.tag === '#text' || /^h[1-6]$/.test(element.tag)
              ? 'T'
              : element.tag === 'button'
                ? 'B'
                : element.tag === 'img'
                  ? '▧'
                  : ['main', 'section', 'header', 'footer', 'article', 'div'].includes(element.tag)
                    ? '▱'
                    : '◇';
          return `<div class="tree-row ${selected ? 'is-selected' : ''} ${primary ? 'is-primary' : ''} ${ancestor ? 'is-ancestor' : ''} ${nonEditableWrapper ? 'is-non-editable-wrapper' : ''} ${hidden ? 'is-hidden' : ''}" role="treeitem" aria-level="${row.depth + 1}" aria-selected="${String(selected)}" aria-expanded="${String(expanded)}" draggable="${element.tag !== '#text'}" data-object-id="${escapeHtml(element.id)}" style="--depth:${row.depth}">
        <button type="button" class="tree-toggle" data-toggle-tree="${escapeHtml(element.id)}" ${hasChildren ? '' : 'disabled'} aria-label="${expanded ? '收起' : '展开'}">${hasChildren ? (expanded ? '⌄' : '›') : ''}</button>
        <span class="tree-icon">${iconLabel}</span>
        <span><strong>${escapeHtml(element.label)}</strong><small>${escapeHtml(element.role)} · ${escapeHtml(element.tag)}</small></span>
        ${treeState}
      </div>`;
        })
        .join('');
  tree.innerHTML = `${location}${rowsMarkup || '<div class="empty"><strong>没有匹配对象</strong><span>尝试搜索页面中的其他文字。</span></div>'}`;
  const locationPath = tree.querySelector<HTMLElement>('.tree-location-path');
  if (locationPath) locationPath.scrollLeft = locationPath.scrollWidth;
  restoreTreeScrollAnchor(tree);
};

const toHexColor = (value: string) => {
  const normalized = value.trim();
  if (/^#[\da-f]{6}$/i.test(normalized)) return normalized;
  const short = normalized.match(/^#([\da-f])([\da-f])([\da-f])$/i);
  if (short)
    return `#${short
      .slice(1)
      .map((part) => `${part}${part}`)
      .join('')}`;
  const rgb = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!rgb) return '#ffffff';
  return `#${rgb
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`;
};

const styleField = (
  element: WorkspaceElement,
  property: string,
  label: string,
  type: 'text' | 'number' | 'range' | 'color' = 'text',
  max = 80,
) => {
  const source = element.styles[property] ?? '';
  const value = source;
  const numericValue = Number.parseFloat(value) || 0;
  const numeric = String(
    type === 'range' ? Math.round(numericValue) : Math.round(numericValue * 100) / 100,
  );
  if (type === 'color') {
    const color = toHexColor(value);
    return `<label class="field field--color"><span>${label}</span><span class="color-control"><input type="color" value="${color}" data-style-property="${property}"/><code>${color}</code></span></label>`;
  }
  if (type === 'range')
    return `<label class="field field--range"><span>${label}</span><span class="range-control"><input type="range" value="${numeric}" min="0" max="${max}" step="1" data-style-property="${property}" data-unit="px" data-range-control="slider"/><span class="unit-input"><input type="number" value="${numeric}" min="0" max="${max}" step="1" inputmode="decimal" aria-label="${label}数值" data-style-property="${property}" data-unit="px" data-range-control="number"/><em aria-hidden="true">px</em></span></span></label>`;
  if (type === 'number')
    return `<label class="field"><span>${label}</span><span class="unit-input"><input type="number" value="${numeric}" min="0" max="160" step="1" inputmode="decimal" data-style-property="${property}" data-unit="px"/><em aria-hidden="true">px</em></span></label>`;
  return `<label class="field"><span>${label}</span><input type="${type}" value="${escapeHtml(value)}" data-style-property="${property}"/></label>`;
};

const positionField = (element: WorkspaceElement, property: 'left' | 'top', label: string) => {
  const value = String(Math.round(Number.parseFloat(element.styles[property] ?? '') || 0));
  return `<label class="field"><span>${label}</span><span class="unit-input"><input type="number" value="${value}" min="-2560" max="2560" step="1" inputmode="decimal" aria-label="${label}数值" data-style-property="${property}" data-unit="px" data-position-offset/><em aria-hidden="true">px</em></span></label>`;
};

const fontOptions = [
  ['inherit', '页面默认'],
  ['system-ui, sans-serif', '系统默认'],
  ['"Microsoft YaHei", sans-serif', '微软雅黑'],
  ['"PingFang SC", sans-serif', '苹方'],
  ['SimHei, sans-serif', '黑体'],
  ['SimSun, serif', '宋体'],
  ['Arial, sans-serif', 'Arial'],
  ['"Helvetica Neue", Arial, sans-serif', 'Helvetica Neue'],
  ['Georgia, serif', 'Georgia'],
  ['"Times New Roman", Times, serif', 'Times New Roman'],
  ['Consolas, monospace', 'Consolas'],
  ['"Courier New", monospace', 'Courier New'],
] as const;

const renderTaskTabs = () =>
  `<nav class="task-tabs" role="tablist" aria-label="对象任务"><button class="${activeTask === 'properties' ? 'is-active' : ''}" data-task="properties">属性</button><button class="${activeTask === 'layout' ? 'is-active' : ''}" data-task="layout">布局</button></nav>`;

const renderTextEditor = (element: WorkspaceElement) => {
  const decoration = element.styles['text-decoration'] ?? 'none';
  const weight = Number.parseInt(element.styles['font-weight'] ?? '400', 10) || 400;
  const fontStyle = element.styles['font-style'] ?? 'normal';
  const currentFont = element.styles['font-family'] ?? 'inherit';
  return `<section class="editor-section"><span class="editor-section-title">文字内容</span><textarea class="text-editor" data-text-editor>${escapeHtml(element.text)}</textarea></section>
    <section class="editor-section"><div class="editor-grid">${styleField(element, 'color', '文字颜色', 'color')}${styleField(element, 'font-size', '字号', 'range', 80)}</div></section>
    <section class="editor-section"><div class="editor-section-heading"><strong>字体与格式</strong><span>字体、字重和文字装饰</span></div><label class="field field--wide"><span>字体</span><select data-draft-property="font-family">${fontOptions.map(([value, label]) => `<option value="${escapeHtml(value)}" ${currentFont === value || (value === 'inherit' && !fontOptions.some(([candidate]) => candidate !== 'inherit' && currentFont.includes(candidate.split(',')[0]!.replace(/["]/g, '')))) ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="format-grid"><button class="${weight >= 700 ? 'is-active' : ''}" data-format="bold"><b>B</b> 加粗</button><button class="${fontStyle === 'italic' ? 'is-active' : ''}" data-format="italic"><i>I</i> 倾斜</button><button class="${decoration.includes('underline') ? 'is-active' : ''}" data-format="underline"><u>U</u> 下划线</button><button class="${decoration.includes('line-through') ? 'is-active' : ''}" data-format="strike"><s>S</s> 删除线</button></div></section>`;
};

const renderAppearanceEditor = (element: WorkspaceElement) => {
  const borderStyle = element.styles['border-style'] ?? 'none';
  const visible = (element.styles.visibility ?? 'visible') !== 'hidden';
  return `<section class="editor-section"><span class="editor-section-title">颜色</span><div class="editor-grid">${styleField(element, 'background-color', '元素背景', 'color')}${styleField(element, 'border-color', '边框颜色', 'color')}</div></section>
    <section class="editor-section"><div class="editor-section-heading"><strong>边框细节</strong><span>圆角、粗细和样式</span></div><div class="editor-grid">${styleField(element, 'border-radius', '圆角', 'range', 80)}${styleField(element, 'border-width', '边框粗细', 'range', 24)}</div><label class="field field--wide"><span>边框样式</span><select data-draft-property="border-style"><option value="none" ${borderStyle === 'none' ? 'selected' : ''}>无边框</option><option value="solid" ${borderStyle === 'solid' ? 'selected' : ''}>实线</option><option value="dashed" ${borderStyle === 'dashed' ? 'selected' : ''}>虚线</option><option value="dotted" ${borderStyle === 'dotted' ? 'selected' : ''}>点线</option></select></label></section>
    <section class="editor-section visibility-editor"><div class="editor-section-heading"><strong>可见性</strong><span>只影响画布，不改变页面布局</span></div><button class="visibility-toggle ${visible ? 'is-active' : ''}" aria-label="${visible ? '暂时隐藏对象' : '恢复对象显示'}" data-visibility="${visible ? 'hidden' : 'visible'}"><span class="visibility-copy"><strong>${visible ? '在画布中显示' : '暂时隐藏对象'}</strong><small>${visible ? '对象当前可见' : '对象保留位置，布局不变'}</small></span><b>${visible ? '显示中' : '已隐藏'}</b><i></i></button></section>`;
};

const renderSpacingEditor = (element: WorkspaceElement) => {
  const alignment = (property: string, values: string[], labels: string[]) => {
    const current = element.styles[property] ?? '';
    return values
      .map(
        (value, index) =>
          `<button class="${current === value ? 'is-active' : ''}" data-style-property="${property}" data-style-value="${value}" data-style-label="${labels[index]}">${labels[index]}</button>`,
      )
      .join('');
  };
  const sides = (kind: 'margin' | 'padding', label: string, note: string) =>
    `<section class="spacing-box spacing-box--${kind}"><div class="editor-section-heading"><strong>${label}</strong><span>${note}</span></div><div class="side-grid">${styleField(element, `${kind}-top`, '上', 'number')}${styleField(element, `${kind}-right`, '右', 'number')}${styleField(element, `${kind}-bottom`, '下', 'number')}${styleField(element, `${kind}-left`, '左', 'number')}</div></section>`;
  return `<section class="editor-section"><div class="editor-section-heading"><strong>文字位置</strong><span></span></div><div class="alignment-row"><span>水平</span><div>${alignment('text-align', ['left', 'center', 'right'], ['靠左', '居中', '靠右'])}</div></div><div class="alignment-row"><span>垂直</span><div>${alignment('vertical-align', ['top', 'middle', 'bottom'], ['靠上', '居中', '靠下'])}</div></div></section>${sides('margin', '外边距', '元素外部')}${sides('padding', '内边距', '元素内部')}`;
};

const renderSizeEditor = (element: WorkspaceElement) =>
  `<section class="editor-section"><div class="editor-section-heading"><strong>尺寸</strong><span>保持页面文档流</span></div><div class="editor-grid">${styleField(element, 'width', '宽度', 'number')}${styleField(element, 'height', '高度', 'number')}${styleField(element, 'min-width', '最小宽度', 'number')}${styleField(element, 'line-height', '行高', 'number')}</div></section>`;

const pathFor = (element: WorkspaceElement) => {
  if (!pageState) return element.label;
  const parts = [element.label];
  let parentId = element.parentId;
  while (parentId) {
    const parent = pageState.elements.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    parts.unshift(parent.label);
    parentId = parent.parentId;
  }
  return parts.slice(-4).join(' / ');
};

const shareParent = (elements: WorkspaceElement[]) =>
  elements.length > 1 && elements.every((element) => element.parentId === elements[0]?.parentId);

const renderPropertyInspector = (element: WorkspaceElement) => {
  if (element.capability === 'unstable')
    return '<div class="capability-note"><strong>当前对象定位不稳定</strong><p>请从画布或对象树选择更明确的内部元素后再修改。</p></div>';
  return `${element.capability === 'direct' ? renderTextEditor(element) : '<section class="editor-section"><div class="editor-section-heading"><strong>内容</strong><span>当前对象仅支持整体调整</span></div><p class="section-note">选中内部文字对象后可以编辑内容与字体。</p></section>'}${renderAppearanceEditor(element)}${renderSizeEditor(element)}${renderSpacingEditor(element)}`;
};

const renderDeleteConfirmation = (element: WorkspaceElement) =>
  deletePendingId === element.id
    ? `<div class="delete-confirm" role="alert"><strong>确认从页面结构中移除？</strong><span>“${escapeHtml(element.label)}”会从当前页面移除，但仍可通过撤销恢复。</span><small>如果只是暂时不展示，请使用属性里的“可见性”。</small><div class="delete-confirm-actions"><button data-action="workspace-delete-cancel">取消</button><button class="delete-confirm-primary" data-action="workspace-delete-confirm">移除对象</button></div></div>`
    : '';

const layoutIcon = (
  label: string,
  value: string,
  group: string,
  options: { disabled?: boolean; title?: string } = {},
) =>
  `<button data-${group}="${value}" title="${options.title ?? label}" aria-label="${label}" ${options.disabled ? 'disabled' : ''}><span aria-hidden="true">${label.slice(0, 1)}</span><small>${label}</small></button>`;

const renderGuideManager = (selected: WorkspaceElement[]) => {
  const guide = guidesEnabled ? currentWorkspaceGuide() : null;
  const hasGuides = workspaceGuides.length > 0;
  const selectedLabel = guide
    ? `当前：${guideOrientationLabel(guide.orientation)}参考线 · ${Math.round(guide.position)} px`
    : '不使用参考线 · 首选对象';
  const guideOptions = workspaceGuides.length
    ? workspaceGuides
        .map(
          (item) =>
            `<button type="button" role="radio" class="guide-choice ${item.id === guide?.id ? 'is-current' : ''}" data-guide-select="${escapeHtml(item.id)}" aria-checked="${String(item.id === guide?.id)}" aria-pressed="${String(item.id === guide?.id)}" ${guidesEnabled ? '' : 'disabled'}><span class="guide-choice-mark guide-choice-mark--${item.orientation}" aria-hidden="true"></span><span><strong>${guideOrientationLabel(item.orientation)}参考线</strong><small>${Math.round(item.position)} px</small></span></button>`,
        )
        .join('')
    : '<p class="section-note guide-empty-note">暂无参考线；开启参考线后，从上方数字标尺拖出竖直线，或从左侧数字标尺拖出水平线。</p>';
  const currentGuideControls = guide
    ? `<div class="guide-manager-current"><div class="editor-section-heading"><strong>当前参考线</strong><button class="guide-inspector-delete" type="button" data-guide-delete="${escapeHtml(guide.id)}" aria-label="删除当前${guideOrientationLabel(guide.orientation)}参考线" title="删除参考线">×</button></div><label class="field guide-position-field"><span>${guideOrientationLabel(guide.orientation)}坐标</span><span class="unit-input"><input type="number" value="${Math.round(guide.position)}" min="0" max="${guidePositionLimit(guide.orientation)}" step="1" inputmode="decimal" data-guide-position="${escapeHtml(guide.id)}" aria-label="当前${guideOrientationLabel(guide.orientation)}参考线坐标"/><em aria-hidden="true">px</em></span></label><small class="guide-field-note">页面逻辑坐标，范围 0–${guidePositionLimit(guide.orientation)} px</small></div>`
    : '';
  return `<section class="editor-section guide-manager" data-guide-manager><div class="editor-section-heading"><strong>布局基准</strong><span>${guidesEnabled ? selectedLabel : '参考线已关闭'}</span></div><p class="alignment-anchor-note guide-anchor-note" data-alignment-anchor>对齐基准：${escapeHtml(selectedLabel)}${guide ? ` · ${guide.orientation === 'vertical' ? '支持左、水平居中、右对齐' : '支持顶部、垂直居中、底部对齐'}` : ''}</p><div class="guide-choice-list" role="radiogroup" aria-label="选择布局对齐基准"><button type="button" role="radio" class="guide-choice guide-choice--none ${guide ? '' : 'is-current'}" data-guide-select-none aria-checked="${String(!guide)}" aria-pressed="${String(!guide)}" ${guidesEnabled ? '' : 'disabled'}><span class="guide-choice-mark guide-choice-mark--none" aria-hidden="true"></span><span><strong>不使用参考线</strong><small>首选对象作为基准</small></span></button>${guideOptions}</div>${currentGuideControls}${hasGuides && !guidesEnabled ? '<p class="section-note">打开顶部“参考线”后，可选择具体参考线参与布局。</p>' : ''}${selected.length ? `<div class="selection-list guide-selection-list">${selected.map((item) => `<span>${escapeHtml(item.label)} <small>· ${escapeHtml(item.tag)}</small></span>`).join('')}</div>` : ''}</section>`;
};

const renderGuideAlignment = (selected: WorkspaceElement[]) => {
  const guide = guidesEnabled ? currentWorkspaceGuide() : null;
  const hasSelectedObject = selected.length > 0;
  const canAlign = Boolean(guide) || selected.length > 1;
  const horizontalDisabled = !canAlign || guide?.orientation === 'horizontal';
  const verticalDisabled = !canAlign || guide?.orientation === 'vertical';
  const guideAxisHint = guide
    ? `当前${guideOrientationLabel(guide.orientation)}参考线仅支持${guide.orientation === 'vertical' ? '左、水平居中、右' : '顶部、垂直居中、底部'}对齐`
    : '';
  const anchorText = guide
    ? `当前${guideOrientationLabel(guide.orientation)}参考线 ${Math.round(guide.position)} px`
    : `首选对象 ${escapeHtml(selected[0]?.label ?? '未选择')}`;
  const selectionText = hasSelectedObject
    ? guide
      ? `所有 ${selected.length} 个已选对象将以当前参考线为对齐基准`
      : '第一个选中的对象作为基准，其他对象向它对齐'
    : '请先选择至少 1 个对象，再执行对齐';
  return `<section class="editor-section guide-alignment"><span class="editor-section-title">对齐</span><p class="alignment-anchor-note" data-alignment-anchor>对齐基准：${anchorText}${guideAxisHint ? ` · ${guideAxisHint}` : ''}</p><p class="section-note">${selectionText}</p><div class="layout-icon-grid">${layoutIcon('左对齐', 'left', 'batch-align', { disabled: horizontalDisabled, title: horizontalDisabled ? guideAxisHint || selectionText : undefined })}${layoutIcon('水平居中', 'center', 'batch-align', { disabled: horizontalDisabled, title: horizontalDisabled ? guideAxisHint || selectionText : undefined })}${layoutIcon('右对齐', 'right', 'batch-align', { disabled: horizontalDisabled, title: horizontalDisabled ? guideAxisHint || selectionText : undefined })}${layoutIcon('顶部对齐', 'top', 'batch-align', { disabled: verticalDisabled, title: verticalDisabled ? guideAxisHint || selectionText : undefined })}${layoutIcon('垂直居中', 'middle', 'batch-align', { disabled: verticalDisabled, title: verticalDisabled ? guideAxisHint || selectionText : undefined })}${layoutIcon('底部对齐', 'bottom', 'batch-align', { disabled: verticalDisabled, title: verticalDisabled ? guideAxisHint || selectionText : undefined })}</div></section>`;
};

const renderLayoutInspector = (selected: WorkspaceElement[], element: WorkspaceElement) => {
  if (selected.length === 1) {
    const isTextFragment = element.target.textNodeIndex !== undefined;
    return `${renderGuideManager(selected)}${renderGuideAlignment(selected)}<section class="editor-section relationship"><div class="editor-section-heading"><strong>结构关系</strong><span>${isTextFragment ? '文字片段' : '可调整'}</span></div><dl><div><dt>父容器</dt><dd>${escapeHtml(pageState?.elements.find((candidate) => candidate.id === element.parentId)?.label ?? '页面根级')}</dd></div><div><dt>当前位置</dt><dd>${escapeHtml(element.role)}</dd></div></dl></section><section class="editor-section object-position"><div class="editor-section-heading"><strong>位置</strong><span>相对当前对象</span></div><div class="editor-grid">${positionField(element, 'left', '横向偏移')}${positionField(element, 'top', '纵向偏移')}</div><p class="section-note">可输入负数；首次调整会启用相对定位，不脱离页面文档流。</p></section>${isTextFragment ? '<section class="editor-section"><p class="section-note">文字对象支持编辑、样式、位置和批量布局；不支持复制、组合、结构拖放或圆点缩放。</p></section>' : '<section class="editor-section"><div class="drag-instruction"><strong>拖动亮色边线移动对象</strong><p>也可直接输入横向、纵向偏移；拖圆点调整尺寸。拖对象本身或对象树可放到对象上方、下方或容器内部。所有操作松手后写入变更记录，可撤销。</p></div></section>'}`;
  }
  const sameParent = shareParent(selected);
  const hasTextFragment = selected.some((item) => item.target.textNodeIndex !== undefined);
  const guide = guidesEnabled ? currentWorkspaceGuide() : null;
  const usesObjectAnchor = !guide;
  return `${renderGuideManager(selected)}<section class="editor-section selection-range"><div class="editor-section-heading"><strong>选择范围</strong><button data-action="select-siblings" ${sameParent ? '' : 'disabled'}>全选同级</button></div><div class="selection-list">${selected.map((item, index) => `<span class="${usesObjectAnchor && index === 0 ? 'is-anchor' : ''}">${usesObjectAnchor && index === 0 ? '<b>基准</b> ' : ''}${escapeHtml(item.label)} <small>· ${escapeHtml(item.tag)}</small></span>`).join('')}</div></section>
    ${renderGuideAlignment(selected)}
    <section class="editor-section"><span class="editor-section-title">分布</span><div class="layout-button-row"><button data-distribute="horizontal">水平等距</button><button data-distribute="vertical">垂直等距</button></div></section>
    <section class="editor-section"><div class="editor-section-heading"><strong>统一间距</strong><span>${sameParent ? '同一容器' : '跨容器不可用'}</span></div><div class="gap-control"><select data-gap-direction><option value="horizontal">水平</option><option value="vertical">垂直</option></select><input type="number" min="0" max="160" value="24" data-gap-value/><span>px</span><button data-action="apply-gap" ${sameParent ? '' : 'disabled'}>应用</button></div></section>
    <section class="editor-section"><span class="editor-section-title">统一尺寸</span><div class="layout-button-row layout-button-row--three"><button data-size="width">同宽</button><button data-size="height">同高</button><button data-size="both">同宽高</button></div></section>
    <section class="editor-section"><div class="editor-section-heading"><strong>组合</strong><span>${hasTextFragment ? '含文字对象不可用' : sameParent ? '保留在当前容器内' : '跨容器不可用'}</span></div><div class="layout-button-row"><button data-action="create-group" ${sameParent && !hasTextFragment ? '' : 'disabled'}>创建组合</button><button disabled>取消组合</button></div></section>
    <section class="editor-section impact"><div class="editor-section-heading"><strong>影响范围</strong><span>${sameParent ? '同容器' : '跨容器'}</span></div><p>仅当前页面</p><p>${selected.length} 个对象的布局操作将写入顶部变更记录</p></section>`;
};

const renderObjectInspector = () => {
  const selected = selectedElements();
  const element = primaryElement();
  if (!element) {
    if (activeTask === 'layout')
      return `${renderTaskTabs()}${renderGuideManager(selected)}${renderGuideAlignment(selected)}<div class="inspector-empty inspector-empty--compact"><span class="empty-mark">⌖</span><strong>选择页面对象</strong><p>选择对象后可以在当前布局基准上执行对齐。</p></div>`;
    return '<div class="inspector-empty"><span class="empty-mark">⌖</span><strong>选择页面对象</strong><p>从左侧对象树或中央页面快照中选择。按 Ctrl/⌘ 可多选并执行批量布局。</p></div>';
  }
  if (selected.length > 1 && activeTask === 'properties') activeTask = 'layout';
  const isTextFragment = selected.length === 1 && element.target.textNodeIndex !== undefined;
  const singleActions = isTextFragment
    ? `<button class="danger" data-structure="delete" title="从页面结构中移除文字对象（可撤销）" aria-label="从页面结构中移除文字对象">${icon('delete')}</button>`
    : `<button data-structure="duplicate" title="复制对象" aria-label="复制对象">${icon('copy')}</button><button class="danger" data-structure="delete" title="从页面结构中移除对象（可撤销）" aria-label="从页面结构中移除对象">${icon('delete')}</button>`;
  return `${`<section class="selected-card"><div class="selected-card-head"><span>${selected.length > 1 ? selected.length : /^h[1-6]$/.test(element.tag) ? 'T' : '◇'}</span><div><strong>${selected.length > 1 ? `已选择 ${selected.length} 个对象` : escapeHtml(element.label)}</strong><small>${selected.length > 1 ? `${shareParent(selected) ? '同属' : '跨容器'}：${escapeHtml(pageState?.elements.find((candidate) => candidate.id === element.parentId)?.label ?? '页面')}` : escapeHtml(pathFor(element))}</small></div>${selected.length === 1 ? `<div class="summary-actions">${singleActions}</div>` : `<em>${shareParent(selected) ? '同容器' : '跨容器'}</em>`}</div></section>`}${renderDeleteConfirmation(element)}
    ${renderTaskTabs()}
    ${activeTask === 'properties' ? renderPropertyInspector(element) : renderLayoutInspector(selected, element)}`;
};

const renderHistoryInspector = () => {
  if (!pageState?.history.length)
    return '<div class="inspector-empty"><span class="empty-mark">↶</span><strong>尚无修改记录</strong><p>Dock 与完整工作台共用同一份历史。</p></div>';
  return `<section class="history-list"><div class="section-title"><strong>当前会话</strong><span>${pageState.history.length} 项</span></div>${[
    ...pageState.history,
  ]
    .reverse()
    .map(
      (entry) =>
        `<div class="history-item ${entry.cancelled ? 'is-cancelled' : ''}"><i></i><div><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.targetLabel)}</span></div>${entry.cancelled ? '<em>已取消</em>' : `<button data-cancel-history="${entry.id}">取消</button>`}</div>`,
    )
    .join('')}</section>`;
};

const renderExportProgress = () => {
  if (!exportingHtml && !exportReport) return '';
  if (!exportingHtml)
    return `<div class="delivery-export-progress is-${exportReport?.tone}" data-export-progress><strong>${escapeHtml(exportReport?.message ?? '')}</strong></div>`;
  const completed = exportProgress?.completed ?? 0;
  const total = Math.max(exportProgress?.total ?? 1, 1);
  const label = exportProgress?.label ?? '正在准备离线导出…';
  return `<div class="delivery-export-progress" data-export-progress aria-live="polite"><div><strong>${escapeHtml(label)}</strong><span>${completed}/${total}</span></div><progress value="${Math.min(completed, total)}" max="${total}"></progress></div>`;
};

const renderPromptCopyAction = () => {
  const view = {
    idle: { symbol: '✦', title: '复制 AI 提示词', description: '把修改记录同步回真实源码' },
    copying: { symbol: '…', title: '正在复制 AI 提示词', description: '请稍候…' },
    success: { symbol: '✓', title: '已复制 AI 提示词', description: '提示词已复制到剪贴板' },
    error: { symbol: '!', title: '复制 AI 提示词失败', description: '请检查剪贴板权限后重试' },
  }[promptCopyStatus];
  const busy = promptCopyStatus === 'copying';
  return `<button class="delivery-action delivery-action--prompt" data-action="copy-prompt" data-copy-state="${promptCopyStatus}" ${busy ? 'disabled aria-busy="true"' : ''}><span class="prompt-icon" aria-hidden="true">${view.symbol}</span><span class="prompt-copy-content" aria-live="polite"><strong>${view.title}</strong><small>${view.description}</small></span></button>`;
};

const renderDeliveryInspector = () =>
  `<section class="delivery"><div class="delivery-intro"><strong>交付当前成果</strong><p>导出的是当前标签页的修改结果，不会写回原网站，也不包含点睛界面。</p></div><button class="delivery-action" data-action="export-html" ${exportingHtml ? 'disabled aria-busy="true"' : ''}>${icon('export')}<span><strong>${exportingHtml ? '正在导出离线 HTML' : '导出离线 HTML'}</strong><small>内嵌资源与当前图表画面</small></span></button>${renderExportProgress()}<button class="delivery-action" data-action="export-viewport-png">${icon('export')}<span><strong>整页 PNG</strong><small>完整页面截图；隐藏点睛界面后生成</small></span></button>${renderPromptCopyAction()}<div class="delivery-note"><strong>结果分流</strong><ul><li>稳定 DOM：由点睛直接完成并进入历史</li><li>离线 HTML：内嵌当前资源和画布定格，不保留联网交互</li><li>源码持久化：生成提示词交给代码 Agent</li></ul></div></section>`;

const renderInspector = () => {
  const content = app.querySelector<HTMLElement>('[data-inspector-content]');
  if (!content) return;
  content.innerHTML =
    activeInspector === 'object'
      ? renderObjectInspector()
      : activeInspector === 'history'
        ? renderHistoryInspector()
        : renderDeliveryInspector();
};

chrome.runtime.onMessage?.addListener((message) => {
  if (
    message?.type === 'workspace/export-progress' &&
    message.sessionId === sessionId &&
    message.progress
  )
    receiveExportProgress(message.progress as WorkspaceExportProgress);
});

const CANVAS_MIN_WIDTH = 320;
const CANVAS_MIN_HEIGHT = 320;
const CANVAS_MAX_SIZE = 2560;
const CANVAS_PADDING = 32;
const ZOOM_STOPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

type CanvasSettings = {
  width: number;
  height: number;
  zoom: number;
  panX: number;
  panY: number;
};

type CanvasViewSnapshot = {
  stageScrollLeft: number;
  stageScrollTop: number;
  frameScrollLeft: number;
  frameScrollTop: number;
};

type RenderStateOptions = {
  frameUpdate?: 'reload' | 'replace' | 'keep';
  canvasView?: CanvasViewSnapshot | null;
};

let canvasSettings: CanvasSettings = {
  width: 1280,
  height: 800,
  zoom: 1,
  panX: 0,
  panY: 0,
};
let canvasSettingsKey = '';

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

const canvasStateKey = (state: WorkspacePageState) =>
  `dianjing:canvas:${localFileName ? `local:${localFileName}` : sessionId || state.url || 'workspace'}`;

const safeReadCanvasSettings = (key: string): Partial<CanvasSettings> => {
  try {
    const value = localStorage.getItem(key);
    if (!value) return {};
    const parsed = JSON.parse(value) as Partial<CanvasSettings>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const persistCanvasSettings = () => {
  if (!canvasSettingsKey) return;
  try {
    localStorage.setItem(canvasSettingsKey, JSON.stringify(canvasSettings));
  } catch {
    // A restricted extension page may not expose storage. The in-memory state
    // still survives normal workspace refreshes and command responses.
  }
};

const ensureCanvasSettings = (state: WorkspacePageState) => {
  const key = canvasStateKey(state);
  if (key === canvasSettingsKey) return;
  canvasSettingsKey = key;
  const stored = safeReadCanvasSettings(key);
  const sourceCanvas = state.canvas;
  canvasSettings = {
    width: clamp(
      Number(stored.width ?? sourceCanvas?.width ?? canvasSettings.width),
      CANVAS_MIN_WIDTH,
      CANVAS_MAX_SIZE,
    ),
    height: clamp(
      Number(stored.height ?? sourceCanvas?.height ?? canvasSettings.height),
      CANVAS_MIN_HEIGHT,
      CANVAS_MAX_SIZE,
    ),
    zoom: clamp(Number(stored.zoom ?? 1), ZOOM_STOPS[0]!, ZOOM_STOPS[ZOOM_STOPS.length - 1]!),
    panX: clamp(Number(stored.panX ?? 0), -CANVAS_MAX_SIZE, CANVAS_MAX_SIZE),
    panY: clamp(Number(stored.panY ?? 0), -CANVAS_MAX_SIZE, CANVAS_MAX_SIZE),
  };
};

const canvasElements = () => ({
  stage: app.querySelector<HTMLElement>('[data-canvas-stage]'),
  content: app.querySelector<HTMLElement>('[data-canvas-content]'),
  page: app.querySelector<HTMLElement>('[data-canvas-page]'),
  frame: app.querySelector<HTMLIFrameElement>('[data-page-frame]'),
});

const captureCanvasView = (): CanvasViewSnapshot | null => {
  const { stage, frame } = canvasElements();
  if (!stage && !frame) return null;
  return {
    stageScrollLeft: stage?.scrollLeft ?? 0,
    stageScrollTop: stage?.scrollTop ?? 0,
    frameScrollLeft: frame?.contentWindow?.scrollX ?? 0,
    frameScrollTop: frame?.contentWindow?.scrollY ?? 0,
  };
};

const restoreCanvasView = (view: CanvasViewSnapshot | null) => {
  if (!view) return;
  const { stage, frame } = canvasElements();
  if (!stage || !frame) return;
  const restore = () => {
    stage.scrollLeft = clamp(
      view.stageScrollLeft,
      0,
      Math.max(0, stage.scrollWidth - stage.clientWidth),
    );
    stage.scrollTop = clamp(
      view.stageScrollTop,
      0,
      Math.max(0, stage.scrollHeight - stage.clientHeight),
    );
    const frameWindow = frame.contentWindow;
    if (frameWindow) {
      frameWindow.scrollTo(
        clamp(
          view.frameScrollLeft,
          0,
          Math.max(0, frameWindow.document.documentElement.scrollWidth - frameWindow.innerWidth),
        ),
        clamp(
          view.frameScrollTop,
          0,
          Math.max(0, frameWindow.document.documentElement.scrollHeight - frameWindow.innerHeight),
        ),
      );
    }
    updateSelectionOverlays();
    renderGuides();
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(restore));
};

const revealSelectedTreeRows = () => {
  if (!pageState) return;
  for (const id of selectedIds) {
    let current = pageState.elements.find((element) => element.id === id);
    while (current?.parentId) {
      const parentId = current.parentId;
      expandedIds.add(parentId);
      current = pageState.elements.find((element) => element.id === parentId);
    }
  }
};

type SelectionRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

const unionSelectionRects = (rects: DOMRect[]): SelectionRect | null => {
  const visible = rects.filter((rect) => rect.width > 0 || rect.height > 0);
  if (!visible.length) return null;
  const left = Math.min(...visible.map((rect) => rect.left));
  const top = Math.min(...visible.map((rect) => rect.top));
  const right = Math.max(...visible.map((rect) => rect.right));
  const bottom = Math.max(...visible.map((rect) => rect.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

const selectionRectFor = (element: HTMLElement, item: WorkspaceElement): SelectionRect | null => {
  const resolved = resolveWorkspaceTargetHandle(item.target, element.ownerDocument);
  if (!resolved.ok) return null;
  if (resolved.handle.kind === 'text-fragment')
    return textFragmentClientRect(element, resolved.handle.fragment);
  const descendants = [element, ...element.querySelectorAll('*')];
  return unionSelectionRects(descendants.map((candidate) => candidate.getBoundingClientRect()));
};

const updateSelectionOverlays = () => {
  const layer = app.querySelector<HTMLElement>('[data-selection-overlay-layer]');
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  const doc = frame?.contentDocument;
  if (!layer || !frame || !doc || !selectedIds.length) {
    layer?.replaceChildren();
    return;
  }

  const targets = new Map<string, HTMLElement>();
  doc.querySelectorAll<HTMLElement>('[data-dianjing-target]').forEach((element) => {
    const id = element.dataset.dianjingTarget;
    if (id) targets.set(id, element);
  });
  const frameRect = frame.getBoundingClientRect();
  const layerRect = layer.getBoundingClientRect();
  const primaryId = primaryElement()?.id;
  const fragment = document.createDocumentFragment();

  selectedIds.forEach((id, index) => {
    const item = pageState?.elements.find((element) => element.id === id);
    const targetId = item ? workspaceTargetKey({ ...item.target, textNodeIndex: undefined }) : id;
    const target = targets.get(targetId);
    if (!target) return;
    const rect = item ? selectionRectFor(target, item) : null;
    if (!rect) return;
    const overlay = document.createElement('div');
    const movable = item?.capability !== 'unstable';
    const resizable = item?.target.textNodeIndex === undefined && movable;
    const anchor =
      selectedIds.length > 1 && index === 0 && !(guidesEnabled && currentWorkspaceGuide());
    overlay.className = `selection-overlay ${id === primaryId ? 'is-primary' : ''} ${anchor ? 'is-anchor' : ''} ${resizable ? 'is-resizable' : ''} ${movable ? 'is-movable' : ''}`;
    overlay.dataset.selectionOverlay = id;
    if (anchor) {
      overlay.dataset.selectionAnchor = 'true';
      overlay.setAttribute('aria-label', '对齐基准：首选对象');
    }
    overlay.style.left = `${frameRect.left - layerRect.left + rect.left * canvasSettings.zoom}px`;
    overlay.style.top = `${frameRect.top - layerRect.top + rect.top * canvasSettings.zoom}px`;
    overlay.style.width = `${Math.max(2, rect.width * canvasSettings.zoom)}px`;
    overlay.style.height = `${Math.max(2, rect.height * canvasSettings.zoom)}px`;
    if (id === primaryId) {
      if (movable) {
        const moveHandles = document.createElement('div');
        moveHandles.className = 'selection-move-handles';
        (['top', 'right', 'bottom', 'left'] as const).forEach((edge) => {
          const handle = document.createElement('button');
          handle.type = 'button';
          handle.className = `selection-move-handle selection-move-handle--${edge}`;
          handle.dataset.selectionMove = id;
          handle.setAttribute('aria-label', '拖动对象');
          handle.title = '拖动对象';
          moveHandles.append(handle);
        });
        overlay.append(moveHandles);
      }
      if (resizable) {
        const handles = document.createElement('div');
        handles.className = 'selection-resize-handles';
        (
          [
            ['top-left', '调整容器左上角'],
            ['top', '调整容器上边界'],
            ['top-right', '调整容器右上角'],
            ['right', '调整容器右边界'],
            ['bottom-right', '调整容器右下角'],
            ['bottom', '调整容器下边界'],
            ['bottom-left', '调整容器左下角'],
            ['left', '调整容器左边界'],
          ] as const
        ).forEach(([direction, label]) => {
          const handle = document.createElement('button');
          handle.type = 'button';
          handle.className = `selection-resize-handle selection-resize-handle--${direction}`;
          handle.dataset.selectionResize = direction;
          handle.dataset.selectionResizeTarget = id;
          handle.setAttribute('aria-label', label);
          handle.title = label;
          handles.append(handle);
        });
        overlay.append(handles);
      }
    } else if (selectedIds.length > 1) {
      const marker = document.createElement('span');
      marker.className = 'selection-overlay-index';
      marker.textContent = anchor ? `基准 · ${index + 1}` : String(index + 1);
      overlay.append(marker);
    }
    fragment.append(overlay);
  });
  layer.replaceChildren(fragment);
};

const currentWorkspaceGuide = () =>
  currentGuideId ? (workspaceGuides.find((guide) => guide.id === currentGuideId) ?? null) : null;

const guideOrientationLabel = (orientation: WorkspaceGuide['orientation']) =>
  orientation === 'vertical' ? '竖直' : '水平';

const guidePositionLimit = (orientation: WorkspaceGuide['orientation']) =>
  orientation === 'vertical' ? canvasSettings.width : canvasSettings.height;

const guidePositionFromPointer = (
  orientation: WorkspaceGuide['orientation'],
  clientX: number,
  clientY: number,
) => {
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  if (!frame) return 0;
  const frameRect = frame.getBoundingClientRect();
  const frameWindow = frame.contentWindow;
  const scrollX = frameWindow?.scrollX ?? 0;
  const scrollY = frameWindow?.scrollY ?? 0;
  const raw =
    orientation === 'vertical'
      ? (clientX - frameRect.left) / Math.max(canvasSettings.zoom, 0.01) + scrollX
      : (clientY - frameRect.top) / Math.max(canvasSettings.zoom, 0.01) + scrollY;
  return clamp(Math.round(raw), 0, guidePositionLimit(orientation));
};

const renderRulers = () => {
  const rulers = app.querySelector<HTMLElement>('[data-rulers]');
  const topTicks = app.querySelector<HTMLElement>('[data-ruler-ticks="top"]');
  const leftTicks = app.querySelector<HTMLElement>('[data-ruler-ticks="left"]');
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  const stage = app.querySelector<HTMLElement>('[data-canvas-stage]');
  if (!rulers || !topTicks || !leftTicks || !frame || !stage || !guidesEnabled) {
    if (rulers) rulers.hidden = true;
    return;
  }
  rulers.hidden = false;
  const frameRect = frame.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const zoom = Math.max(canvasSettings.zoom, 0.01);
  const frameLeft = frameRect.left - stageRect.left;
  const frameTop = frameRect.top - stageRect.top;
  const frameWindow = frame.contentWindow;
  const scrollX = frameWindow?.scrollX ?? 0;
  const scrollY = frameWindow?.scrollY ?? 0;
  const logicalStartX = Math.max(
    0,
    Math.floor(scrollX + (stageRect.left - frameRect.left) / zoom) - 120,
  );
  const logicalStartY = Math.max(
    0,
    Math.floor(scrollY + (stageRect.top - frameRect.top) / zoom) - 120,
  );
  const logicalEndX = Math.min(
    canvasSettings.width,
    Math.ceil(scrollX + (stageRect.right - frameRect.left) / zoom) + 120,
  );
  const logicalEndY = Math.min(
    canvasSettings.height,
    Math.ceil(scrollY + (stageRect.bottom - frameRect.top) / zoom) + 120,
  );
  const majorStep = zoom >= 1.5 ? 100 : zoom >= 0.75 ? 100 : 200;
  const minorStep = majorStep / 5;
  const topFragment = document.createDocumentFragment();
  for (
    let value = Math.floor(logicalStartX / minorStep) * minorStep;
    value <= logicalEndX;
    value += minorStep
  ) {
    if (value < 0) continue;
    const tick = document.createElement('i');
    const major = value % majorStep === 0;
    tick.className = `ruler-tick ${major ? 'is-major' : ''}`;
    tick.style.left = `${frameLeft + (value - scrollX) * zoom}px`;
    if (major) {
      const label = document.createElement('span');
      label.textContent = String(Math.round(value));
      tick.append(label);
    }
    topFragment.append(tick);
  }
  const leftFragment = document.createDocumentFragment();
  for (
    let value = Math.floor(logicalStartY / minorStep) * minorStep;
    value <= logicalEndY;
    value += minorStep
  ) {
    if (value < 0) continue;
    const tick = document.createElement('i');
    const major = value % majorStep === 0;
    tick.className = `ruler-tick ${major ? 'is-major' : ''}`;
    tick.style.top = `${frameTop + (value - scrollY) * zoom}px`;
    if (major) {
      const label = document.createElement('span');
      label.textContent = String(Math.round(value));
      tick.append(label);
    }
    leftFragment.append(tick);
  }
  topTicks.replaceChildren(topFragment);
  leftTicks.replaceChildren(leftFragment);
};

const renderGuides = () => {
  const layer = app.querySelector<HTMLElement>('[data-guide-overlay-layer]');
  if (!layer) return;
  const active = currentWorkspaceGuide();

  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  const stage = app.querySelector<HTMLElement>('[data-canvas-stage]');
  if (!guidesEnabled || !frame || !stage) {
    layer.hidden = true;
    layer.replaceChildren();
    return;
  }
  const frameRect = frame.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const frameWindow = frame.contentWindow;
  const scrollX = frameWindow?.scrollX ?? 0;
  const scrollY = frameWindow?.scrollY ?? 0;
  // The guide layer lives inside the scrollable stage.  getBoundingClientRect()
  // is viewport-relative, so using this value directly as an absolute child
  // coordinate would subtract stage.scrollLeft/scrollTop twice when the outer
  // canvas is scrolled.  Convert the page back to stage *content* coordinates
  // before writing line positions; the browser then applies the stage scroll
  // exactly once when painting the overlay.
  const stageScrollLeft = stage.scrollLeft;
  const stageScrollTop = stage.scrollTop;
  const frameLeft = frameRect.left - stageRect.left + stageScrollLeft;
  const frameTop = frameRect.top - stageRect.top + stageScrollTop;
  // The iframe is the complete outer canvas page.  Keep each line clipped to
  // that page boundary (rather than leaking into the surrounding gray pan
  // padding); the content-coordinate conversion above is what makes the same
  // span survive outer stage scrolling.
  const guideWidth = frameRect.width;
  const guideHeight = frameRect.height;
  const fragment = document.createDocumentFragment();
  workspaceGuides.forEach((guide) => {
    const line = document.createElement('button');
    line.type = 'button';
    line.className = `workspace-guide workspace-guide--${guide.orientation} ${guide.id === active?.id ? 'is-current' : ''}`;
    line.dataset.guideId = guide.id;
    line.setAttribute(
      'aria-label',
      `${guideOrientationLabel(guide.orientation)}参考线 ${Math.round(guide.position)} px`,
    );
    line.title = `${guideOrientationLabel(guide.orientation)}参考线 · ${Math.round(guide.position)} px`;
    if (guide.orientation === 'vertical') {
      line.style.left = `${frameLeft + (guide.position - scrollX) * canvasSettings.zoom}px`;
      line.style.top = `${frameTop}px`;
      line.style.height = `${guideHeight}px`;
    } else {
      line.style.left = `${frameLeft}px`;
      line.style.top = `${frameTop + (guide.position - scrollY) * canvasSettings.zoom}px`;
      line.style.width = `${guideWidth}px`;
    }
    const label = document.createElement('span');
    label.className = 'workspace-guide-label';
    label.textContent = `${guideOrientationLabel(guide.orientation)} ${Math.round(guide.position)} px`;
    line.append(label);
    fragment.append(line);
  });
  if (rulerPreview) {
    const preview = document.createElement('i');
    preview.className = `workspace-guide-preview workspace-guide-preview--${rulerPreview.orientation}`;
    preview.setAttribute(
      'aria-label',
      `正在预览${guideOrientationLabel(rulerPreview.orientation)}参考线 ${Math.round(rulerPreview.position)} px`,
    );
    if (rulerPreview.orientation === 'vertical') {
      preview.style.left = `${frameLeft + (rulerPreview.position - scrollX) * canvasSettings.zoom}px`;
      preview.style.top = `${frameTop}px`;
      preview.style.height = `${guideHeight}px`;
    } else {
      preview.style.left = `${frameLeft}px`;
      preview.style.top = `${frameTop + (rulerPreview.position - scrollY) * canvasSettings.zoom}px`;
      preview.style.width = `${guideWidth}px`;
    }
    const label = document.createElement('span');
    label.textContent = `${Math.round(rulerPreview.position)} px`;
    preview.append(label);
    fragment.append(preview);
  }
  layer.hidden = false;
  layer.replaceChildren(fragment);
  renderRulers();
};

const syncGuidesUi = () => {
  if (!guidesEnabled) {
    currentGuideId = null;
    rulerPreview = null;
    rulerDragStart = null;
  }
  app.dataset.guidesEnabled = String(guidesEnabled);
  const toggle = app.querySelector<HTMLButtonElement>('[data-action="toggle-guides"]');
  if (toggle) {
    toggle.classList.toggle('is-active', guidesEnabled);
    toggle.setAttribute('aria-pressed', String(guidesEnabled));
  }
  if (!guidesEnabled)
    app.querySelector<HTMLElement>('[data-measure-overlay]')?.setAttribute('hidden', '');
  if (pageState) applyCanvasView();
  else renderGuides();
  renderInspector();
};

const addWorkspaceGuide = (
  orientation: WorkspaceGuide['orientation'],
  position = Math.round(guidePositionLimit(orientation) / 2),
) => {
  if (!guidesEnabled) return;
  const guide: WorkspaceGuideState = {
    id: `guide-${++guideSequence}`,
    orientation,
    position: clamp(Math.round(position), 0, guidePositionLimit(orientation)),
  };
  workspaceGuides = [...workspaceGuides, guide];
  // A new guide starts as a visible helper. It only becomes an alignment
  // anchor after the user explicitly chooses it in the layout panel or on
  // the canvas line.
  currentGuideId = null;
  activeInspector = 'object';
  activeTask = 'layout';
  renderGuides();
  renderInspector();
};

const selectWorkspaceGuide = (id: string) => {
  if (!guidesEnabled || !workspaceGuides.some((guide) => guide.id === id)) return;
  currentGuideId = currentGuideId === id ? null : id;
  activeInspector = 'object';
  activeTask = 'layout';
  renderGuides();
  renderInspector();
};

const clearWorkspaceGuideSelection = () => {
  currentGuideId = null;
  activeInspector = 'object';
  activeTask = 'layout';
  renderGuides();
  renderInspector();
};

const deleteWorkspaceGuide = (id = currentGuideId) => {
  if (!id) return;
  if (!workspaceGuides.some((guide) => guide.id === id)) return;
  workspaceGuides = workspaceGuides.filter((guide) => guide.id !== id);
  // Deleting a selected guide deliberately returns to the neutral state; a
  // nearby guide must never become the alignment anchor implicitly.
  if (currentGuideId === id) currentGuideId = null;
  renderGuides();
  renderInspector();
};

const updateCanvasControls = () => {
  const width = app.querySelector<HTMLInputElement>('[data-canvas-width]');
  const height = app.querySelector<HTMLInputElement>('[data-canvas-height]');
  const zoom = app.querySelector<HTMLElement>('[data-zoom]');
  if (width) width.value = String(Math.round(canvasSettings.width));
  if (height) height.value = String(Math.round(canvasSettings.height));
  if (zoom) zoom.textContent = `${Math.round(canvasSettings.zoom * 100)}%`;
};

const updateSelectionSummary = () => {
  const count = app.querySelector<HTMLElement>('[data-selection-count]');
  const focus = app.querySelector<HTMLButtonElement>('[data-action="focus-selection"]');
  if (count)
    count.textContent = selectedIds.length ? `已选择 ${selectedIds.length} 个对象` : '未选择对象';
  if (focus) focus.disabled = selectedIds.length === 0;
};

const applyCanvasView = ({ resetScroll = true }: { resetScroll?: boolean } = {}) => {
  const { stage, content, page, frame } = canvasElements();
  if (!stage || !content || !page || !frame) return;
  const visualWidth = Math.max(1, canvasSettings.width * canvasSettings.zoom);
  const visualHeight = Math.max(1, canvasSettings.height * canvasSettings.zoom);
  const stageWidth = Math.max(1, stage.clientWidth);
  const stageHeight = Math.max(1, stage.clientHeight);
  const contentWidth = Math.max(
    stageWidth,
    visualWidth + CANVAS_PADDING + Math.abs(canvasSettings.panX) * 2,
  );
  const contentHeight = Math.max(
    stageHeight,
    visualHeight + CANVAS_PADDING + Math.abs(canvasSettings.panY) * 2,
  );
  // Keep the origin stable while the page is larger than the stage. Growing
  // the scrollable content to make room for a pan must not add a second copy
  // of the drag delta through recentering.
  const baseLeft =
    visualWidth + CANVAS_PADDING <= stageWidth
      ? (stageWidth - visualWidth) / 2
      : CANVAS_PADDING / 2;
  const baseTop =
    visualHeight + CANVAS_PADDING <= stageHeight
      ? (stageHeight - visualHeight) / 2
      : CANVAS_PADDING / 2;
  content.style.width = `${Math.ceil(contentWidth)}px`;
  content.style.height = `${Math.ceil(contentHeight)}px`;
  page.style.width = `${canvasSettings.width}px`;
  page.style.height = `${canvasSettings.height}px`;
  page.style.left = `${baseLeft + canvasSettings.panX}px`;
  page.style.top = `${baseTop + canvasSettings.panY}px`;
  page.style.transform = `scale(${canvasSettings.zoom})`;
  frame.style.width = `${canvasSettings.width}px`;
  frame.style.height = `${canvasSettings.height}px`;
  frame.style.transform = 'none';
  frame.style.transformOrigin = '0 0';
  if (resetScroll) {
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  }
  updateCanvasControls();
  updateSelectionOverlays();
  renderGuides();
};

const focusSelectedTreeRow = () => {
  const element = primaryElement();
  const tree = app.querySelector<HTMLElement>('[data-object-tree]');
  if (!element || !tree) return;
  const row = tree.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(element.id)}"]`);
  if (!row) return;
  const treeRect = tree.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  tree.scrollTop += rowRect.top - treeRect.top - (tree.clientHeight - rowRect.height) / 2;
};

const setCanvasZoom = (value: number) => {
  canvasSettings.zoom = clamp(value, ZOOM_STOPS[0]!, ZOOM_STOPS[ZOOM_STOPS.length - 1]!);
  persistCanvasSettings();
  applyCanvasView();
};

const stepCanvasZoom = (direction: -1 | 1) => {
  const current = canvasSettings.zoom;
  const next =
    direction > 0
      ? (ZOOM_STOPS.find((stop) => stop > current + 0.001) ?? ZOOM_STOPS[ZOOM_STOPS.length - 1]!)
      : ([...ZOOM_STOPS].reverse().find((stop) => stop < current - 0.001) ?? ZOOM_STOPS[0]!);
  setCanvasZoom(next);
};

const zoomCanvasWithWheel = (event: WheelEvent) => {
  if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
  event.preventDefault();
  event.stopPropagation();
  stepCanvasZoom(event.deltaY < 0 ? 1 : -1);
};

const fitCanvas = () => {
  const stage = app.querySelector<HTMLElement>('[data-canvas-stage]');
  if (!stage) return;
  const availableWidth = Math.max(1, stage.clientWidth - CANVAS_PADDING);
  const availableHeight = Math.max(1, stage.clientHeight - CANVAS_PADDING);
  setCanvasZoom(
    Math.min(
      ZOOM_STOPS[ZOOM_STOPS.length - 1]!,
      Math.max(
        ZOOM_STOPS[0]!,
        Math.min(
          availableWidth / Math.max(canvasSettings.width, 1),
          availableHeight / Math.max(canvasSettings.height, 1),
        ),
      ),
    ),
  );
  canvasSettings.panX = 0;
  canvasSettings.panY = 0;
  persistCanvasSettings();
  applyCanvasView();
};

const setCanvasDimension = (dimension: 'width' | 'height', value: number) => {
  canvasSettings[dimension] = clamp(
    Math.round(value),
    dimension === 'width' ? CANVAS_MIN_WIDTH : CANVAS_MIN_HEIGHT,
    CANVAS_MAX_SIZE,
  );
  persistCanvasSettings();
  applyCanvasView();
};

const renderState = ({ frameUpdate = 'reload', canvasView = null }: RenderStateOptions = {}) => {
  if (!pageState) return;
  ensureCanvasSettings(pageState);
  selectedIds = reconcileWorkspaceSelectionIds(
    selectedIds,
    pageState.selectedIds,
    selectableTargets(),
  );
  if (deletePendingId && !pageState.elements.some((element) => element.id === deletePendingId))
    deletePendingId = null;
  revealSelectedTreeRows();
  app.querySelector<HTMLElement>('[data-page-title]')!.textContent =
    pageState.title || '未命名页面';
  app.querySelector<HTMLElement>('[data-page-url]')!.textContent = pageState.url;
  const snapshotTime = new Date(pageState.capturedAt);
  app.querySelector<HTMLElement>('[data-page-snapshot]')!.textContent = Number.isNaN(
    snapshotTime.getTime(),
  )
    ? '当前页面快照'
    : `已同步 ${snapshotTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  setPageCapability(
    webCopyMode
      ? {
          icon: 'copy',
          tone: 'web-copy',
          label: '网页副本模式',
          description: '修改只作用于当前标签页，不会写回原网站。',
        }
      : {
          icon: capabilityIconFor(pageState.capabilityStatus),
          tone: capabilityToneFor(pageState.capabilityStatus),
          label: pageState.capabilityLabel,
          description: capabilityDescriptionFor(pageState.capabilityStatus),
        },
  );
  app.querySelector<HTMLElement>('[data-object-count]')!.textContent =
    `${selectableTargets().length} 个可选对象`;
  updateSelectionSummary();
  app.querySelector<HTMLElement>('[data-notice]')!.textContent = webCopyMode
    ? '网页副本模式：修改只作用于当前标签页，不会写回原网站'
    : pageState.notice || '页面状态已同步';
  const undoButton = app.querySelector<HTMLButtonElement>('[data-action="undo"]')!;
  const redoButton = app.querySelector<HTMLButtonElement>('[data-action="redo"]')!;
  undoButton.disabled = pageState.history.filter((entry) => !entry.cancelled).length === 0;
  redoButton.disabled = pageState.futureCount === 0;
  const changeCount = app.querySelector<HTMLElement>('[data-change-count]');
  if (changeCount)
    changeCount.textContent = String(pageState.history.filter((entry) => !entry.cancelled).length);
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]')!;
  const preservedCanvasView = canvasView ?? captureCanvasView();
  applyCanvasView({ resetScroll: !preservedCanvasView });
  if (!localSourceActive && frameUpdate !== 'keep') {
    frame.setAttribute('sandbox', 'allow-same-origin');
    if (frameUpdate === 'replace' && replaceCanvasSnapshot(pageState.snapshotHtml)) {
      restoreCanvasView(preservedCanvasView);
    } else {
      frame.addEventListener('load', bindFrame, { once: true });
      if (preservedCanvasView)
        frame.addEventListener('load', () => restoreCanvasView(preservedCanvasView), {
          once: true,
        });
      frame.srcdoc = pageState.snapshotHtml;
    }
  } else {
    updateFrameSelection();
    restoreCanvasView(preservedCanvasView);
  }
  app.querySelector<HTMLElement>('[data-canvas-loading]')!.hidden = true;
  renderRegionNavigation();
  renderObjectTree();
  renderInspector();
  syncCanvasMode();
  lastStableSelectionIds = [...selectedIds];
  lastStablePageState = pageState;
};

const setError = (message: string) => {
  const loading = app.querySelector<HTMLElement>('[data-canvas-loading]');
  if (loading)
    loading.innerHTML = `<strong>无法连接原页面</strong><span>${escapeHtml(message)}</span><button data-action="refresh">重新连接</button>`;
  setPageCapability({
    icon: 'capability-error',
    tone: 'error',
    label: '无法连接原页面',
    description: message,
  });
};

const normalizeWorkspaceUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('请输入网页地址');
  const parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('目前仅支持 http:// 或 https:// 页面地址');
  return parsed;
};

const openWorkspaceUrl = async (value: string) => {
  const parsed = normalizeWorkspaceUrl(value);
  const permissionOrigin = `${parsed.protocol}//${parsed.hostname}/*`;
  const submit = app.querySelector<HTMLButtonElement>('[data-open-url-form] button[type="submit"]');
  if (!chrome.permissions?.request) throw new Error('当前浏览器不支持链接授权');
  submit?.setAttribute('disabled', '');
  try {
    const granted = await chrome.permissions.request({ origins: [permissionOrigin] });
    if (!granted) throw new Error('未获得该站点的访问授权');
    const response = await chrome.runtime.sendMessage({
      type: 'workspace/open-url',
      url: parsed.href,
      sessionId,
    });
    if (!response?.ok || !response.sessionId) throw new Error(response?.error ?? '链接打开失败');
    location.assign(
      chrome.runtime.getURL(`workspace.html?session=${encodeURIComponent(response.sessionId)}`),
    );
  } finally {
    submit?.removeAttribute('disabled');
  }
};

const loadState = async () => {
  const previousState = pageState;
  const canvasView = previousState ? captureCanvasView() : null;
  const response = await request({ action: 'get-state', expandedTargets: expandedTargets() });
  if (!response.ok || !response.state) return setError(response.error ?? '原页面没有响应');
  webCopyMode = response.session?.sourceMode === 'web-copy';
  pageState = response.state;
  initializeTreeHierarchy();
  const styleOnlySnapshotChange =
    previousState &&
    snapshotsDifferOnlyByInlineStyles(previousState.snapshotHtml, response.state.snapshotHtml);
  if (styleOnlySnapshotChange) syncCanvasInlineStyles(response.state.snapshotHtml);
  const frameUpdate = previousState
    ? previousState.snapshotHtml === response.state.snapshotHtml || styleOnlySnapshotChange
      ? 'keep'
      : 'replace'
    : 'reload';
  renderState({ frameUpdate, canvasView });
};

const loadLocalHtmlIntoCanvas = async (file: File) => {
  const html = await file.text();
  const safeHtml = prepareLocalHtmlDocument(html, file.name);
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]')!;
  const loading = app.querySelector<HTMLElement>('[data-canvas-loading]')!;
  loading.hidden = false;
  loading.innerHTML = `<strong>正在载入“${escapeHtml(file.name)}”</strong><span>正在建立工作台文件会话…</span>`;
  localFileName = file.name;
  localSourceActive = true;
  canvasSettingsKey = '';
  pageState = null;
  selectedIds = [];
  expandedIds.clear();
  expandedCompressionKeys.clear();
  knownTreeRootIds.clear();
  activeInspector = 'object';
  activeTask = 'properties';
  frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');

  await new Promise<void>((resolve, reject) => {
    const handleLoad = () => {
      const document = frame.contentDocument;
      if (!document?.head || !frame.contentWindow)
        return reject(new Error('无法初始化本地文件画布'));
      const bootstrap = document.createElement('script');
      bootstrap.src = chrome.runtime.getURL('content.js');
      bootstrap.dataset.dianjingBootstrap = 'true';
      bootstrap.addEventListener('load', () => resolve(), { once: true });
      bootstrap.addEventListener('error', () => reject(new Error('点睛编辑引擎加载失败')), {
        once: true,
      });
      document.body.append(bootstrap);
    };
    frame.addEventListener('load', handleLoad, { once: true });
    frame.srcdoc = safeHtml;
  });

  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  const response = await request({ action: 'get-state', expandedTargets: expandedTargets() });
  if (!response.ok || !response.state)
    throw new Error(response.error ?? '本地文件编辑引擎没有响应');
  pageState = response.state;
  initializeTreeHierarchy();
  renderState();
  bindFrame();
  updateFrameSelection();
  app.querySelector<HTMLElement>('[data-notice]')!.textContent =
    `已在当前工作台载入“${file.name}”；脚本已禁用，修改会记录在该文件会话中`;
};

const renderSelectionUi = (focus = false) => {
  revealSelectedTreeRows();
  renderRegionNavigation();
  renderObjectTree();
  renderInspector();
  updateSelectionSummary();
  updateFrameSelection();
  if (focus) focusSelectedTreeRow();
};

const setSelectionNotice = (message: string) => {
  const notice = app.querySelector<HTMLElement>('[data-notice]');
  if (notice) notice.textContent = message;
};

const selectionMatches = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const restoreStableSelection = (message: string) => {
  if (lastStablePageState) pageState = lastStablePageState;
  selectedIds = [...lastStableSelectionIds];
  renderSelectionUi();
  setSelectionNotice(message);
};

const applySelectionResponse = (
  response: WorkspaceResponse,
  requestId: number,
  requestedIds: string[],
) => {
  if (!response.ok || !response.state) {
    if (requestId === selectionRequestId)
      restoreStableSelection(response.error ?? '目标对象已失效，已恢复上一次选择');
    return;
  }
  const responseIds = [...response.state.selectedIds];
  const available = new Set(
    (response.state.selectableTargets ?? response.state.elements).map((item) => item.id),
  );
  const responseIsComplete =
    selectionMatches(responseIds, requestedIds) && responseIds.every((id) => available.has(id));
  if (!responseIsComplete) {
    if (requestId === selectionRequestId)
      restoreStableSelection('目标对象定位失败，已恢复上一次选择；请刷新页面后重试');
    return;
  }
  lastStableSelectionIds = responseIds;
  lastStablePageState = response.state;
  if (requestId !== selectionRequestId) return;
  pageState = response.state;
  selectedIds = responseIds;
  renderSelectionUi(true);
};

const setSelection = (id: string, additive: boolean) => {
  if (!pageState) return;
  const nextIds = additive
    ? selectedIds.includes(id)
      ? selectedIds.filter((current) => current !== id)
      : [...selectedIds, id]
    : [id];
  const targets = nextIds.map(workspaceTargetForId);
  if (targets.some((target): target is null => target === null)) {
    setSelectionNotice('当前对象已不在页面中，正在保留原选择；请先同步页面');
    return;
  }
  deletePendingId = null;
  selectedIds = nextIds;
  currentGuideId = null;
  activeInspector = 'object';
  activeTask = selectedIds.length > 1 ? 'layout' : 'properties';
  renderSelectionUi();
  const requestId = ++selectionRequestId;
  selectionQueue = selectionQueue
    .then(async () => {
      const response = await request({
        action: 'select',
        targets: targets.filter((target): target is WorkspaceTarget => Boolean(target)),
      });
      applySelectionResponse(response, requestId, nextIds);
    })
    .catch((error) => {
      if (requestId !== selectionRequestId) return;
      restoreStableSelection(
        error instanceof Error ? error.message : '选择对象失败，已恢复上一次选择',
      );
    });
};

const clearWorkspaceSelection = () => {
  if (!pageState) return;
  selectedIds = [];
  currentGuideId = null;
  activeInspector = 'object';
  activeTask = 'properties';
  renderSelectionUi();
  const requestId = ++selectionRequestId;
  selectionQueue = selectionQueue
    .then(async () => {
      const response = await request({ action: 'select', targets: [] });
      applySelectionResponse(response, requestId, []);
    })
    .catch((error) => {
      if (requestId !== selectionRequestId) return;
      restoreStableSelection(
        error instanceof Error ? error.message : '清除选择失败，已恢复上一次选择',
      );
    });
};

const updateFrameSelection = () => {
  const doc = app.querySelector<HTMLIFrameElement>('[data-page-frame]')?.contentDocument;
  const selectedElementIds = new Set(
    selectedIds.map((id) => {
      const target = workspaceTargetForId(id);
      return target ? workspaceTargetKey({ ...target, textNodeIndex: undefined }) : id;
    }),
  );
  doc?.querySelectorAll<HTMLElement>('[data-dianjing-target]').forEach((element) => {
    if (selectedElementIds.has(element.dataset.dianjingTarget ?? ''))
      element.dataset.dianjingSelected = 'true';
    else element.removeAttribute('data-dianjing-selected');
  });
  updateSelectionOverlays();
  window.requestAnimationFrame(() => window.requestAnimationFrame(updateSelectionOverlays));
};

const placeObject = async (
  sourceId: string,
  destinationId: string,
  position: 'before' | 'after' | 'inside',
) => {
  if (!pageState || sourceId === destinationId) return;
  const source =
    pageState.elements.find((element) => element.id === sourceId)?.target ??
    targetFromKey(sourceId);
  const destination =
    pageState.elements.find((element) => element.id === destinationId)?.target ??
    targetFromKey(destinationId);
  if (!source || !destination) return;
  if (source.textNodeIndex !== undefined || destination.textNodeIndex !== undefined) {
    setError('文字对象不支持结构拖放，未改变父容器');
    return;
  }
  const response = await request({
    action: 'place',
    target: source,
    destination,
    position,
  });
  await refreshAfter(response);
};

const placeObjects = async (
  sourceIds: string[],
  destinationId: string,
  position: 'before' | 'after' | 'inside',
) => {
  if (!pageState) return;
  const uniqueIds = [...new Set(sourceIds)];
  const resolvedTargets = uniqueIds.map(workspaceTargetForId);
  const destination = workspaceTargetForId(destinationId);
  if (
    !resolvedTargets.length ||
    resolvedTargets.some((target): target is null => target === null) ||
    !destination
  )
    return setError('拖动对象已失效，请刷新工作台后重试');
  const targets = resolvedTargets as WorkspaceTarget[];
  if (
    targets.some((target) => target.textNodeIndex !== undefined) ||
    destination.textNodeIndex !== undefined
  ) {
    setError('文字对象不支持结构拖放，未改变父容器');
    return;
  }
  const response = await request({
    action: 'place-many',
    targets,
    destination,
    position,
  });
  await refreshAfter(response);
};

const treeItemForId = (id: string) =>
  selectableTargets().find((item) => item.id === id) ??
  pageState?.elements.find((item) => item.id === id);

const hasSelectedAncestor = (id: string, selected: ReadonlySet<string>) => {
  let current = treeItemForId(id);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    if (selected.has(current.parentId)) return true;
    current = treeItemForId(current.parentId);
  }
  return false;
};

const clearTreeDragState = () => {
  draggedTreeIds = [];
  app
    .querySelectorAll<HTMLElement>(
      '.tree-row.is-dragging,.tree-row.is-drop-before,.tree-row.is-drop-after,.tree-row.is-drop-inside',
    )
    .forEach((item) =>
      item.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after', 'is-drop-inside'),
    );
};

const dropPosition = (clientY: number, rect: DOMRect): 'before' | 'after' | 'inside' => {
  const ratio = rect.height ? (clientY - rect.top) / rect.height : 0.5;
  return ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside';
};

const syncCanvasMode = () => {
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  const stage = app.querySelector<HTMLElement>('[data-canvas-stage]');
  if (!frame || !stage) return;
  // Space-pan must be owned by the outer canvas. Leaving the iframe hit-testable
  // here lets native draggable images and the iframe pointer stream compete
  // with the canvas pan gesture.
  frame.style.pointerEvents = canvasMode === 'pan' || spaceHeld ? 'none' : 'auto';
  stage.dataset.canvasMode = canvasMode;
  app
    .querySelectorAll<HTMLElement>('[data-canvas-mode]')
    .forEach((button) =>
      button.classList.toggle('is-active', button.dataset.canvasMode === canvasMode),
    );
};

const frameDragStyleText =
  '[data-dianjing-target][draggable="true"]{cursor:grab!important}[data-dianjing-target][data-dianjing-selected="true"]{outline:2px solid #1677ef!important;outline-offset:2px!important}[data-dianjing-drop="before"]{box-shadow:inset 0 3px #1677ef!important}[data-dianjing-drop="after"]{box-shadow:inset 0 -3px #1677ef!important}[data-dianjing-drop="inside"]{outline:3px solid #1677ef!important;outline-offset:-3px!important;background-color:rgba(22,119,239,.06)!important}';

const boundFrameDocuments = new WeakSet<Document>();

const refreshFrameMarkup = () => {
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  const doc = frame?.contentDocument;
  if (!frame || !doc) return false;
  const dragStyle =
    doc.head?.querySelector<HTMLStyleElement>('[data-dianjing-frame-style]') ??
    doc.head?.appendChild(doc.createElement('style'));
  if (dragStyle) {
    dragStyle.dataset.dianjingFrameStyle = 'true';
    dragStyle.textContent = frameDragStyleText;
  }
  doc
    .querySelectorAll<HTMLElement>('[data-dianjing-target]')
    .forEach((element) => (element.draggable = true));
  updateFrameSelection();
  syncCanvasMode();
  return true;
};

const bindFrame = () => {
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  const doc = frame?.contentDocument;
  if (!frame || !doc) return;
  refreshFrameMarkup();
  if (boundFrameDocuments.has(doc)) return;
  boundFrameDocuments.add(doc);
  doc.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 1 && !spaceHeld) return;
      event.preventDefault();
      beginPan(event);
    },
    true,
  );
  doc.addEventListener(
    'pointermove',
    (event) => {
      if (!panStart && !resizeStart) return;
      event.preventDefault();
      moveCanvasPointer(event.clientX, event.clientY);
    },
    true,
  );
  doc.addEventListener(
    'pointerup',
    (event) => {
      if (!panStart && !resizeStart) return;
      event.preventDefault();
      endCanvasPointer(event.pointerId, event.clientX, event.clientY);
    },
    true,
  );
  doc.addEventListener('wheel', zoomCanvasWithWheel, { capture: true, passive: false });
  doc.addEventListener('keydown', handleSpaceKeyDown, true);
  doc.addEventListener('keyup', handleSpaceKeyUp, true);
  doc.defaultView?.addEventListener('blur', () => {
    setSpaceHeld(false);
    endCanvasPointer();
  });
  doc.defaultView?.addEventListener(
    'scroll',
    () => {
      updateSelectionOverlays();
      renderGuides();
    },
    { passive: true },
  );
  doc.addEventListener(
    'click',
    (event) => {
      const target =
        doc.defaultView && event.target instanceof doc.defaultView.Element
          ? event.target.closest<HTMLElement>('[data-dianjing-target]')
          : null;
      if (!target?.dataset.dianjingTarget) {
        if (
          event.button === 0 &&
          (event.target === doc.body || event.target === doc.documentElement)
        ) {
          event.preventDefault();
          event.stopPropagation();
          clearWorkspaceSelection();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void setSelection(target.dataset.dianjingTarget, event.ctrlKey || event.metaKey);
    },
    true,
  );
  doc.addEventListener(
    'mousemove',
    (event) => {
      const target =
        doc.defaultView && event.target instanceof doc.defaultView.Element
          ? event.target.closest<HTMLElement>('[data-dianjing-target]')
          : null;
      const overlay = app.querySelector<HTMLElement>('[data-measure-overlay]')!;
      if (!target || !guidesEnabled) return void (overlay.hidden = true);
      const rect = target.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const stageRect = app
        .querySelector<HTMLElement>('[data-canvas-stage]')!
        .getBoundingClientRect();
      Object.assign(overlay.style, {
        left: `${frameRect.left - stageRect.left + rect.left * canvasSettings.zoom}px`,
        top: `${frameRect.top - stageRect.top + rect.top * canvasSettings.zoom}px`,
        width: `${rect.width * canvasSettings.zoom}px`,
        height: `${rect.height * canvasSettings.zoom}px`,
      });
      overlay.querySelector('span')!.textContent =
        `${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
      overlay.hidden = false;
    },
    true,
  );
  doc.addEventListener(
    'dragstart',
    (event) => {
      if (spaceHeld || panStart || canvasMode === 'pan') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target =
        doc.defaultView && event.target instanceof doc.defaultView.Element
          ? event.target.closest<HTMLElement>('[data-dianjing-target]')
          : null;
      if (!target?.dataset.dianjingTarget) return;
      draggedId = target.dataset.dianjingTarget;
      event.dataTransfer?.setData('text/plain', draggedId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      target.dataset.dianjingDragging = 'true';
    },
    true,
  );
  doc.addEventListener(
    'dragover',
    (event) => {
      const target =
        doc.defaultView && event.target instanceof doc.defaultView.Element
          ? event.target.closest<HTMLElement>('[data-dianjing-target]')
          : null;
      if (
        !draggedId ||
        !target?.dataset.dianjingTarget ||
        target.dataset.dianjingTarget === draggedId
      )
        return;
      event.preventDefault();
      doc
        .querySelectorAll<HTMLElement>('[data-dianjing-drop]')
        .forEach((element) => element.removeAttribute('data-dianjing-drop'));
      target.dataset.dianjingDrop = dropPosition(event.clientY, target.getBoundingClientRect());
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    },
    true,
  );
  doc.addEventListener(
    'drop',
    (event) => {
      const target =
        doc.defaultView && event.target instanceof doc.defaultView.Element
          ? event.target.closest<HTMLElement>('[data-dianjing-target]')
          : null;
      const sourceId = draggedId ?? event.dataTransfer?.getData('text/plain');
      const destinationId = target?.dataset.dianjingTarget;
      const position = target?.dataset.dianjingDrop as 'before' | 'after' | 'inside' | undefined;
      event.preventDefault();
      if (sourceId && destinationId && position)
        void placeObject(sourceId, destinationId, position);
      draggedId = null;
      doc
        .querySelectorAll<HTMLElement>('[data-dianjing-drop],[data-dianjing-dragging]')
        .forEach((element) => {
          element.removeAttribute('data-dianjing-drop');
          element.removeAttribute('data-dianjing-dragging');
        });
    },
    true,
  );
  doc.addEventListener(
    'dragend',
    () => {
      draggedId = null;
      doc
        .querySelectorAll<HTMLElement>('[data-dianjing-drop],[data-dianjing-dragging]')
        .forEach((element) => {
          element.removeAttribute('data-dianjing-drop');
          element.removeAttribute('data-dianjing-dragging');
        });
    },
    true,
  );
  doc.addEventListener(
    'mouseout',
    (event) => {
      if (
        !doc.defaultView ||
        !(event.relatedTarget instanceof doc.defaultView.Node) ||
        !doc.documentElement.contains(event.relatedTarget)
      )
        app.querySelector<HTMLElement>('[data-measure-overlay]')!.hidden = true;
    },
    true,
  );
  updateFrameSelection();
  syncCanvasMode();
};

const replaceCanvasSnapshot = (snapshotHtml: string) => {
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  const doc = frame?.contentDocument;
  if (!frame || !doc?.documentElement) return false;
  const parsed = new DOMParser().parseFromString(snapshotHtml, 'text/html');
  if (!parsed.documentElement) return false;
  doc.documentElement.replaceWith(doc.importNode(parsed.documentElement, true));
  return refreshFrameMarkup();
};

const snapshotWithoutInlineStyles = (snapshotHtml: string) => {
  const parsed = new DOMParser().parseFromString(snapshotHtml, 'text/html');
  parsed
    .querySelectorAll<HTMLElement>('[style]')
    .forEach((element) => element.removeAttribute('style'));
  return parsed.documentElement?.outerHTML ?? '';
};

const snapshotsDifferOnlyByInlineStyles = (before: string, after: string) =>
  before !== after && snapshotWithoutInlineStyles(before) === snapshotWithoutInlineStyles(after);

const syncCanvasInlineStyles = (snapshotHtml: string) => {
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  const doc = frame?.contentDocument;
  if (!frame || !doc) return false;
  const snapshotDocument = new DOMParser().parseFromString(snapshotHtml, 'text/html');
  const currentByTarget = new Map(
    [...doc.querySelectorAll<HTMLElement>('[data-dianjing-target]')].map((element) => [
      element.dataset.dianjingTarget ?? '',
      element,
    ]),
  );
  let synced = false;
  snapshotDocument
    .querySelectorAll<HTMLElement>('[data-dianjing-target]')
    .forEach((snapshotElement) => {
      const target = currentByTarget.get(snapshotElement.dataset.dianjingTarget ?? '');
      if (!target) return;
      const style = snapshotElement.getAttribute('style');
      if (style === null) target.removeAttribute('style');
      else target.setAttribute('style', style);
      synced = true;
    });
  if (synced) refreshFrameMarkup();
  return synced;
};

const canvasElementForTarget = (target: WorkspaceTarget, root: ParentNode): HTMLElement | null => {
  const resolved = resolveWorkspaceTargetHandle(target, root);
  if (resolved.ok) {
    const layout =
      resolved.handle.kind === 'text-fragment'
        ? materializeWorkspaceLayoutHandle(resolved.handle)?.layoutElement
        : resolved.handle.element;
    if (layout) return layout;
  }
  const targetKey = workspaceTargetKey({ ...target, textNodeIndex: undefined });
  const byWorkspaceTarget = [...root.querySelectorAll<HTMLElement>('[data-dianjing-target]')].find(
    (element) => element.dataset.dianjingTarget === targetKey,
  );
  if (byWorkspaceTarget) return byWorkspaceTarget;
  if (target.editId) {
    const byEditId = [...root.querySelectorAll<HTMLElement>('[data-edit-id]')].find(
      (element) => element.dataset.editId === target.editId,
    );
    if (byEditId) return byEditId;
  }
  if (target.fallbackSelector) {
    try {
      return root.querySelector<HTMLElement>(target.fallbackSelector);
    } catch {
      return null;
    }
  }
  return null;
};

const applyWorkspaceStyleChangeToCanvas = (change: WorkspaceChange, snapshotHtml: string) => {
  if (change.kind !== 'style') return false;
  const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
  const doc = frame?.contentDocument;
  if (!frame || !doc) return false;
  const target = canvasElementForTarget(change.target, doc);
  if (!target) return false;

  const snapshotDocument = new DOMParser().parseFromString(snapshotHtml, 'text/html');
  const snapshotTarget = canvasElementForTarget(change.target, snapshotDocument);
  if (snapshotTarget) {
    const style = snapshotTarget.getAttribute('style');
    if (style === null) target.removeAttribute('style');
    else target.setAttribute('style', style);
  } else if (change.after.trim()) target.style.setProperty(change.property, change.after);
  else target.style.removeProperty(change.property);
  return true;
};

const refreshAfter = async (
  response: WorkspaceResponse,
  options: { change?: WorkspaceChange } = {},
) => {
  if (!response.ok || !response.state) return setError(response.error ?? '操作失败');
  const previousState = pageState;
  const canvasView = captureCanvasView();
  const change = options.change;
  const styleChange = change?.kind === 'style';
  const styleOnlySnapshotChange =
    !styleChange &&
    Boolean(
      previousState &&
      snapshotsDifferOnlyByInlineStyles(previousState.snapshotHtml, response.state.snapshotHtml),
    );
  if (styleChange) {
    applyWorkspaceStyleChangeToCanvas(change, response.state.snapshotHtml);
    syncCanvasInlineStyles(response.state.snapshotHtml);
  } else if (styleOnlySnapshotChange) syncCanvasInlineStyles(response.state.snapshotHtml);
  const frameUpdate =
    localSourceActive || styleChange || styleOnlySnapshotChange ? 'keep' : 'replace';
  if (response.session?.sourceMode) webCopyMode = response.session.sourceMode === 'web-copy';
  pageState = response.state;
  selectedIds = [...pageState.selectedIds];
  renderState({ frameUpdate, canvasView });
};

const commitChange = (change: WorkspaceChange) => {
  changeQueue = changeQueue.then(async () => {
    try {
      await refreshAfter(await request({ action: 'change', change }), { change });
    } catch (error) {
      setError(error instanceof Error ? error.message : '修改失败');
    }
  });
  return changeQueue;
};

const scheduleChange = (change: WorkspaceChange, delay = 160) => {
  const key = changeKey(change);
  const existing = scheduledChanges.get(key);
  if (existing) window.clearTimeout(existing.timer);
  const timer = window.setTimeout(() => {
    scheduledChanges.delete(key);
    void commitChange(change);
  }, delay);
  scheduledChanges.set(key, { timer, change });
};

const flushScheduledChanges = () => {
  for (const [key, scheduled] of scheduledChanges) {
    window.clearTimeout(scheduled.timer);
    scheduledChanges.delete(key);
    void commitChange(scheduled.change);
  }
};

const downloadHtml = async () => {
  if (exportingHtml) return;
  const notice = app.querySelector<HTMLElement>('[data-notice]');
  exportingHtml = true;
  exportReport = null;
  exportProgress = { stage: 'scan', completed: 0, total: 1, label: '正在扫描页面结构' };
  renderInspector();
  if (notice) notice.textContent = '正在收集页面资源并生成离线 HTML…';
  try {
    const response = await request({ action: 'export-html' });
    if (!response.ok || !response.html) throw new Error(response.error ?? 'HTML 导出失败');
    const blob = new Blob([response.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `点睛-${(pageState?.title || '页面').replace(/[\\/:*?"<>|]/g, '-')}.html`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const warningNote = response.warnings?.length
      ? ` · ${response.warnings.length} 项样式资源在原网页已不存在，已用占位保留版面`
      : '';
    exportReport = {
      tone: 'complete',
      message: `离线 HTML 已生成 · ${(blob.size / 1024 / 1024).toFixed(1)} MB${warningNote}`,
    };
    if (notice)
      notice.textContent = response.warnings?.length
        ? `离线 HTML 已下载；${response.warnings.length} 项原网页缺失的样式资源已使用占位，不影响导出完成`
        : '离线 HTML 已下载；打开时不需要连接原网站';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'HTML 导出失败';
    exportReport = { tone: 'failed', message: `导出未完成 · ${message}` };
    if (notice) notice.textContent = `离线 HTML 未生成：${message}`;
  } finally {
    exportingHtml = false;
    exportProgress = null;
    renderInspector();
  }
};

const safeFileStem = (value: string) =>
  [...value]
    .map((character) =>
      character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character) ? '-' : character,
    )
    .join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 80) || '页面';

const downloadViewportPng = async () => {
  const notice = app.querySelector<HTMLElement>('[data-notice]')!;
  if (!sessionId) {
    notice.textContent = '当前本地文件画布暂不支持整页 PNG；可先导出 HTML 后在页面中截图';
    return;
  }
  notice.textContent = '正在隐藏扩展界面并生成原页面整页 PNG…';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'workspace/capture-visible',
      sessionId,
    });
    if (!response?.ok || !response.dataUrl) throw new Error(response?.error ?? '截图失败');
    const anchor = document.createElement('a');
    anchor.href = response.dataUrl;
    anchor.download = `点睛-${safeFileStem(response.title || pageState?.title || '页面')}-整页.png`;
    anchor.click();
    notice.textContent = '整页 PNG 已导出，原页面、点睛界面和滚动位置已恢复';
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : '整页 PNG 导出失败';
  }
};

const showEntryLanding = () => {
  const loading = app.querySelector<HTMLElement>('[data-canvas-loading]')!;
  const title =
    entryMode === 'file-access'
      ? '开启本地文件访问'
      : entryMode === 'restricted'
        ? '当前页面受浏览器保护'
        : '从一个页面开始';
  const description =
    entryReason ||
    (entryMode === 'blank'
      ? '选择本地 HTML，直接在完整工作台中开始编辑。'
      : '你仍可选择本地 HTML 进入工作台。');
  loading.hidden = false;
  loading.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span>${
    entryMode === 'file-access'
      ? '<button data-action="open-file-access-settings">前往扩展设置</button>'
      : '<button data-action="open-html">选择本地 HTML</button>'
  }`;
  app.querySelector<HTMLElement>('[data-page-title]')!.textContent = title;
  app.querySelector<HTMLElement>('[data-page-url]')!.textContent = '点睛完整工作台';
  setPageCapability({
    icon: 'capability-checking',
    tone: 'waiting',
    label: '等待页面',
    description,
  });
  app.querySelector<HTMLElement>('[data-notice]')!.textContent = description;
  app.querySelector<HTMLButtonElement>('[data-action="return-source"]')!.hidden = true;
};

const inferPromptKind = (entry: WorkspacePageState['history'][number]): PromptOperationKind => {
  if (entry.kind) return entry.kind;
  if (entry.label.includes('文字')) return 'text';
  if (entry.label.includes('移动') || entry.label.includes('上移') || entry.label.includes('下移'))
    return 'structure';
  return 'style';
};

const promptOperationFromHistory = (
  entry: WorkspacePageState['history'][number],
): PromptOperationInput => ({
  id: entry.id,
  kind: inferPromptKind(entry),
  property: entry.property ?? 'unspecified',
  before: entry.before ?? '[修改前状态未记录]',
  after: entry.after ?? '[修改后状态未记录]',
  beforeSource: entry.beforeSource,
  label: entry.label,
  targetLabel: entry.targetLabel,
  semanticPath: entry.semanticPath,
  target: entry.target,
  textNodeIndex: entry.textNodeIndex,
  createdAt: entry.createdAt,
});

const copyPrompt = async () => {
  if (promptCopyStatus === 'copying') return;
  const records = pageState?.history.filter((entry) => !entry.cancelled) ?? [];
  const packet = buildAiPromptPacket(
    {
      url: pageState?.url ?? '',
      title: pageState?.title ?? '',
      sourceMode: webCopyMode ? '网页副本模式' : '当前页面',
      viewport: pageState?.canvas,
    },
    records.map(promptOperationFromHistory),
  );
  const prompt = packet.prompt;
  promptCopyStatus = 'copying';
  renderInspector();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前页面不支持剪贴板写入');
    await navigator.clipboard.writeText(prompt);
    promptCopyStatus = 'success';
  } catch {
    promptCopyStatus = 'error';
  }
  renderInspector();
};

shell();
syncGuidesUi();
if (entryMode) showEntryLanding();
else void loadState();

document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'visible' &&
    pageState &&
    !localSourceActive &&
    !entryMode &&
    !exportingHtml &&
    sessionId
  )
    void loadState();
});

const handleEditorInput = (
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  delay = 160,
) => {
  const element = primaryElement();
  if (!element) return;
  if (input instanceof HTMLTextAreaElement && input.dataset.textEditor !== undefined) {
    scheduleChange(
      {
        target: element.target,
        kind: 'text',
        property: 'textContent',
        textNodeIndex: element.target.textNodeIndex,
        after: input.value,
        label: '修改文字',
      },
      delay,
    );
    return;
  }
  if (input.dataset.draftProperty || input.dataset.styleProperty) {
    if (input instanceof HTMLInputElement && input.type === 'number' && !input.value) return;
    const property = input.dataset.draftProperty ?? input.dataset.styleProperty!;
    const after =
      input instanceof HTMLInputElement && input.dataset.unit === 'px'
        ? `${input.value}px`
        : input.value;
    if (
      input.dataset.positionOffset !== undefined &&
      element.styles.position === 'static' &&
      !pendingRelativePositionIds.has(element.id)
    ) {
      pendingRelativePositionIds.add(element.id);
      void commitChange({
        target: element.target,
        kind: 'style',
        property: 'position',
        after: 'relative',
        label: '启用对象自由移动',
      }).finally(() => pendingRelativePositionIds.delete(element.id));
    }
    scheduleChange(
      {
        target: element.target,
        kind: 'style',
        property,
        after,
        label: `调整${input.closest('label')?.querySelector('span')?.textContent ?? '样式'}`,
      },
      delay,
    );
    if (input instanceof HTMLInputElement && input.dataset.rangeControl) {
      const rangeControl = input.closest('.range-control');
      const linked = rangeControl?.querySelector<HTMLInputElement>(
        input.dataset.rangeControl === 'slider'
          ? '[data-range-control="number"]'
          : '[data-range-control="slider"]',
      );
      if (linked) linked.value = input.value;
    }
    if (input instanceof HTMLInputElement && input.type === 'color') {
      const code = input.closest('.color-control')?.querySelector('code');
      if (code) code.textContent = input.value;
    }
  }
};

app.addEventListener('input', (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.dataset.guidePosition) {
    const guide = workspaceGuides.find((item) => item.id === input.dataset.guidePosition);
    const value = Number(input.value);
    if (guide && Number.isFinite(value)) {
      currentGuideId = guide.id;
      guide.position = clamp(Math.round(value), 0, guidePositionLimit(guide.orientation));
      renderGuides();
    }
    return;
  }
  if (input instanceof HTMLInputElement && input.dataset.canvasWidth !== undefined) {
    const value = Number(input.value);
    if (Number.isFinite(value)) setCanvasDimension('width', value);
    return;
  }
  if (input instanceof HTMLInputElement && input.dataset.canvasHeight !== undefined) {
    const value = Number(input.value);
    if (Number.isFinite(value)) setCanvasDimension('height', value);
    return;
  }
  if (input instanceof HTMLInputElement && input.dataset.objectFilter !== undefined) {
    filter = input.value;
    renderObjectTree();
    return;
  }
  if (input instanceof HTMLInputElement && (input.type === 'range' || input.type === 'color'))
    handleEditorInput(input);
});

app.addEventListener('change', (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.dataset.guidePosition) {
    const guide = workspaceGuides.find((item) => item.id === input.dataset.guidePosition);
    if (guide) {
      currentGuideId = guide.id;
      const value = Number(input.value);
      guide.position = clamp(
        Math.round(Number.isFinite(value) ? value : guide.position),
        0,
        guidePositionLimit(guide.orientation),
      );
      input.value = String(Math.round(guide.position));
      renderGuides();
      renderInspector();
    }
    return;
  }
  if (input instanceof HTMLInputElement && input.dataset.canvasWidth !== undefined) {
    const value = Number(input.value);
    setCanvasDimension('width', Number.isFinite(value) ? value : canvasSettings.width);
    return;
  }
  if (input instanceof HTMLInputElement && input.dataset.canvasHeight !== undefined) {
    const value = Number(input.value);
    setCanvasDimension('height', Number.isFinite(value) ? value : canvasSettings.height);
    return;
  }
  if (
    (input instanceof HTMLInputElement ||
      input instanceof HTMLSelectElement ||
      input instanceof HTMLTextAreaElement) &&
    (input.dataset.draftProperty ||
      input.dataset.styleProperty ||
      input.dataset.textEditor !== undefined)
  ) {
    handleEditorInput(input, 0);
    return;
  }
  if (!(input instanceof HTMLInputElement) || input.dataset.htmlInput === undefined) return;
  const file = input.files?.[0];
  if (!file) return;
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith('.html') && !lowerName.endsWith('.htm')) {
    app.querySelector<HTMLElement>('[data-notice]')!.textContent = '只支持打开 .html 或 .htm 文件';
    input.value = '';
    return;
  }
  app.querySelector<HTMLElement>('[data-notice]')!.textContent = `正在打开“${file.name}”…`;
  input.value = '';
  void (async () => {
    try {
      await loadLocalHtmlIntoCanvas(file);
    } catch (error) {
      localSourceActive = false;
      localFileName = '';
      const detail = error instanceof Error && error.message ? `：${error.message}` : '';
      app.querySelector<HTMLElement>('[data-notice]')!.textContent = `本地 HTML 打开失败${detail}`;
      setError(`本地 HTML 打开失败${detail}`);
    }
  })();
});

app.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.dataset.openUrlForm === undefined) return;
  event.preventDefault();
  const input = form.querySelector<HTMLInputElement>('[data-open-url-input]');
  void openWorkspaceUrl(input?.value ?? '').catch((error) => {
    app.querySelector<HTMLElement>('[data-notice]')!.textContent =
      error instanceof Error ? error.message : '链接打开失败';
  });
});

app.addEventListener('click', (event) => {
  const target =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('button,[data-object-id],[data-action="zoom-100"]')
      : null;
  if (!target) return;
  if (target.dataset.treeMode) {
    const nextMode = target.dataset.treeMode as ObjectTreeMode;
    if (nextMode === treeMode) return;
    const compressedRows =
      nextMode === 'full'
        ? buildObjectTreeRows(pageState?.elements ?? [], {
            mode: treeMode,
            expandedIds,
            expandedCompressionKeys,
            selectedIds,
            filter: '',
          }).filter((row) => row.kind === 'compression')
        : [];
    compressedRows.forEach((row) => row.hiddenIds.forEach((id) => expandedIds.add(id)));
    captureTreeScrollAnchor();
    treeMode = nextMode;
    renderObjectTree();
    if (compressedRows.length) void loadState();
    return;
  }
  if (target.dataset.treeCompression) {
    const key = target.dataset.treeCompression;
    captureTreeScrollAnchor(`[data-tree-compression="${CSS.escape(key)}"]`);
    if (expandedCompressionKeys.has(key)) expandedCompressionKeys.delete(key);
    else expandedCompressionKeys.add(key);
    renderObjectTree();
    return;
  }
  if (target.dataset.toggleTree) {
    const id = target.dataset.toggleTree;
    captureTreeScrollAnchor(`[data-object-id="${CSS.escape(id)}"]`);
    if (expandedIds.has(id)) {
      expandedIds.delete(id);
      renderObjectTree();
    } else {
      expandedIds.add(id);
      void loadState();
    }
    return;
  }
  if (target.dataset.regionTargetId) {
    const search = app.querySelector<HTMLInputElement>('[data-object-filter]');
    filter = '';
    if (search) search.value = '';
    return void setSelection(target.dataset.regionTargetId, false);
  }
  if (target.dataset.objectId)
    return void setSelection(target.dataset.objectId, event.ctrlKey || event.metaKey);
  if (target.dataset.guideSelect) {
    selectWorkspaceGuide(target.dataset.guideSelect);
    return;
  }
  if (target.dataset.guideSelectNone !== undefined) {
    clearWorkspaceGuideSelection();
    return;
  }
  if (target.dataset.guideId) {
    if (suppressGuideClick) {
      suppressGuideClick = false;
      return;
    }
    selectWorkspaceGuide(target.dataset.guideId);
    return;
  }
  if (target.dataset.guideDelete) {
    deleteWorkspaceGuide(target.dataset.guideDelete);
    return;
  }
  if (target.dataset.task) {
    activeTask = target.dataset.task as typeof activeTask;
    activeInspector = 'object';
    renderInspector();
    return;
  }
  if (target.dataset.inspector) {
    activeInspector = target.dataset.inspector as typeof activeInspector;
    renderInspector();
    return;
  }
  const element = primaryElement();
  if (target.dataset.styleProperty && target.dataset.styleValue !== undefined && element) {
    const change: WorkspaceChange = {
      target: element.target,
      kind: 'style',
      property: target.dataset.styleProperty,
      after: target.dataset.styleValue,
      label: target.dataset.styleLabel ?? '调整文字位置',
    };
    flushScheduledChanges();
    return void commitChange(change);
  }
  if (target.dataset.visibility && element) {
    const change: WorkspaceChange = {
      target: element.target,
      kind: 'style',
      property: 'visibility',
      after: target.dataset.visibility,
      label: target.dataset.visibility === 'hidden' ? '暂时隐藏对象' : '恢复对象显示',
    };
    flushScheduledChanges();
    return void commitChange(change);
  }
  if (target.dataset.format && element) {
    const format = target.dataset.format;
    let change: WorkspaceChange;
    if (format === 'bold') {
      const current = Number.parseInt(element.styles['font-weight'] ?? '400', 10) || 400;
      change = {
        target: element.target,
        kind: 'style',
        property: 'font-weight',
        after: current >= 700 ? '400' : '700',
        label: '切换加粗',
      };
    } else if (format === 'italic') {
      const current = element.styles['font-style'] ?? 'normal';
      change = {
        target: element.target,
        kind: 'style',
        property: 'font-style',
        after: current === 'italic' ? 'normal' : 'italic',
        label: '切换倾斜',
      };
    } else {
      const token = format === 'underline' ? 'underline' : 'line-through';
      const current = (element.styles['text-decoration'] ?? 'none')
        .split(/\s+/)
        .filter((part) => part && part !== 'none');
      const next = current.includes(token)
        ? current.filter((part) => part !== token)
        : [...current, token];
      change = {
        target: element.target,
        kind: 'style',
        property: 'text-decoration',
        after: next.join(' ') || 'none',
        label: format === 'underline' ? '切换下划线' : '切换删除线',
      };
    }
    flushScheduledChanges();
    return void commitChange(change);
  }
  const action = target.dataset.action;
  if (action === 'add-guide') {
    addWorkspaceGuide(target.dataset.guideOrientation as WorkspaceGuide['orientation']);
    return;
  }
  if (target.dataset.canvasMode) {
    canvasMode = target.dataset.canvasMode as typeof canvasMode;
    syncCanvasMode();
    return;
  }
  if (action === 'refresh') return void loadState();
  if (action === 'return-source')
    return void chrome.runtime.sendMessage({ type: 'workspace/focus-source', sessionId });
  if (action === 'open-html')
    return void app.querySelector<HTMLInputElement>('[data-html-input]')?.click();
  if (action === 'open-url') {
    const dialog = app.querySelector<HTMLDialogElement>('[data-open-url-dialog]');
    if (!dialog?.open) dialog?.showModal();
    return void dialog?.querySelector<HTMLInputElement>('[data-open-url-input]')?.focus();
  }
  if (action === 'close-url-dialog')
    return void app.querySelector<HTMLDialogElement>('[data-open-url-dialog]')?.close();
  if (action === 'open-file-access-settings') {
    return void chrome.runtime.sendMessage({ type: 'extension/open-file-access-settings' });
  }
  if (action === 'toggle-guides') {
    guidesEnabled = !guidesEnabled;
    syncGuidesUi();
    return;
  }
  if (action === 'show-history') {
    activeInspector = activeInspector === 'history' ? 'object' : 'history';
    renderInspector();
    return;
  }
  if (action === 'show-delivery') {
    activeInspector = 'delivery';
    renderInspector();
    return;
  }
  if (action === 'collapse-all') {
    const expandable = pageState?.elements.filter((element) => element.hasChildren) ?? [];
    if (expandable.every((element) => expandedIds.has(element.id))) {
      expandedIds.clear();
      target.textContent = '展开当前层';
      renderObjectTree();
    } else {
      expandable.forEach((element) => expandedIds.add(element.id));
      target.textContent = '全部收起';
      void loadState();
    }
    return;
  }
  if (action === 'clear-selection') {
    clearWorkspaceSelection();
    return;
  }
  if (action === 'focus-selection') {
    focusSelectedTreeRow();
    return;
  }
  if (action === 'undo' || action === 'redo') return void request({ action }).then(refreshAfter);
  if (action === 'workspace-delete-cancel') {
    deletePendingId = null;
    renderInspector();
    return;
  }
  if (action === 'workspace-delete-confirm' && element) {
    deletePendingId = null;
    return void request({ action: 'delete', target: element.target }).then(refreshAfter);
  }
  if (action === 'zoom-in' || action === 'zoom-out') {
    stepCanvasZoom(action === 'zoom-in' ? 1 : -1);
    return;
  }
  if (action === 'zoom-100') {
    setCanvasZoom(1);
    return;
  }
  if (action === 'fit-canvas') {
    fitCanvas();
    return;
  }
  if (action === 'export-html') return void downloadHtml();
  if (action === 'export-viewport-png') return void downloadViewportPng();
  if (action === 'copy-prompt') return void copyPrompt();
  if (target.dataset.batchAlign && pageState) {
    const guide = guidesEnabled ? currentWorkspaceGuide() : null;
    return void request({
      action: 'align',
      targets: selectedElements().map((item) => item.target),
      alignment: target.dataset.batchAlign as
        'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom',
      ...(guide
        ? { guide: { orientation: guide.orientation, position: Math.round(guide.position) } }
        : {}),
    }).then(refreshAfter);
  }
  if (target.dataset.distribute && pageState)
    return void request({
      action: 'distribute',
      targets: selectedElements().map((item) => item.target),
      direction: target.dataset.distribute as 'horizontal' | 'vertical',
    }).then(refreshAfter);
  if (target.dataset.size && pageState)
    return void request({
      action: 'size',
      targets: selectedElements().map((item) => item.target),
      dimension: target.dataset.size as 'width' | 'height' | 'both',
    }).then(refreshAfter);
  if (action === 'apply-gap' && pageState) {
    const direction = app.querySelector<HTMLSelectElement>('[data-gap-direction]')?.value as
      'horizontal' | 'vertical';
    const value = Number(app.querySelector<HTMLInputElement>('[data-gap-value]')?.value ?? 0);
    return void request({
      action: 'gap',
      targets: selectedElements().map((item) => item.target),
      direction,
      value,
    }).then(refreshAfter);
  }
  if (action === 'create-group' && pageState)
    return void request({
      action: 'group',
      targets: selectedElements().map((item) => item.target),
    }).then(refreshAfter);
  if (action === 'select-siblings' && pageState && element?.parentId) {
    selectedIds = pageState.elements
      .filter((item) => item.parentId === element.parentId)
      .map((item) => item.id);
    return void request({
      action: 'select',
      targets: selectedElements().map((item) => item.target),
    }).then(refreshAfter);
  }
  if (target.dataset.structure && pageState) {
    if (!element) return;
    if (target.dataset.structure === 'delete') {
      deletePendingId = element.id;
      renderInspector();
      return;
    }
    const command: WorkspaceCommand =
      target.dataset.structure === 'duplicate'
        ? { action: 'duplicate', target: element.target }
        : {
            action: 'move',
            target: element.target,
            delta: target.dataset.structure === 'up' ? -1 : 1,
          };
    return void request(command).then(refreshAfter);
  }
  if (target.dataset.cancelHistory)
    return void request({ action: 'cancel-history', id: target.dataset.cancelHistory }).then(
      refreshAfter,
    );
});

app.addEventListener('dragstart', (event) => {
  const row =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-object-id]') : null;
  if (!row?.dataset.objectId) return;
  const sourceId = row.dataset.objectId;
  const selectedSourceIds = selectedIds.includes(sourceId) ? selectedIds : [sourceId];
  const selectedSet = new Set(selectedSourceIds);
  const sourceItems = selectedSourceIds.map(treeItemForId);
  if (sourceItems.some((item) => !item || item.target.textNodeIndex !== undefined)) {
    event.preventDefault();
    setError('文字对象不支持结构拖放，未改变父容器');
    clearTreeDragState();
    return;
  }
  if (selectedSourceIds.some((id) => hasSelectedAncestor(id, selectedSet))) {
    event.preventDefault();
    setError('不能同时拖动容器和它的子对象，请只选择同一层级的对象');
    clearTreeDragState();
    return;
  }
  draggedTreeIds = selectedSourceIds;
  event.dataTransfer?.setData('text/plain', JSON.stringify(draggedTreeIds));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  draggedTreeIds.forEach((id) =>
    app
      .querySelector<HTMLElement>(`[data-object-id="${CSS.escape(id)}"]`)
      ?.classList.add('is-dragging'),
  );
});

app.addEventListener('dragover', (event) => {
  const row =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-object-id]') : null;
  const destinationId = row?.dataset.objectId;
  if (!draggedTreeIds.length || !destinationId || draggedTreeIds.includes(destinationId)) return;
  const destination = treeItemForId(destinationId);
  if (!destination || destination.target.textNodeIndex !== undefined) return;
  const selectedSet = new Set(draggedTreeIds);
  if (hasSelectedAncestor(destinationId, selectedSet)) return;
  if (
    draggedTreeIds.some((id) => {
      let current = treeItemForId(destinationId);
      const visited = new Set<string>();
      while (current?.parentId && !visited.has(current.parentId)) {
        visited.add(current.parentId);
        if (current.parentId === id) return true;
        current = treeItemForId(current.parentId);
      }
      return false;
    })
  )
    return;
  event.preventDefault();
  app
    .querySelectorAll<HTMLElement>(
      '.tree-row.is-drop-before,.tree-row.is-drop-after,.tree-row.is-drop-inside',
    )
    .forEach((item) => item.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside'));
  row.classList.add(`is-drop-${dropPosition(event.clientY, row.getBoundingClientRect())}`);
});

app.addEventListener('drop', (event) => {
  const row =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-object-id]') : null;
  const destinationId = row?.dataset.objectId;
  let sourceIds = draggedTreeIds;
  if (!sourceIds.length) {
    try {
      const parsed = JSON.parse(event.dataTransfer?.getData('text/plain') ?? 'null');
      sourceIds = Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : [];
    } catch {
      sourceIds = [];
    }
  }
  if (!sourceIds.length || !destinationId) return;
  const sourceText = sourceIds.some((id) => treeItemForId(id)?.target.textNodeIndex !== undefined);
  const destinationText = treeItemForId(destinationId)?.target.textNodeIndex !== undefined;
  if (sourceText || destinationText) {
    event.preventDefault();
    setError('文字对象不支持结构拖放，未改变父容器');
    clearTreeDragState();
    return;
  }
  event.preventDefault();
  const position = row.classList.contains('is-drop-before')
    ? 'before'
    : row.classList.contains('is-drop-after')
      ? 'after'
      : 'inside';
  void placeObjects(sourceIds, destinationId, position);
  clearTreeDragState();
});

app.addEventListener('dragend', () => {
  clearTreeDragState();
});

let panStart: { x: number; y: number; panX: number; panY: number; pointerId: number } | null = null;
let resizeStart: {
  x: number;
  y: number;
  width: number;
  height: number;
  direction: 'right' | 'bottom' | 'corner';
  pointerId: number;
} | null = null;
type ObjectResizeDirection =
  'top-left' | 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left';

const resizesLeft = (direction: ObjectResizeDirection) => direction.includes('left');
const resizesRight = (direction: ObjectResizeDirection) => direction.includes('right');
const resizesTop = (direction: ObjectResizeDirection) => direction.includes('top');
const resizesBottom = (direction: ObjectResizeDirection) => direction.includes('bottom');

let objectResizeStart: {
  x: number;
  y: number;
  width: number;
  height: number;
  widthBefore: string;
  heightBefore: string;
  marginLeftBefore: string;
  marginTopBefore: string;
  displayBefore: string;
  marginLeft: number;
  marginTop: number;
  direction: ObjectResizeDirection;
  pointerId: number;
  element: WorkspaceElement;
  target: HTMLElement;
} | null = null;
let objectMoveStart: {
  x: number;
  y: number;
  positionBefore: string;
  leftBefore: string;
  topBefore: string;
  translateBefore: string;
  position: ObjectMovePosition;
  moved: boolean;
  pointerId: number;
  element: WorkspaceElement;
  target: HTMLElement;
  textFragmentMove: boolean;
  overlay: HTMLElement | null;
  deltaX: number;
  deltaY: number;
} | null = null;
let guideDragStart: {
  id: string;
  orientation: WorkspaceGuide['orientation'];
  position: number;
  x: number;
  y: number;
  pointerId: number;
  moved: boolean;
} | null = null;
let suppressGuideClick = false;
let spaceHeld = false;

const stage = app.querySelector<HTMLElement>('[data-canvas-stage]')!;
const rulerHost = app.querySelector<HTMLElement>('[data-rulers]');

const isCanvasEditingTarget = (target: EventTarget | null) => {
  if (!target || typeof target !== 'object') return false;
  const element = target as Element & { isContentEditable?: boolean };
  return (
    (typeof element.matches === 'function' &&
      element.matches(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      )) ||
    element.isContentEditable === true
  );
};

const setSpaceHeld = (held: boolean) => {
  spaceHeld = held;
  if (held) {
    stage.dataset.canvasSpace = 'true';
    stage.classList.add('is-pan-ready');
  } else {
    stage.removeAttribute('data-canvas-space');
    stage.classList.remove('is-pan-ready');
  }
  syncCanvasMode();
};

const handleSpaceKeyDown = (event: KeyboardEvent) => {
  if (event.code !== 'Space' || isCanvasEditingTarget(event.target)) return;
  event.preventDefault();
  if (!event.repeat) setSpaceHeld(true);
};

const handleSpaceKeyUp = (event: KeyboardEvent) => {
  if (event.code !== 'Space') return;
  setSpaceHeld(false);
};

const beginPan = (event: { clientX: number; clientY: number; pointerId: number }) => {
  if (panStart || resizeStart) return;
  panStart = {
    x: event.clientX,
    y: event.clientY,
    panX: canvasSettings.panX,
    panY: canvasSettings.panY,
    pointerId: event.pointerId,
  };
  try {
    stage.setPointerCapture(event.pointerId);
  } catch {
    // Pointer events originating inside the iframe may not be capturable in
    // older Chromium versions. The iframe listener still feeds movement.
  }
  stage.classList.add('is-panning');
};

const beginGuideDrag = (event: PointerEvent, id: string) => {
  if (!guidesEnabled || guideDragStart || panStart || resizeStart) return;
  const guide = workspaceGuides.find((item) => item.id === id);
  if (!guide) return;
  event.preventDefault();
  event.stopPropagation();
  activeInspector = 'object';
  activeTask = 'layout';
  guideDragStart = {
    id,
    orientation: guide.orientation,
    position: guide.position,
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
    moved: false,
  };
  try {
    stage.setPointerCapture(event.pointerId);
  } catch {
    // The pointer may have originated on a transformed overlay.
  }
  stage.classList.add('is-moving-guide');
  renderGuides();
  renderInspector();
};

const beginRulerDrag = (event: PointerEvent, orientation: WorkspaceGuide['orientation']) => {
  if (!guidesEnabled || rulerDragStart || guideDragStart || panStart || resizeStart) return;
  event.preventDefault();
  event.stopPropagation();
  rulerDragStart = { orientation, pointerId: event.pointerId };
  rulerPreview = {
    orientation,
    position: guidePositionFromPointer(orientation, event.clientX, event.clientY),
  };
  try {
    stage.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture can fail for a transformed canvas overlay; stage events
    // still receive the drag while the pointer remains over the workbench.
  }
  stage.classList.add('is-dragging-ruler');
  renderGuides();
};

const beginResize = (event: PointerEvent, direction: 'right' | 'bottom' | 'corner') => {
  event.preventDefault();
  event.stopPropagation();
  resizeStart = {
    x: event.clientX,
    y: event.clientY,
    width: canvasSettings.width,
    height: canvasSettings.height,
    direction,
    pointerId: event.pointerId,
  };
  stage.setPointerCapture(event.pointerId);
  stage.classList.add('is-resizing');
};

const beginObjectResize = (event: PointerEvent, direction: ObjectResizeDirection, id: string) => {
  const element = pageState?.elements.find((item) => item.id === id);
  const target = app
    .querySelector<HTMLIFrameElement>('[data-page-frame]')
    ?.contentDocument?.querySelector<HTMLElement>(`[data-dianjing-target="${CSS.escape(id)}"]`);
  if (
    !element ||
    !target ||
    element.capability === 'unstable' ||
    panStart ||
    resizeStart ||
    objectResizeStart
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  const rect = target.getBoundingClientRect();
  const computed = getComputedStyle(target);
  const displayBefore = target.style.getPropertyValue('display');
  if (computed.display === 'inline') target.style.display = 'inline-block';
  objectResizeStart = {
    x: event.clientX,
    y: event.clientY,
    width: rect.width,
    height: rect.height,
    widthBefore: target.style.getPropertyValue('width'),
    heightBefore: target.style.getPropertyValue('height'),
    marginLeftBefore: target.style.getPropertyValue('margin-left'),
    marginTopBefore: target.style.getPropertyValue('margin-top'),
    displayBefore,
    marginLeft: Number.parseFloat(computed.marginLeft) || 0,
    marginTop: Number.parseFloat(computed.marginTop) || 0,
    direction,
    pointerId: event.pointerId,
    element,
    target,
  };
  stage.setPointerCapture(event.pointerId);
  stage.dataset.objectResizeDirection = direction;
  stage.classList.add('is-resizing', 'is-resizing-object');
};

const beginObjectMove = (event: PointerEvent, id: string) => {
  const element = pageState?.elements.find((item) => item.id === id);
  const targetId = element
    ? workspaceTargetKey({ ...element.target, textNodeIndex: undefined })
    : id;
  const target = app
    .querySelector<HTMLIFrameElement>('[data-page-frame]')
    ?.contentDocument?.querySelector<HTMLElement>(
      `[data-dianjing-target="${CSS.escape(targetId)}"]`,
    );
  const textFragmentMove = element?.target.textNodeIndex !== undefined;
  const overlay = textFragmentMove
    ? app.querySelector<HTMLElement>(`[data-selection-overlay="${CSS.escape(id)}"]`)
    : null;
  if (
    !element ||
    !target ||
    (textFragmentMove && !overlay) ||
    element.capability === 'unstable' ||
    panStart ||
    resizeStart ||
    objectResizeStart ||
    objectMoveStart
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  const computed = getComputedStyle(target);
  const rect = target.getBoundingClientRect();
  objectMoveStart = {
    x: event.clientX,
    y: event.clientY,
    positionBefore: target.style.getPropertyValue('position'),
    leftBefore: target.style.getPropertyValue('left'),
    topBefore: target.style.getPropertyValue('top'),
    translateBefore: target.style.getPropertyValue('translate'),
    position: objectMovePosition({
      position: computed.position,
      left: computed.left,
      top: computed.top,
      right: computed.right,
      bottom: computed.bottom,
      offsetLeft: target.offsetLeft,
      offsetTop: target.offsetTop,
      rectLeft: rect.left,
      rectTop: rect.top,
    }),
    moved: false,
    pointerId: event.pointerId,
    element,
    target,
    textFragmentMove,
    overlay,
    deltaX: 0,
    deltaY: 0,
  };
  stage.setPointerCapture(event.pointerId);
  stage.classList.add('is-moving-object');
};

const moveCanvasPointer = (clientX: number, clientY: number) => {
  if (rulerDragStart) {
    rulerPreview = {
      orientation: rulerDragStart.orientation,
      position: guidePositionFromPointer(rulerDragStart.orientation, clientX, clientY),
    };
    renderGuides();
    return;
  }
  if (guideDragStart) {
    const guide = workspaceGuides.find((item) => item.id === guideDragStart?.id);
    if (!guide) return;
    const scale = Math.max(canvasSettings.zoom, 0.01);
    const delta =
      (guide.orientation === 'vertical' ? clientX - guideDragStart.x : clientY - guideDragStart.y) /
      scale;
    if (Math.abs(delta) > 0.5) {
      guideDragStart.moved = true;
      // A pointer down alone is a click target; promote the line to the active
      // anchor only once the user actually drags it. The bubbling click handler
      // can then select it once, or toggle it off when it was already active.
      currentGuideId = guide.id;
    }
    guide.position = clamp(
      Math.round(guideDragStart.position + delta),
      0,
      guidePositionLimit(guide.orientation),
    );
    renderGuides();
    return;
  }
  if (objectMoveStart) {
    const scale = Math.max(canvasSettings.zoom, 0.01);
    const deltaX = (clientX - objectMoveStart.x) / scale;
    const deltaY = (clientY - objectMoveStart.y) / scale;
    objectMoveStart.moved ||= Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5;
    objectMoveStart.deltaX = deltaX;
    objectMoveStart.deltaY = deltaY;
    if (objectMoveStart.textFragmentMove) {
      objectMoveStart.overlay?.style.setProperty(
        'transform',
        `translate(${Math.round(deltaX)}px, ${Math.round(deltaY)}px)`,
      );
      return;
    }
    if (!objectMoveStart.moved) return;
    objectMoveStart.target.style.setProperty(
      'translate',
      `${Math.round(deltaX)}px ${Math.round(deltaY)}px`,
    );
    updateSelectionOverlays();
    return;
  }
  if (objectResizeStart) {
    const scale = Math.max(canvasSettings.zoom, 0.01);
    const deltaX = (clientX - objectResizeStart.x) / scale;
    const deltaY = (clientY - objectResizeStart.y) / scale;
    if (resizesLeft(objectResizeStart.direction)) {
      objectResizeStart.target.style.marginLeft = `${Math.round(objectResizeStart.marginLeft + deltaX)}px`;
      objectResizeStart.target.style.width = `${clamp(
        Math.round(objectResizeStart.width - deltaX),
        24,
        CANVAS_MAX_SIZE,
      )}px`;
    } else if (resizesRight(objectResizeStart.direction))
      objectResizeStart.target.style.width = `${clamp(
        Math.round(objectResizeStart.width + deltaX),
        24,
        CANVAS_MAX_SIZE,
      )}px`;
    if (resizesTop(objectResizeStart.direction)) {
      objectResizeStart.target.style.marginTop = `${Math.round(objectResizeStart.marginTop + deltaY)}px`;
      objectResizeStart.target.style.height = `${clamp(
        Math.round(objectResizeStart.height - deltaY),
        24,
        CANVAS_MAX_SIZE,
      )}px`;
    } else if (resizesBottom(objectResizeStart.direction))
      objectResizeStart.target.style.height = `${clamp(
        Math.round(objectResizeStart.height + deltaY),
        24,
        CANVAS_MAX_SIZE,
      )}px`;
    updateSelectionOverlays();
    return;
  }
  if (resizeStart) {
    const scale = Math.max(canvasSettings.zoom, 0.01);
    if (resizeStart.direction === 'right' || resizeStart.direction === 'corner')
      canvasSettings.width = clamp(
        Math.round(resizeStart.width + (clientX - resizeStart.x) / scale),
        CANVAS_MIN_WIDTH,
        CANVAS_MAX_SIZE,
      );
    if (resizeStart.direction === 'bottom' || resizeStart.direction === 'corner')
      canvasSettings.height = clamp(
        Math.round(resizeStart.height + (clientY - resizeStart.y) / scale),
        CANVAS_MIN_HEIGHT,
        CANVAS_MAX_SIZE,
      );
    persistCanvasSettings();
    applyCanvasView();
    return;
  }
  if (!panStart) return;
  canvasSettings.panX = clamp(
    panStart.panX + clientX - panStart.x,
    -CANVAS_MAX_SIZE,
    CANVAS_MAX_SIZE,
  );
  canvasSettings.panY = clamp(
    panStart.panY + clientY - panStart.y,
    -CANVAS_MAX_SIZE,
    CANVAS_MAX_SIZE,
  );
  persistCanvasSettings();
  applyCanvasView();
};

const endCanvasPointer = (pointerId?: number, clientX?: number, clientY?: number) => {
  if (pointerId !== undefined) {
    try {
      stage.releasePointerCapture(pointerId);
    } catch {
      // The pointer may have originated in the iframe and never been
      // captured by the outer stage.
    }
  }
  if (rulerDragStart) {
    const drag = rulerDragStart;
    const frame = app.querySelector<HTMLIFrameElement>('[data-page-frame]');
    const frameRect = frame?.getBoundingClientRect();
    const validDrop =
      frameRect &&
      clientX !== undefined &&
      clientY !== undefined &&
      clientX >= frameRect.left &&
      clientX <= frameRect.right &&
      clientY >= frameRect.top &&
      clientY <= frameRect.bottom;
    if (validDrop && rulerPreview) addWorkspaceGuide(drag.orientation, rulerPreview.position);
    rulerDragStart = null;
    rulerPreview = null;
    stage.classList.remove('is-dragging-ruler');
    renderGuides();
  }
  if (guideDragStart) {
    suppressGuideClick = guideDragStart.moved;
    guideDragStart = null;
    stage.classList.remove('is-moving-guide');
    renderGuides();
    renderInspector();
    if (suppressGuideClick) window.setTimeout(() => (suppressGuideClick = false), 0);
  }
  if (objectMoveStart) {
    const move = objectMoveStart;
    if (move.textFragmentMove) {
      move.overlay?.style.removeProperty('transform');
      if (move.moved)
        void request({
          action: 'move-text',
          target: move.element.target,
          deltaX: move.deltaX,
          deltaY: move.deltaY,
        }).then(refreshAfter);
      updateSelectionOverlays();
    } else {
      if (move.translateBefore) move.target.style.setProperty('translate', move.translateBefore);
      else move.target.style.removeProperty('translate');
      if (move.moved) {
        if (move.position.position) move.target.style.position = move.position.position;
        if (move.position.clearRight) move.target.style.right = 'auto';
        if (move.position.clearBottom) move.target.style.bottom = 'auto';
        move.target.style.left = `${Math.round(move.position.left + move.deltaX)}px`;
        move.target.style.top = `${Math.round(move.position.top + move.deltaY)}px`;
      }
      const positionAfter = move.target.style.getPropertyValue('position');
      const leftAfter = move.target.style.getPropertyValue('left');
      const topAfter = move.target.style.getPropertyValue('top');
      if (move.moved) {
        if (positionAfter && positionAfter !== move.positionBefore)
          void commitChange({
            target: move.element.target,
            kind: 'style',
            property: 'position',
            after: positionAfter,
            label: '启用对象自由移动',
          });
        if (move.position.clearRight)
          void commitChange({
            target: move.element.target,
            kind: 'style',
            property: 'right',
            after: 'auto',
            label: '解除右侧定位锚点',
          });
        if (move.position.clearBottom)
          void commitChange({
            target: move.element.target,
            kind: 'style',
            property: 'bottom',
            after: 'auto',
            label: '解除底部定位锚点',
          });
        if (leftAfter && leftAfter !== move.leftBefore)
          void commitChange({
            target: move.element.target,
            kind: 'style',
            property: 'left',
            after: leftAfter,
            label: '移动对象',
          });
        if (topAfter && topAfter !== move.topBefore)
          void commitChange({
            target: move.element.target,
            kind: 'style',
            property: 'top',
            after: topAfter,
            label: '移动对象',
          });
      }
      updateSelectionOverlays();
    }
  }
  if (objectResizeStart) {
    const resize = objectResizeStart;
    const widthAfter = resize.target.style.getPropertyValue('width');
    const heightAfter = resize.target.style.getPropertyValue('height');
    const marginLeftAfter = resize.target.style.getPropertyValue('margin-left');
    const marginTopAfter = resize.target.style.getPropertyValue('margin-top');
    const displayAfter = resize.target.style.getPropertyValue('display');
    if (resizesLeft(resize.direction)) {
      if (marginLeftAfter && marginLeftAfter !== resize.marginLeftBefore)
        void commitChange({
          target: resize.element.target,
          kind: 'style',
          property: 'margin-left',
          after: marginLeftAfter,
          label: '调整容器左边界',
        });
    }
    if (resizesTop(resize.direction)) {
      if (marginTopAfter && marginTopAfter !== resize.marginTopBefore)
        void commitChange({
          target: resize.element.target,
          kind: 'style',
          property: 'margin-top',
          after: marginTopAfter,
          label: '调整容器上边界',
        });
    }
    if (displayAfter && displayAfter !== resize.displayBefore)
      void commitChange({
        target: resize.element.target,
        kind: 'style',
        property: 'display',
        after: displayAfter,
        label: '启用对象尺寸调整',
      });
    if (resizesLeft(resize.direction) || resizesRight(resize.direction)) {
      if (widthAfter && widthAfter !== resize.widthBefore)
        void commitChange({
          target: resize.element.target,
          kind: 'style',
          property: 'width',
          after: widthAfter,
          label: '调整容器宽度',
        });
    }
    if (resizesTop(resize.direction) || resizesBottom(resize.direction)) {
      if (heightAfter && heightAfter !== resize.heightBefore)
        void commitChange({
          target: resize.element.target,
          kind: 'style',
          property: 'height',
          after: heightAfter,
          label: '调整容器高度',
        });
    }
    updateSelectionOverlays();
  }
  panStart = null;
  resizeStart = null;
  objectResizeStart = null;
  objectMoveStart = null;
  delete stage.dataset.objectResizeDirection;
  stage.classList.remove('is-panning', 'is-resizing', 'is-resizing-object', 'is-moving-object');
};

rulerHost?.addEventListener('pointerdown', (event) => {
  const ruler =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-ruler]') : null;
  if (ruler?.dataset.ruler === 'top' || ruler?.dataset.ruler === 'left')
    beginRulerDrag(event, ruler.dataset.ruler === 'top' ? 'vertical' : 'horizontal');
});

stage.addEventListener('pointerdown', (event) => {
  const ruler =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-ruler]') : null;
  if (ruler?.dataset.ruler === 'top' || ruler?.dataset.ruler === 'left') {
    beginRulerDrag(event, ruler.dataset.ruler === 'top' ? 'vertical' : 'horizontal');
    return;
  }
  const guide =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-guide-id]') : null;
  if (guide?.dataset.guideId) {
    beginGuideDrag(event, guide.dataset.guideId);
    return;
  }
  const objectResize =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-selection-resize]')
      : null;
  if (objectResize?.dataset.selectionResize && objectResize.dataset.selectionResizeTarget) {
    beginObjectResize(
      event,
      objectResize.dataset.selectionResize as ObjectResizeDirection,
      objectResize.dataset.selectionResizeTarget,
    );
    return;
  }
  const objectMove =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-selection-move]')
      : null;
  if (objectMove?.dataset.selectionMove) {
    beginObjectMove(event, objectMove.dataset.selectionMove);
    return;
  }
  const target =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-canvas-resize]')
      : null;
  if (target?.dataset.canvasResize) {
    beginResize(event, target.dataset.canvasResize as 'right' | 'bottom' | 'corner');
    return;
  }
  if (event.button === 1 || canvasMode === 'pan' || spaceHeld) {
    event.preventDefault();
    beginPan(event);
  }
});
stage.addEventListener('pointermove', (event) => {
  if (
    panStart ||
    resizeStart ||
    objectResizeStart ||
    objectMoveStart ||
    guideDragStart ||
    rulerDragStart
  )
    event.preventDefault();
  moveCanvasPointer(event.clientX, event.clientY);
});
stage.addEventListener('pointerup', (event) => {
  if (
    panStart ||
    resizeStart ||
    objectResizeStart ||
    objectMoveStart ||
    guideDragStart ||
    rulerDragStart
  )
    event.preventDefault();
  endCanvasPointer(event.pointerId, event.clientX, event.clientY);
});
stage.addEventListener('pointercancel', (event) => endCanvasPointer(event.pointerId));
stage.addEventListener('click', (event) => {
  if (canvasMode === 'pan' || spaceHeld || event.defaultPrevented) return;
  const canvasContent = app.querySelector<HTMLElement>('[data-canvas-content]');
  if (event.button !== 0 || (event.target !== stage && event.target !== canvasContent)) return;
  clearWorkspaceSelection();
});
stage.addEventListener('scroll', () => {
  updateSelectionOverlays();
  // The ruler gutters stay fixed outside the scrollable stage, so scrolling
  // the canvas must explicitly recompute both page-relative ticks and guide
  // positions.
  renderGuides();
});
stage.addEventListener('wheel', zoomCanvasWithWheel, { passive: false });

window.addEventListener('resize', () => applyCanvasView());

window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.dataset.action === 'zoom-100' &&
    (event.key === 'Enter' || event.key === ' ')
  ) {
    event.preventDefault();
    setCanvasZoom(1);
    return;
  }
  const editing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
  if (event.key === 'Delete' && guidesEnabled && currentGuideId && !editing) {
    event.preventDefault();
    deleteWorkspaceGuide();
    return;
  }
  if (event.code === 'Space' && !editing) handleSpaceKeyDown(event);
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    void request({ action: event.shiftKey ? 'redo' : 'undo' }).then(refreshAfter);
  }
});

window.addEventListener('keyup', (event) => {
  handleSpaceKeyUp(event);
});

window.addEventListener('blur', () => {
  setSpaceHeld(false);
  endCanvasPointer();
});
