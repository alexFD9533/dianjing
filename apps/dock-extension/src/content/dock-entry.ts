import { targetFor } from '@workbench/selector-engine';
import { nextDockElement, type DockNavigationDirection } from './navigation';
import { clampDockToolbarPosition, defaultDockToolbarPosition } from './toolbar-position';
import {
  directTextFragmentAtPoint,
  directTextFragments,
  directTextFragmentIndex,
  isTextFragmentWrapper,
  materializeDirectTextFragment,
  readDirectTextFragment,
  resolveDirectTextFragment,
  shouldExposeDirectTextFragments,
  textFragmentBelongsTo,
  textFragmentClientRect,
  textFragmentForNode,
  textNodeWrapper,
  type TextFragment,
  type TextFragmentRect,
  writeDirectTextFragment,
} from './text-fragment';
import { createOfflineHtmlSnapshot } from './offline-html-export';
import type {
  WorkspaceCommand,
  WorkspaceElement,
  WorkspaceExportProgress,
  WorkspaceGuide,
  WorkspacePageState,
  WorkspaceSelectableTarget,
  WorkspaceTarget,
  WorkspaceValueSource,
} from '../shared/workspace-protocol';
import { workspaceTargetKey } from '../shared/workspace-protocol';
import { availableWorkspaceSelectionIds } from '../shared/workspace-selection';
import { buildAiPromptPacket, type PromptOperationInput } from '../shared/ai-prompt';
import { objectMovePosition } from '../shared/object-position';
import {
  resolveWorkspaceElementHandle,
  resolveWorkspaceLayoutHandle,
  resolveWorkspaceTargetHandle,
  materializeWorkspaceLayoutHandle,
  type WorkspaceLayoutHandle,
  type WorkspaceTargetHandle,
} from '../shared/workspace-target';

type TargetRef = NonNullable<ReturnType<typeof targetFor>>;
type WorkspaceTargetRef = TargetRef & Pick<WorkspaceTarget, 'textNodeIndex'>;
type StyleProperty =
  | 'color'
  | 'background-color'
  | 'border'
  | 'border-color'
  | 'border-style'
  | 'border-width'
  | 'border-radius'
  | 'background'
  | 'padding'
  | 'padding-top'
  | 'padding-right'
  | 'padding-bottom'
  | 'padding-left'
  | 'margin'
  | 'margin-top'
  | 'margin-right'
  | 'margin-bottom'
  | 'margin-left'
  | 'font-size'
  | 'font-weight'
  | 'font-family'
  | 'font-style'
  | 'text-decoration'
  | 'white-space'
  | 'display'
  | 'position'
  | 'left'
  | 'top'
  | 'right'
  | 'bottom'
  | 'visibility'
  | 'width'
  | 'height'
  | 'min-width'
  | 'line-height'
  | 'gap'
  | 'flex-direction'
  | 'justify-content'
  | 'text-align'
  | 'vertical-align';

type DockPatch = {
  id: string;
  target: TargetRef;
  kind: 'text' | 'style' | 'structure';
  property:
    'textContent' | 'value' | StyleProperty | 'position' | 'placement' | 'group' | 'presence';
  before: string;
  after: string;
  beforeSource?: WorkspaceValueSource;
  targetLabel: string;
  semanticPath?: string;
  label: string;
  createdAt: string;
  textWrapBefore?: string;
  textWrapAfter?: string;
  textNodeIndex?: number;
  element?: HTMLElement;
  parent?: HTMLElement;
  index?: number;
  beforeParent?: HTMLElement;
  afterParent?: HTMLElement;
  beforeAnchor?: Element | null;
  afterAnchor?: Element | null;
  members?: HTMLElement[];
  textNodes?: Text[];
  textWrapper?: HTMLElement;
  textChildIndex?: number;
  textChildPositions?: number[];
  textRestoreAnchors?: Array<ChildNode | null>;
  styleElement?: HTMLElement;
  placementItems?: DockPlacementItem[];
  placementStyles?: DockPlacementStyleItem[];
};

type DockPlacementItem = {
  element: HTMLElement;
  beforeParent: HTMLElement;
  beforeAnchor: Element | null;
  afterParent: HTMLElement;
  afterAnchor: Element | null;
};

type DockPlacementStyleElement = HTMLElement | SVGElement;

type DockPlacementStyleItem = {
  element: DockPlacementStyleElement;
  beforeStyle: string | null;
  beforeComputed: Record<string, string>;
  afterStyle?: string | null;
};

type DockState = {
  active: boolean;
  history: DockPatch[];
  future: DockPatch[];
  cancelled: DockPatch[];
  deletePending: boolean;
  historyOpen: boolean;
  fileMenuOpen: boolean;
  notice: string;
  webCopyMode: boolean;
  position: { x: number; y: number };
  toolbarPosition: { x: number; y: number } | null;
  activePanel: 'text' | 'appearance' | 'spacing';
};

type CapabilityStatus =
  'checking' | 'editable-exportable' | 'editable-only' | 'exportable-only' | 'preview-only';

type Capability = {
  status: CapabilityStatus;
  label: string;
  description: string;
};

type ObjectCapabilityStatus = 'direct' | 'whole-object' | 'style-only' | 'unstable';

type ObjectCapability = {
  status: ObjectCapabilityStatus;
  label: string;
  description: string;
  canEditText: boolean;
};

const HOST_ID = 'dock-extension-host';
const isWorkspaceCanvasSource = document.documentElement.dataset.dianjingWorkspaceSource === 'true';

const createPatchId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `dock-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const state: DockState = {
  active: false,
  history: [],
  future: [],
  cancelled: [],
  deletePending: false,
  historyOpen: false,
  fileMenuOpen: false,
  notice: '已加载；点击页面元素开始直接编辑',
  webCopyMode: false,
  position: { x: Math.max(16, window.innerWidth - 376), y: 20 },
  toolbarPosition: null,
  activePanel: 'text',
};

let host: HTMLDivElement;
let shadow: ShadowRoot;
let ui!: HTMLDivElement;
let panel: HTMLDivElement;
let selectionBox: HTMLDivElement;
let selected: HTMLElement | null = null;
let selectedTextFragment: TextFragment | null = null;
let workspaceSelectedTargets: WorkspaceTargetRef[] = [];
let workspaceExpandedTargets: WorkspaceTargetRef[] = [];
const visibilityRestoreValues = new WeakMap<HTMLElement, string>();
let captureHiddenBefore = false;
let captureHostStyleBefore = '';
let captureScrollBefore = { x: 0, y: 0 };
let captureScrollBehaviorBefore: { value: string; priority: string } | null = null;
const captureFixedElementStyles = new Map<HTMLElement, { value: string; priority: string }>();
let capability: Capability = {
  status: 'checking',
  label: '正在检测页面状态',
  description: '正在确认当前页面是否可编辑、是否可导出 HTML。',
};

const styleProperties: Array<{ property: StyleProperty; label: string; input: string }> = [
  { property: 'color', label: '文字颜色', input: 'color' },
  { property: 'background-color', label: '背景颜色', input: 'color' },
  { property: 'border', label: '边框', input: 'text' },
  { property: 'border-color', label: '边框颜色', input: 'color' },
  { property: 'border-style', label: '边框样式', input: 'text' },
  { property: 'border-width', label: '边框粗细', input: 'text' },
  { property: 'border-radius', label: '圆角', input: 'text' },
  { property: 'background', label: '元素背景', input: 'color' },
  { property: 'padding', label: '内边距', input: 'text' },
  { property: 'padding-top', label: '上内边距', input: 'text' },
  { property: 'padding-right', label: '右内边距', input: 'text' },
  { property: 'padding-bottom', label: '下内边距', input: 'text' },
  { property: 'padding-left', label: '左内边距', input: 'text' },
  { property: 'margin', label: '外边距', input: 'text' },
  { property: 'margin-top', label: '上外边距', input: 'text' },
  { property: 'margin-right', label: '右外边距', input: 'text' },
  { property: 'margin-bottom', label: '下外边距', input: 'text' },
  { property: 'margin-left', label: '左外边距', input: 'text' },
  { property: 'font-size', label: '字号', input: 'text' },
  { property: 'font-weight', label: '字重', input: 'text' },
  { property: 'font-family', label: '字体', input: 'text' },
  { property: 'font-style', label: '倾斜', input: 'text' },
  { property: 'text-decoration', label: '文字装饰', input: 'text' },
  { property: 'display', label: '显示方式', input: 'text' },
  { property: 'position', label: '定位方式', input: 'text' },
  { property: 'left', label: '水平位置', input: 'text' },
  { property: 'top', label: '垂直位置', input: 'text' },
  { property: 'visibility', label: '可见性', input: 'text' },
  { property: 'width', label: '宽度', input: 'text' },
  { property: 'height', label: '高度', input: 'text' },
  { property: 'min-width', label: '最小宽度', input: 'text' },
  { property: 'line-height', label: '行高', input: 'text' },
  { property: 'gap', label: '对象间距', input: 'text' },
  { property: 'flex-direction', label: '排列方向', input: 'text' },
  { property: 'justify-content', label: '分布方式', input: 'text' },
  { property: 'text-align', label: '水平位置', input: 'text' },
  { property: 'vertical-align', label: '垂直位置', input: 'text' },
];

const capabilityFor = (editable: boolean, exportable: boolean): Capability => {
  if (editable && exportable)
    return {
      status: 'editable-exportable',
      label: '可编辑 · 可导出 HTML',
      description: '可以直接修改当前页面，也可以导出当前页面的静态 HTML 副本。',
    };
  if (editable)
    return {
      status: 'editable-only',
      label: '可编辑 · 不可导出 HTML',
      description: '可以直接修改当前页面，但当前页面无法生成静态 HTML。',
    };
  if (exportable)
    return {
      status: 'exportable-only',
      label: '不可编辑 · 可导出 HTML',
      description: '可以生成当前页面的静态 HTML 副本，但没有可安全直接修改的页面对象。',
    };
  return {
    status: 'preview-only',
    label: '不可编辑 · 不可导出 HTML',
    description: '当前页面只能查看，暂不支持直接修改或导出 HTML。',
  };
};

const detectCapability = (): Capability => {
  let editable = false;
  try {
    editable = [...document.querySelectorAll<HTMLElement>('*')].some((element) => {
      if (element.dataset.dockIgnore === 'true' || element.closest(`[data-${HOST_ID}]`))
        return false;
      if (['BODY', 'HTML', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName))
        return false;
      return targetFor(element) !== null;
    });
  } catch {
    editable = false;
  }

  let exportable = false;
  try {
    const copy = document.documentElement.cloneNode(true) as HTMLElement;
    copy.querySelector(`[data-${HOST_ID}]`)?.remove();
    void copy.outerHTML;
    exportable = true;
  } catch {
    exportable = false;
  }
  return capabilityFor(editable, exportable);
};

type DockToolbarIcon =
  | 'brand'
  | 'select'
  | 'undo'
  | 'redo'
  | 'history'
  | 'file'
  | 'export'
  | 'prompt'
  | 'workspace'
  | 'reopen'
  | 'close'
  | 'chevron'
  | 'capability-checking'
  | 'capability-edit-export'
  | 'capability-edit-only'
  | 'capability-export-only'
  | 'capability-preview-only';

const dockIcon = (name: DockToolbarIcon): string => {
  if (name === 'brand') {
    const iconUrl =
      typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function'
        ? chrome.runtime.getURL('icons/icon-128.png')
        : 'icons/icon-128.png';
    return `<img class="dock-brand-image" src="${iconUrl}" alt="" aria-hidden="true" />`;
  }
  const paths: Record<DockToolbarIcon, string> = {
    brand:
      '<path d="M7 3.5h8.5a4 4 0 0 1 4 4v3"/><path d="M19.5 16.5a4 4 0 0 1-4 4H7a3.5 3.5 0 0 1-3.5-3.5V7A3.5 3.5 0 0 1 7 3.5"/><path d="m18.4 10.2 3.4 3.4-6.7 6.7-4.2.8.8-4.2Z"/>',
    select:
      '<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4.25"/><circle cx="12" cy="12" r="1" class="dock-icon-fill"/>',
    undo: '<path d="m8.5 7-4 4 4 4"/><path d="M5 11h8.2a6.3 6.3 0 0 1 6.3 6.3"/>',
    redo: '<path d="m15.5 7 4 4-4 4"/><path d="M19 11h-8.2a6.3 6.3 0 0 0-6.3 6.3"/>',
    history:
      '<path d="M5.2 7.5A8 8 0 1 1 4 13"/><path d="M3.5 5.5v4h4"/><path d="M12 7.5v4.8l3.2 1.8"/>',
    file: '<path d="M3.5 7.5h6l1.7-2h3.3a2 2 0 0 1 2 2v1"/><path d="M4 8.5h15.2a1.3 1.3 0 0 1 1.2 1.7l-2.3 8a2 2 0 0 1-1.9 1.4H5.8a2 2 0 0 1-2-1.8L2.5 10a1.3 1.3 0 0 1 1.5-1.5Z"/>',
    export: '<path d="M12 3.5v11"/><path d="m7.8 10.5 4.2 4.2 4.2-4.2"/><path d="M4.5 19.5h15"/>',
    prompt:
      '<path d="M5.2 5.5h8.6a3.7 3.7 0 0 1 3.7 3.7v3.6a3.7 3.7 0 0 1-3.7 3.7H9l-4.5 3v-3.7a3.6 3.6 0 0 1-2-3.2V9.2a3.7 3.7 0 0 1 2.7-3.6"/><path d="m18.5 2 .5 1.5L20.5 4 19 4.5 18.5 6 18 4.5 16.5 4 18 3.5Z"/>',
    workspace:
      '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M3.5 9h17M9 9v11"/><path d="m14.2 15.8 4.3-4.3M15 11.5h3.5V15"/>',
    reopen: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    'capability-checking': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v4.8l3 1.8"/>',
    'capability-edit-export':
      '<path d="m5 17.8-.8 3 3-.8L18 9.2 14.8 6z"/><path d="m13.5 7.3 3.2 3.2"/><path d="M16 18.5h4M18 16.5v4"/>',
    'capability-edit-only':
      '<path d="m5 17.8-.8 3 3-.8L18 9.2 14.8 6z"/><path d="m13.5 7.3 3.2 3.2"/>',
    'capability-export-only': '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19.5h14"/>',
    'capability-preview-only':
      '<path d="M3.5 12s3.2-5 8.5-5 8.5 5 8.5 5-3.2 5-8.5 5-8.5-5-8.5-5Z"/><circle cx="12" cy="12" r="2"/>',
  };
  return `<svg class="dock-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
};

const capabilityIcon = (status: CapabilityStatus): DockToolbarIcon =>
  status === 'checking'
    ? 'capability-checking'
    : status === 'editable-exportable'
      ? 'capability-edit-export'
      : status === 'editable-only'
        ? 'capability-edit-only'
        : status === 'exportable-only'
          ? 'capability-export-only'
          : 'capability-preview-only';

const capabilityButton = () =>
  `<button class="dock-toolbar-button dock-toolbar-icon-button dock-capability-button dock-capability-button--${capability.status}" data-action="capability" aria-label="页面状态：${escapeHtml(capability.label)}" data-tooltip="${escapeHtml(capability.label)}：${escapeHtml(capability.description)}" title="${escapeHtml(capability.label)}"><span class="toolbar-icon">${dockIcon(capabilityIcon(capability.status))}</span></button>`;

type ObjectActionIcon = 'copy' | 'up' | 'down' | 'delete';

const objectActionIcon = (name: ObjectActionIcon) => {
  const paths: Record<ObjectActionIcon, string> = {
    copy: '<rect x="8" y="8" width="10" height="10" rx="1.5"/><path d="M6 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V6"/>',
    up: '<path d="m6 10 6-6 6 6M12 4v16"',
    down: '<path d="m6 14 6 6 6-6M12 20V4"',
    delete: '<path d="M4.5 7h15M9 4h6l1 3H8zM7 7l.7 13h8.6L17 7M10 10.5v6M14 10.5v6"',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );

const dockFontOptions = [
  { value: 'inherit', label: '页面默认' },
  { value: 'system-ui, sans-serif', label: '系统默认' },
  { value: '"Microsoft YaHei", sans-serif', label: '微软雅黑' },
  { value: '"PingFang SC", sans-serif', label: '苹方' },
  { value: 'SimHei, sans-serif', label: '黑体' },
  { value: 'SimSun, serif', label: '宋体' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: '"Helvetica Neue", Arial, sans-serif', label: 'Helvetica Neue' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: '"Times New Roman", Times, serif', label: 'Times New Roman' },
  { value: 'Consolas, monospace', label: 'Consolas' },
  { value: '"Courier New", monospace', label: 'Courier New' },
] as const;

const fontFamilyName = (fontFamily: string) =>
  (fontFamily.split(',')[0] ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();

const renderFontOptions = (currentFontFamily: string) => {
  const currentName = fontFamilyName(currentFontFamily);
  const knownFont = dockFontOptions.some(
    (option) => option.value !== 'inherit' && fontFamilyName(option.value) === currentName,
  );
  return dockFontOptions
    .map((option) => {
      const selected =
        option.value === 'inherit' ? !knownFont : fontFamilyName(option.value) === currentName;
      return `<option value="${escapeHtml(option.value)}"${selected ? ' selected' : ''}>${option.label}</option>`;
    })
    .join('');
};

const isTextInput = (element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;

const directText = (element: HTMLElement) =>
  directTextFragments(element)
    .map((fragment) => fragment.text)
    .join('');

const textPropertyFor = (element: HTMLElement): 'textContent' | 'value' =>
  isTextInput(element) ? 'value' : 'textContent';

const readText = (element: HTMLElement, textFragment: TextFragment | null = null) => {
  if (isTextInput(element)) return element.value;
  if (textFragment && textFragmentBelongsTo(element, textFragment)) return textFragment.text;
  return directText(element) || element.textContent || '';
};

const readTextForPatch = (element: HTMLElement, textNodeIndex: number | undefined) =>
  textNodeIndex === undefined
    ? readText(element)
    : (readDirectTextFragment(element, textNodeIndex) ?? '');

const readStyle = (element: HTMLElement, property: StyleProperty) => {
  const inlineValue = element.style.getPropertyValue(property).trim();
  if (inlineValue) return inlineValue;
  return (
    element.ownerDocument.defaultView
      ?.getComputedStyle(element)
      .getPropertyValue(property)
      .trim() ?? ''
  );
};

const rememberVisibilityBeforeHiding = (element: HTMLElement, visibility: string) => {
  if (visibility !== 'hidden') visibilityRestoreValues.set(element, visibility || 'visible');
};

const visibilityAfterValue = (element: HTMLElement, visible: boolean) => {
  const currentVisibility = readStyle(element, 'visibility');
  if (visible) {
    rememberVisibilityBeforeHiding(element, currentVisibility);
    return 'hidden';
  }
  return visibilityRestoreValues.get(element) ?? 'visible';
};

const toHexColor = (value: string) => {
  const match = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (!match) return /^#[\da-f]{6}$/i.test(value) ? value : '#ffffff';
  return `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
};

const comparableColor = (value: string) => {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const hexValue = hex[1] ?? '';
    const digits =
      hexValue.length === 3
        ? hexValue
            .split('')
            .map((digit) => `${digit}${digit}`)
            .join('')
        : hexValue;
    return `rgb(${Number.parseInt(digits.slice(0, 2), 16)},${Number.parseInt(digits.slice(2, 4), 16)},${Number.parseInt(digits.slice(4, 6), 16)})`;
  }
  const rgb = normalized.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (!rgb) return normalized;
  const alpha = rgb[4] === undefined ? undefined : Number(rgb[4]);
  return alpha === undefined || alpha === 1
    ? `rgb(${Number(rgb[1])},${Number(rgb[2])},${Number(rgb[3])})`
    : `rgba(${Number(rgb[1])},${Number(rgb[2])},${Number(rgb[3])},${alpha})`;
};

const valuesEqual = (patch: Pick<DockPatch, 'kind' | 'property'>, left: string, right: string) => {
  if (
    patch.kind === 'style' &&
    (patch.property === 'color' ||
      patch.property === 'background-color' ||
      patch.property === 'background' ||
      patch.property === 'border-color')
  ) {
    return comparableColor(left) === comparableColor(right);
  }
  return left.trim() === right.trim();
};

type TextPresencePatch = Pick<DockPatch, 'textNodes' | 'textWrapper'>;

const textContributorsPresent = (patch: TextPresencePatch) => {
  const textNodes = patch.textNodes ?? [];
  return Boolean(
    textNodes.length &&
    textNodes.every((node) => node.isConnected) &&
    (!patch.textWrapper || patch.textWrapper.isConnected),
  );
};

const placementStylePropertyNames = new Set([
  'display',
  'visibility',
  'opacity',
  'color',
  'background',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'background-clip',
  'background-origin',
  'border',
  'border-width',
  'border-style',
  'border-color',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'box-shadow',
  'outline',
  'outline-width',
  'outline-style',
  'outline-color',
  'outline-offset',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'text-transform',
  'text-shadow',
  'white-space',
  'word-break',
  'overflow',
  'overflow-x',
  'overflow-y',
  'text-overflow',
  'box-sizing',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'position',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'transform',
  'transform-origin',
  'flex',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-content',
  'align-items',
  'align-self',
  'justify-content',
  'justify-items',
  'justify-self',
  'order',
  'gap',
  'row-gap',
  'column-gap',
  'grid',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column',
  'grid-row',
  'place-content',
  'place-items',
  'place-self',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'vector-effect',
  'filter',
  'mix-blend-mode',
  'object-fit',
  'object-position',
]);

const computedStyleValues = (element: DockPlacementStyleElement) => {
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!computed) return {};
  return Object.fromEntries(
    Array.from({ length: computed.length }, (_, index) => computed.item(index))
      .filter((property): property is string => Boolean(property))
      .filter((property) => property.startsWith('--') || placementStylePropertyNames.has(property))
      .map((property) => [property, computed.getPropertyValue(property)])
      .filter(([, value]) => Boolean(value)),
  );
};

const placementStyleElements = (elements: HTMLElement[]) => {
  const seen = new Set<DockPlacementStyleElement>();
  const result: DockPlacementStyleElement[] = [];
  elements.forEach((element) => {
    const descendants = [element, ...element.querySelectorAll<HTMLElement | SVGElement>('*')];
    descendants.forEach((descendant) => {
      if (!('style' in descendant) || seen.has(descendant)) return;
      seen.add(descendant);
      result.push(descendant);
    });
  });
  return result;
};

const capturePlacementStyles = (elements: HTMLElement[]): DockPlacementStyleItem[] =>
  placementStyleElements(elements).map((element) => ({
    element,
    beforeStyle: element.getAttribute('style'),
    beforeComputed: computedStyleValues(element),
  }));

const preservePlacementStylesAfterMove = (styles: DockPlacementStyleItem[]) => {
  styles.forEach((item) => {
    const afterComputed = computedStyleValues(item.element);
    Object.entries(item.beforeComputed).forEach(([property, beforeValue]) => {
      if (afterComputed[property] !== beforeValue)
        item.element.style.setProperty(property, beforeValue, 'important');
    });
    item.afterStyle = item.element.getAttribute('style');
  });
};

const restorePlacementStyles = (
  styles: DockPlacementStyleItem[] | undefined,
  value: 'before' | 'after',
) => {
  styles?.forEach((item) => {
    const style = value === 'before' ? item.beforeStyle : item.afterStyle;
    if (style === null || style === undefined) item.element.removeAttribute('style');
    else item.element.setAttribute('style', style);
  });
};

const writeValue = (
  element: HTMLElement,
  patch: Pick<
    DockPatch,
    | 'kind'
    | 'property'
    | 'parent'
    | 'index'
    | 'textNodeIndex'
    | 'textWrapAfter'
    | 'beforeParent'
    | 'afterParent'
    | 'beforeAnchor'
    | 'afterAnchor'
    | 'members'
    | 'textNodes'
    | 'textWrapper'
    | 'textChildIndex'
    | 'textChildPositions'
    | 'textRestoreAnchors'
    | 'placementItems'
    | 'placementStyles'
  >,
  value: string,
) => {
  if (patch.kind === 'text') {
    if (patch.property === 'value' && isTextInput(element)) element.value = value;
    else if (patch.textNodeIndex !== undefined)
      writeDirectTextFragment(element, patch.textNodeIndex, value);
    else element.textContent = value;
    if (patch.textWrapAfter !== undefined && !isTextInput(element)) {
      const textStyleElement =
        patch.textWrapper?.parentElement === element ? patch.textWrapper : element;
      if (patch.textWrapAfter)
        textStyleElement.style.setProperty('white-space', patch.textWrapAfter);
      else textStyleElement.style.removeProperty('white-space');
    }
    return;
  }
  if (patch.kind === 'structure') {
    if (patch.property === 'placement' && patch.placementItems?.length) {
      const members = new Set(patch.placementItems.map((item) => item.element));
      if (value === 'after') {
        const first = patch.placementItems[0]!;
        const parent = first.afterParent;
        const anchor = first.afterAnchor?.parentElement === parent ? first.afterAnchor : null;
        patch.placementItems.forEach((item) => parent.insertBefore(item.element, anchor));
      } else {
        const parents = new Map<HTMLElement, DockPlacementItem[]>();
        patch.placementItems.forEach((item) => {
          const items = parents.get(item.beforeParent) ?? [];
          items.push(item);
          parents.set(item.beforeParent, items);
        });
        parents.forEach((items, parent) => {
          items.forEach((item) => {
            let anchor = item.beforeAnchor;
            while (anchor && members.has(anchor as HTMLElement)) anchor = anchor.nextElementSibling;
            if (anchor?.parentElement !== parent) anchor = null;
            parent.insertBefore(item.element, anchor);
          });
        });
      }
      restorePlacementStyles(patch.placementStyles, value as 'before' | 'after');
      return;
    }
    if (patch.property === 'presence' && patch.textNodes?.length) {
      const textNodes = patch.textNodes;
      const parent = patch.parent ?? element;
      const connected = textContributorsPresent(patch);
      if (value === 'present' && !connected) {
        if (patch.textWrapper) {
          const wrapper = patch.textWrapper;
          if (wrapper.parentNode !== parent)
            parent.insertBefore(
              wrapper,
              parent.childNodes[patch.textChildIndex ?? parent.childNodes.length] ?? null,
            );
          for (const [index, node] of textNodes.entries()) {
            if (node.parentNode === wrapper) continue;
            const nextTextNode = textNodes
              .slice(index + 1)
              .find((candidate) => candidate.parentNode === wrapper);
            wrapper.insertBefore(node, nextTextNode ?? null);
          }
        } else {
          textNodes.forEach((node, index) => {
            if (node.isConnected) return;
            const anchor = patch.textRestoreAnchors?.[index];
            const validAnchor =
              anchor && anchor.parentNode === parent && !textNodes.includes(anchor as Text)
                ? anchor
                : (parent.childNodes[
                    patch.textChildPositions?.[index] ?? parent.childNodes.length
                  ] ?? null);
            parent.insertBefore(node, validAnchor);
          });
        }
      } else if (value === 'absent' && connected) {
        if (patch.textWrapper) {
          textNodes.forEach((node) => {
            if (!patch.textWrapper?.contains(node)) node.remove();
          });
          if (patch.textWrapper.isConnected) patch.textWrapper.remove();
        } else {
          textNodes.forEach((node) => node.remove());
        }
      }
      return;
    }
    if (patch.property === 'group') {
      const parent = patch.parent;
      const members = patch.members ?? [];
      if (!parent) return;
      if (value === 'after') {
        parent.insertBefore(
          element,
          parent.children[patch.index ?? parent.children.length] ?? null,
        );
        members.forEach((member) => element.append(member));
      } else {
        members.forEach((member) => parent.insertBefore(member, element));
        element.remove();
      }
      return;
    }
    if (patch.property === 'placement') {
      const placement =
        value === 'before'
          ? { parent: patch.beforeParent, anchor: patch.beforeAnchor }
          : { parent: patch.afterParent, anchor: patch.afterAnchor };
      if (!placement.parent) return;
      const anchor = placement.anchor?.parentElement === placement.parent ? placement.anchor : null;
      placement.parent.insertBefore(element, anchor);
      restorePlacementStyles(patch.placementStyles, value as 'before' | 'after');
      return;
    }
    if (patch.property === 'position') {
      const parent = patch.parent ?? element.parentElement;
      if (!parent) return;
      const currentIndex = [...parent.children].indexOf(element);
      const targetIndex = Math.max(0, Math.min(Number(value), parent.children.length - 1));
      if (currentIndex < 0 || currentIndex === targetIndex) return;
      const anchor =
        targetIndex > currentIndex
          ? (parent.children[targetIndex + 1] ?? null)
          : (parent.children[targetIndex] ?? null);
      parent.insertBefore(element, anchor);
      return;
    }
    if (patch.property === 'presence') {
      const parent = patch.parent;
      if (!parent) return;
      if (value === 'present' && !element.isConnected) {
        parent.insertBefore(
          element,
          parent.children[patch.index ?? parent.children.length] ?? null,
        );
      } else if (value === 'absent' && element.isConnected) {
        element.remove();
      }
    }
    return;
  }
  element.style.setProperty(patch.property, value);
  const computedValue = element.ownerDocument.defaultView
    ?.getComputedStyle(element)
    .getPropertyValue(patch.property)
    .trim();
  if (computedValue && !valuesEqual(patch, computedValue, value))
    element.style.setProperty(patch.property, value, 'important');
};

const currentValue = (
  element: HTMLElement,
  patch: Pick<
    DockPatch,
    | 'kind'
    | 'property'
    | 'textNodeIndex'
    | 'beforeParent'
    | 'afterParent'
    | 'beforeAnchor'
    | 'afterAnchor'
    | 'textNodes'
    | 'textWrapper'
    | 'placementItems'
  >,
) => {
  if (patch.kind === 'text') return readTextForPatch(element, patch.textNodeIndex);
  if (patch.kind === 'structure') {
    if (patch.property === 'presence' && patch.textNodes)
      return textContributorsPresent(patch) ? 'present' : 'absent';
    if (patch.property === 'group') return element.isConnected ? 'after' : 'before';
    if (patch.property === 'placement' && patch.placementItems?.length) {
      const members = new Set(patch.placementItems.map((item) => item.element));
      const nextNonMember = (candidate: HTMLElement) => {
        let next = candidate.nextElementSibling;
        while (next && members.has(next as HTMLElement)) next = next.nextElementSibling;
        return next;
      };
      const matches = (value: 'before' | 'after') =>
        patch.placementItems!.every((item) => {
          const parent = value === 'before' ? item.beforeParent : item.afterParent;
          const anchor = value === 'before' ? item.beforeAnchor : item.afterAnchor;
          return item.element.parentElement === parent && nextNonMember(item.element) === anchor;
        });
      if (matches('after')) return 'after';
      if (matches('before')) return 'before';
      return 'unknown';
    }
    if (patch.property === 'placement') {
      if (
        element.parentElement === patch.afterParent &&
        element.nextElementSibling === patch.afterAnchor
      )
        return 'after';
      if (
        element.parentElement === patch.beforeParent &&
        element.nextElementSibling === patch.beforeAnchor
      )
        return 'before';
      return 'unknown';
    }
    if (patch.property === 'position')
      return String(
        element.parentElement ? [...element.parentElement.children].indexOf(element) : -1,
      );
    return element.isConnected ? 'present' : 'absent';
  }
  return readStyle(element, patch.property as StyleProperty);
};

const resolvePatchElement = (patch: DockPatch): HTMLElement | null => {
  if (patch.kind === 'structure' && patch.element) return patch.element;
  if (patch.kind === 'style' && patch.textNodeIndex !== undefined) {
    const resolved = resolveWorkspaceLayoutHandle({
      ...patch.target,
      textNodeIndex: patch.textNodeIndex,
    });
    return resolved.ok ? resolved.handle.layoutElement : null;
  }
  const resolved = resolveWorkspaceElementHandle(patch.target);
  return resolved.ok && resolved.handle.kind === 'element' ? resolved.handle.element : null;
};

const applyPatch = (patch: DockPatch, value: 'before' | 'after'): boolean => {
  const element = resolvePatchElement(patch);
  if (!element) return false;
  if (
    patch.kind === 'text' &&
    patch.textNodeIndex !== undefined &&
    !resolveDirectTextFragment(element, patch.textNodeIndex)
  )
    return false;
  const current = currentValue(element, patch);
  const expected = value === 'before' ? patch.after : patch.before;
  if (
    !valuesEqual(patch, current, expected) &&
    !valuesEqual(patch, current, value === 'before' ? patch.before : patch.after)
  )
    return false;
  const patchToApply =
    value === 'before' ? { ...patch, textWrapAfter: patch.textWrapBefore } : patch;
  writeValue(element, patchToApply, patch[value]);
  return true;
};

const labelFor = (element: HTMLElement, textFragment: TextFragment | null = null) => {
  const explicit =
    textFragment && textFragmentBelongsTo(element, textFragment)
      ? ''
      : element.getAttribute('aria-label') || element.dataset.editId;
  if (explicit) return explicit;
  const text = readText(element, textFragment).replace(/\s+/g, ' ').trim();
  const preview = text ? ` · ${text.slice(0, 32)}` : '';
  if (textFragment && textFragmentBelongsTo(element, textFragment) && text) return `文本${preview}`;
  if (/^H[1-6]$/.test(element.tagName)) return `标题${preview}`;
  if (element instanceof HTMLButtonElement) return `按钮${preview}`;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    return `输入框${preview}`;
  if (element instanceof HTMLLIElement) return `列表项${preview}`;
  if (element instanceof HTMLImageElement) return element.alt ? `图片 · ${element.alt}` : '图片';
  if (/^[¥￥$€£]\s?[\d,.]+(?:\.\d+)?$/.test(text)) return `金额文本${preview}`;
  if (element.children.length === 0 && text) return `文本${preview}`;
  const semanticTag: Partial<Record<string, string>> = {
    ARTICLE: '内容卡片',
    ASIDE: '侧栏',
    FOOTER: '页脚',
    HEADER: '页头',
    MAIN: '主内容区',
    NAV: '导航区',
    SECTION: '内容区',
  };
  return semanticTag[element.tagName] ?? (element.id ? `页面元素 · #${element.id}` : '内容容器');
};

const semanticPathFor = (element: HTMLElement, textFragment: TextFragment | null = null) => {
  const regionTags = new Set(['MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER']);
  const ancestors: string[] = [];
  let current = element.parentElement;
  while (current && current !== document.body && ancestors.length < 3) {
    const explicit = current.getAttribute('aria-label')?.trim();
    const label = explicit || (regionTags.has(current.tagName) ? labelFor(current) : '');
    if (label && label !== '内容容器' && !ancestors.includes(label)) ancestors.unshift(label);
    current = current.parentElement;
  }
  const own = labelFor(element, textFragment);
  return [...ancestors, own].filter(Boolean).join(' > ');
};

const valueSourceFor = (
  element: HTMLElement,
  kind: DockPatch['kind'],
  property: DockPatch['property'],
): WorkspaceValueSource => {
  if (kind !== 'style') return 'observed';
  return element.style.getPropertyValue(property).trim() ? 'inline' : 'computed';
};

const targetForSelected = (element: HTMLElement): TargetRef | null => targetFor(element);

const editableDirectTextFragment = (
  element: HTMLElement,
  textFragment: TextFragment | null = null,
) => {
  if (textFragment && textFragmentBelongsTo(element, textFragment) && textFragment.text.trim())
    return textFragment;
  const fragments = directTextFragments(element).filter((fragment) => fragment.text.trim());
  return fragments.length === 1 ? fragments[0]! : null;
};

const objectCapabilityFor = (
  element: HTMLElement,
  textFragment: TextFragment | null = null,
): ObjectCapability => {
  if (!targetForSelected(element)) {
    return {
      status: 'unstable',
      label: '定位不稳定 · 暂不修改',
      description: '当前对象没有唯一稳定定位，暂不开放直接修改；请先选中更明确的内部元素。',
      canEditText: false,
    };
  }

  if (editableDirectTextFragment(element, textFragment)) {
    return {
      status: 'direct',
      label: '可直接编辑',
      description: '可以直接修改当前文字片段的内容、外观和间距。',
      canEditText: true,
    };
  }

  const protectedTag = [
    'CANVAS',
    'IFRAME',
    'IMG',
    'VIDEO',
    'AUDIO',
    'OBJECT',
    'EMBED',
    'SVG',
  ].includes(element.tagName);
  if (protectedTag) {
    return {
      status: 'whole-object',
      label: '仅支持整体调整',
      description: `${element.tagName.toLowerCase()} 的内部内容不能直接编辑；可以调整整体外观、间距和同级位置。`,
      canEditText: false,
    };
  }

  if (element.children.length > 0 && !element.isContentEditable) {
    return {
      status: 'style-only',
      label: '可调整外观',
      description:
        '当前对象包含内部子元素，不直接改整段文字；可以调整当前对象的外观、间距和同级位置。若要改字，请点选内部文字。',
      canEditText: false,
    };
  }

  return {
    status: 'direct',
    label: '可直接编辑',
    description: '可以直接修改当前对象的文字、外观和间距。',
    canEditText: true,
  };
};

const setNotice = (message: string) => {
  state.notice = message;
  render();
};

type WritableTextFile = {
  write: (content: string) => Promise<void>;
  close: () => Promise<void>;
};

type SaveFileHandle = {
  createWritable: () => Promise<WritableTextFile>;
};

type SaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<SaveFileHandle>;

const saveHtmlToChosenLocation = async (
  name: string,
  content: string,
): Promise<'saved' | 'cancelled' | 'unsupported' | 'failed'> => {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (!picker) return 'unsupported';
  try {
    const handle = await picker({
      suggestedName: name,
      types: [{ description: 'HTML 文件', accept: { 'text/html': ['.html', '.htm'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return 'saved';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    return 'failed';
  }
};

const copyTextToClipboard = async (content: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
};

const exportHtml = async () => {
  const copy = document.documentElement.cloneNode(true) as HTMLElement;
  copy.querySelector(`[data-${HOST_ID}]`)?.remove();
  copy.querySelectorAll('script[data-dianjing-bootstrap]').forEach((element) => element.remove());
  copy.removeAttribute('data-dianjing-local-preview');
  const result = await saveHtmlToChosenLocation(
    `页面重构-${new Date().toISOString().slice(0, 10)}.html`,
    `<!doctype html>\n${copy.outerHTML}`,
  );
  setNotice(
    result === 'saved'
      ? 'HTML 静态副本已保存到你选择的位置；未写回原文件'
      : result === 'cancelled'
        ? '已取消保存 HTML，当前修改仍保留'
        : result === 'unsupported'
          ? '当前浏览器不支持选择保存位置，HTML 未保存'
          : 'HTML 保存失败，未生成文件',
  );
};

const promptOperationFromPatch = (patch: DockPatch): PromptOperationInput => ({
  id: patch.id,
  kind: patch.kind,
  property: patch.property,
  before: patch.before,
  after: patch.after,
  beforeSource: patch.beforeSource,
  label: patch.label,
  targetLabel: patch.targetLabel,
  semanticPath: patch.semanticPath,
  target: patch.target,
  textNodeIndex: patch.textNodeIndex,
  createdAt: patch.createdAt,
});

const exportPrompt = async () => {
  const packet = buildAiPromptPacket(
    {
      url: location.href,
      title: document.title,
      sourceMode: state.webCopyMode ? '网页副本模式' : '当前页面',
      viewport: { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) },
    },
    state.history.map(promptOperationFromPatch),
  );
  const prompt = packet.prompt;
  const copied = await copyTextToClipboard(prompt);
  setNotice(
    copied
      ? 'AI 提示词已复制到剪贴板，可交给 Codex、Cursor 或 Claude Code'
      : 'AI 提示词复制失败，请检查浏览器剪贴板权限',
  );
};

const commitPatchFor = (
  element: HTMLElement,
  kind: DockPatch['kind'],
  property: DockPatch['property'],
  after: string,
  label: string,
  textFragment: TextFragment | null = null,
) => {
  const fragment =
    textFragment && textFragmentBelongsTo(textFragment.owner, textFragment) ? textFragment : null;
  const owner = fragment?.owner ?? element;
  const target = targetForSelected(owner);
  if (!target) return setNotice('当前元素没有唯一稳定定位，未修改');
  const effectiveTextFragment =
    kind === 'text' ? editableDirectTextFragment(owner, fragment) : fragment;
  const textNodeIndex = effectiveTextFragment?.index;
  const objectCapability = objectCapabilityFor(owner, effectiveTextFragment);
  if (kind === 'text' && !objectCapability.canEditText) {
    return setNotice(objectCapability.description);
  }
  const writeElement =
    kind === 'style' && effectiveTextFragment
      ? materializeDirectTextFragment(owner, effectiveTextFragment.index)
      : owner;
  if (!writeElement) return setNotice('当前文字对象已失效，未修改');
  const before = currentValue(kind === 'text' ? owner : writeElement, {
    kind,
    property,
    textNodeIndex,
  });
  let nextAfter = after;
  if (kind === 'style' && property === 'visibility') {
    if (after === 'hidden') rememberVisibilityBeforeHiding(writeElement, before);
    else if (before === 'hidden') nextAfter = visibilityRestoreValues.get(writeElement) ?? after;
  }
  const shouldPreserveLineBreaks =
    kind === 'text' &&
    !isTextInput(owner) &&
    nextAfter.includes('\n') &&
    readStyle(effectiveTextFragment ? writeElement : owner, 'white-space') !== 'pre-wrap';
  if (before === nextAfter && !shouldPreserveLineBreaks) return setNotice('当前修改没有变化');
  const textStyleElement =
    effectiveTextFragment && kind === 'text'
      ? (textNodeWrapper(owner, effectiveTextFragment.nodes[0]!) ?? owner)
      : owner;
  const textWrapBefore =
    kind === 'text' && !isTextInput(owner)
      ? textStyleElement.style.getPropertyValue('white-space')
      : undefined;
  const textWrapAfter =
    kind === 'text' && !isTextInput(owner)
      ? nextAfter.includes('\n')
        ? 'pre-wrap'
        : textWrapBefore
      : undefined;
  const patch: DockPatch = {
    id: createPatchId(),
    target,
    kind,
    property,
    before,
    after: nextAfter,
    beforeSource: valueSourceFor(writeElement, kind, property),
    targetLabel: labelFor(owner, kind === 'text' ? effectiveTextFragment : null),
    semanticPath: semanticPathFor(owner, kind === 'text' ? effectiveTextFragment : null),
    label,
    createdAt: new Date().toISOString(),
    textWrapBefore,
    textWrapAfter,
    textNodeIndex,
    textWrapper:
      effectiveTextFragment && kind === 'text'
        ? (textNodeWrapper(owner, effectiveTextFragment.nodes[0]!) ?? undefined)
        : undefined,
    element: kind === 'structure' ? owner : undefined,
    parent: kind === 'structure' ? (owner.parentElement ?? undefined) : undefined,
    index:
      kind === 'structure' && owner.parentElement
        ? [...owner.parentElement.children].indexOf(owner)
        : undefined,
  };
  writeValue(kind === 'text' ? owner : writeElement, patch, nextAfter);
  state.history.push(patch);
  state.future = [];
  state.notice = `已直接修改“${patch.targetLabel}”，当前有 ${state.history.length} 项未导出修改`;
  render();
};

const commitPatch = (
  kind: DockPatch['kind'],
  property: DockPatch['property'],
  after: string,
  label: string,
) => {
  if (!selected) return setNotice('请先选择页面元素');
  commitPatchFor(selected, kind, property, after, label, selectedTextFragment);
};

const moveSelected = (delta: -1 | 1) => {
  if (!selected) return setNotice('请先选择页面元素');
  if (selectedTextFragment) return setNotice('文字对象请直接拖动画布中的亮色边线');
  const parent = selected.parentElement;
  if (!parent) return setNotice('当前对象不能移动');
  const currentIndex = [...parent.children].indexOf(selected);
  const targetIndex = currentIndex + delta;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= parent.children.length)
    return setNotice(delta < 0 ? '当前对象已经在最上方' : '当前对象已经在最下方');
  commitPatch('structure', 'position', String(targetIndex), delta < 0 ? '部件上移' : '部件下移');
};

const placeSelected = (
  element: HTMLElement,
  destination: HTMLElement,
  position: 'before' | 'after' | 'inside',
) => {
  if (selectedTextFragment) return setNotice('文字对象请直接拖动画布中的亮色边线');
  if (element === destination || element.contains(destination))
    return setNotice('不能把对象拖入自身或自己的子对象');
  const beforeParent = element.parentElement;
  if (!beforeParent) return setNotice('当前对象不能移动');
  const afterParent = position === 'inside' ? destination : destination.parentElement;
  if (!afterParent) return setNotice('目标位置不可用');
  const beforeAnchor = element.nextElementSibling;
  let afterAnchor: Element | null =
    position === 'before'
      ? destination
      : position === 'after'
        ? destination.nextElementSibling
        : null;
  if (afterAnchor === element) afterAnchor = element.nextElementSibling;
  if (beforeParent === afterParent && beforeAnchor === afterAnchor)
    return setNotice('对象已经位于该位置');
  const target = targetForSelected(element);
  if (!target) return setNotice('当前对象没有稳定定位，不能拖动');
  const placementStyles = capturePlacementStyles([element]);
  const patch: DockPatch = {
    id: createPatchId(),
    target,
    kind: 'structure',
    property: 'placement',
    before: 'before',
    after: 'after',
    targetLabel: labelFor(element),
    semanticPath: semanticPathFor(element),
    label:
      position === 'inside'
        ? `拖入${labelFor(destination)}`
        : `拖动到${labelFor(destination)}${position === 'before' ? '前' : '后'}`,
    createdAt: new Date().toISOString(),
    element,
    beforeParent,
    afterParent,
    beforeAnchor,
    afterAnchor,
    placementStyles,
  };
  writeValue(element, patch, 'after');
  preservePlacementStylesAfterMove(placementStyles);
  state.history.push(patch);
  state.future = [];
  selected = element;
  selectedTextFragment = null;
  workspaceSelectedTargets = [target];
  state.notice = `已移动“${patch.targetLabel}”，可撤销或在修改记录中取消`;
  render();
};

const documentOrder = (elements: HTMLElement[]) =>
  [...elements].sort((left, right) => {
    if (left === right) return 0;
    const relation = left.compareDocumentPosition(right);
    return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

const placeSelectedMany = (
  elements: HTMLElement[],
  destination: HTMLElement,
  position: 'before' | 'after' | 'inside',
) => {
  if (!elements.length) return setNotice('没有可移动的对象');
  if (elements.some((element) => element === destination || element.contains(destination)))
    return setNotice('不能把对象拖入自身或自己的子对象');

  const ordered = documentOrder([...new Set(elements)]);
  const members = new Set(ordered);
  const afterParent = position === 'inside' ? destination : destination.parentElement;
  if (!afterParent) return setNotice('目标位置不可用');

  let afterAnchor: Element | null =
    position === 'before'
      ? destination
      : position === 'after'
        ? destination.nextElementSibling
        : null;
  while (afterAnchor && members.has(afterAnchor as HTMLElement))
    afterAnchor = afterAnchor.nextElementSibling;

  const placementItems: DockPlacementItem[] = [];
  for (const element of ordered) {
    const beforeParent = element.parentElement;
    if (!beforeParent) return setNotice('当前对象不能移动');
    let beforeAnchor = element.nextElementSibling;
    while (beforeAnchor && members.has(beforeAnchor as HTMLElement))
      beforeAnchor = beforeAnchor.nextElementSibling;
    placementItems.push({
      element,
      beforeParent,
      beforeAnchor,
      afterParent,
      afterAnchor,
    });
  }

  const alreadyPlaced = placementItems.every(
    (item) =>
      item.element.parentElement === item.afterParent &&
      (() => {
        let next = item.element.nextElementSibling;
        while (next && members.has(next as HTMLElement)) next = next.nextElementSibling;
        return next === item.afterAnchor;
      })(),
  );
  if (alreadyPlaced) return setNotice('对象已经位于该位置');

  const targets = ordered.map(targetForSelected);
  if (targets.some((target): target is null => target === null))
    return setNotice('部分对象没有稳定定位，不能批量拖动');
  const placementStyles = capturePlacementStyles(ordered);
  const first = ordered[0]!;
  const patch: DockPatch = {
    id: createPatchId(),
    target: targets[0]!,
    kind: 'structure',
    property: 'placement',
    before: 'before',
    after: 'after',
    targetLabel: `${ordered.length} 个对象`,
    semanticPath: semanticPathFor(first),
    label:
      position === 'inside'
        ? `将 ${ordered.length} 个对象拖入${labelFor(destination)}`
        : `将 ${ordered.length} 个对象拖到${labelFor(destination)}${position === 'before' ? '前' : '后'}`,
    createdAt: new Date().toISOString(),
    element: first,
    placementItems,
    beforeParent: placementItems[0]!.beforeParent,
    beforeAnchor: placementItems[0]!.beforeAnchor,
    afterParent,
    afterAnchor,
    placementStyles,
  };

  writeValue(first, patch, 'after');
  preservePlacementStylesAfterMove(placementStyles);
  state.history.push(patch);
  state.future = [];
  selected = ordered.at(-1)!;
  selectedTextFragment = null;
  workspaceSelectedTargets = targets;
  state.notice = `已移动 ${ordered.length} 个对象，可撤销或在修改记录中取消`;
  render();
};

const groupWorkspaceTargets = (elements: HTMLElement[]) => {
  if (elements.length < 2) return setNotice('至少选择两个对象才能创建组合');
  const parent = elements[0]?.parentElement;
  if (!parent || elements.some((element) => element.parentElement !== parent))
    return setNotice('只有同一父容器中的对象可以创建组合');
  const members = [...elements].sort(
    (left, right) => [...parent.children].indexOf(left) - [...parent.children].indexOf(right),
  );
  const first = members[0];
  const target = first ? targetForSelected(first) : null;
  if (!first || !target) return setNotice('所选对象缺少稳定定位，不能创建组合');
  const wrapper = document.createElement('div');
  wrapper.dataset.editId = `dianjing-group-${createPatchId()}`;
  wrapper.dataset.dianjingGroup = 'true';
  wrapper.setAttribute('aria-label', '对象组合');
  wrapper.style.display = 'contents';
  const patch: DockPatch = {
    id: createPatchId(),
    target,
    kind: 'structure',
    property: 'group',
    before: 'before',
    after: 'after',
    targetLabel: `${members.length} 个对象`,
    semanticPath: semanticPathFor(first),
    label: '创建对象组合',
    createdAt: new Date().toISOString(),
    element: wrapper,
    parent,
    index: [...parent.children].indexOf(first),
    members,
  };
  writeValue(wrapper, patch, 'after');
  state.history.push(patch);
  state.future = [];
  selected = wrapper;
  selectedTextFragment = null;
  const wrapperTarget = targetForSelected(wrapper);
  workspaceSelectedTargets = wrapperTarget ? [wrapperTarget] : [];
  state.notice = `已将 ${members.length} 个对象创建为组合，可撤销或取消此项变更`;
  render();
};

const removeDuplicateIds = (element: HTMLElement) => {
  element.removeAttribute('id');
  element.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'));
};

const duplicateSelected = () => {
  if (!selected) return setNotice('请先选择页面元素');
  if (selectedTextFragment) return setNotice('当前文字对象暂不支持复制');
  const source = selected;
  const parent = source.parentElement;
  const sourceIndex = parent ? [...parent.children].indexOf(source) : -1;
  const target = targetForSelected(source);
  if (!parent || sourceIndex < 0 || !target) return setNotice('当前对象无法复制，未修改');
  const duplicate = source.cloneNode(true) as HTMLElement;
  removeDuplicateIds(duplicate);
  const patch: DockPatch = {
    id: createPatchId(),
    target,
    kind: 'structure',
    property: 'presence',
    before: 'absent',
    after: 'present',
    targetLabel: `${labelFor(source)} 副本`,
    semanticPath: semanticPathFor(source),
    label: '复制部件',
    createdAt: new Date().toISOString(),
    element: duplicate,
    parent,
    index: sourceIndex + 1,
  };
  writeValue(duplicate, patch, 'present');
  state.history.push(patch);
  state.future = [];
  selected = duplicate;
  selectedTextFragment = null;
  state.notice = `已复制“${patch.targetLabel}”，当前有 ${state.history.length} 项未导出修改`;
  render();
};

const requestDeleteSelected = () => {
  if (!selected) return setNotice('请先选择页面元素');
  const parent = selected.parentElement;
  const target = targetForSelected(selected);
  if (!parent || !target) return setNotice('当前对象无法移除，未修改');
  state.deletePending = true;
  state.notice = `请确认是否从页面结构中移除“${labelFor(selected, selectedTextFragment)}”`;
  render();
};

const deleteSelected = () => {
  if (!selected) return setNotice('请先选择页面元素');
  const element = selected;
  if (selectedTextFragment && textFragmentBelongsTo(element, selectedTextFragment)) {
    const parent = element;
    const fragment = resolveDirectTextFragment(element, selectedTextFragment.index);
    if (!fragment) return setNotice('当前文字片段已失效，未修改');
    const textWrapper = fragment.wrapper;
    if (!fragment.nodes.length) return setNotice('当前文字无法删除，未修改');
    const textChild = textWrapper ?? fragment.nodes[0];
    if (!textChild) return setNotice('当前文字无法删除，未修改');
    const textChildIndex = [...parent.childNodes].indexOf(textChild);
    const fragmentNodeSet = new Set<Node>(fragment.nodes);
    const textRestoreAnchors = fragment.nodes.map((node) => {
      let anchor = node.nextSibling;
      while (anchor && fragmentNodeSet.has(anchor)) anchor = anchor.nextSibling;
      return anchor;
    });
    const target = targetForSelected(element);
    if (!target || textChildIndex < 0 || !fragment.nodes.length)
      return setNotice('当前文字无法删除，未修改');
    const patch: DockPatch = {
      id: createPatchId(),
      target,
      kind: 'structure',
      property: 'presence',
      before: 'present',
      after: 'absent',
      targetLabel: labelFor(element, fragment),
      semanticPath: semanticPathFor(element, fragment),
      label: '移除文字对象',
      createdAt: new Date().toISOString(),
      element,
      parent,
      textNodes: fragment.nodes,
      textWrapper: textWrapper ?? undefined,
      textChildIndex,
      textChildPositions: textWrapper
        ? undefined
        : fragment.nodes.map((node) => [...parent.childNodes].indexOf(node)),
      textRestoreAnchors: textWrapper ? undefined : textRestoreAnchors,
    };
    writeValue(element, patch, 'absent');
    state.history.push(patch);
    state.future = [];
    state.deletePending = false;
    selected = parent.parentElement;
    selectedTextFragment = null;
    const parentTarget = selected ? targetForSelected(selected) : null;
    workspaceSelectedTargets = parentTarget ? [parentTarget] : [];
    state.notice = `已从页面结构移除“${patch.targetLabel}”，仍可撤销；当前有 ${state.history.length} 项未导出修改`;
    render();
    return;
  }
  const parent = element.parentElement;
  const index = parent ? [...parent.children].indexOf(element) : -1;
  const target = targetForSelected(element);
  if (!parent || index < 0 || !target) return setNotice('当前对象无法删除，未修改');
  const patch: DockPatch = {
    id: createPatchId(),
    target,
    kind: 'structure',
    property: 'presence',
    before: 'present',
    after: 'absent',
    targetLabel: labelFor(element),
    semanticPath: semanticPathFor(element),
    label: '移除部件',
    createdAt: new Date().toISOString(),
    element,
    parent,
    index,
  };
  writeValue(element, patch, 'absent');
  state.history.push(patch);
  state.future = [];
  state.deletePending = false;
  selected = parent;
  selectedTextFragment = null;
  state.notice = `已从页面结构移除“${patch.targetLabel}”，仍可撤销；当前有 ${state.history.length} 项未导出修改`;
  render();
};

const clearDetachedSelection = () => {
  if (selected && !selected.isConnected) {
    selected = null;
    selectedTextFragment = null;
    state.deletePending = false;
  }
  if (
    selectedTextFragment &&
    (!selectedTextFragment.nodes.every((node) => node.isConnected) ||
      (selectedTextFragment.wrapper !== null && !selectedTextFragment.wrapper.isConnected))
  )
    selectedTextFragment = null;
};

const undo = () => {
  const patch = state.history.pop();
  if (!patch) return setNotice('没有可撤销的修改');
  if (!applyPatch(patch, 'before')) {
    state.history.push(patch);
    return setNotice('撤销失败：目标元素已不存在或内容已变化');
  }
  clearDetachedSelection();
  state.future.push(patch);
  setNotice('已撤销上一项修改');
};

const redo = () => {
  const patch = state.future.pop();
  if (!patch) return setNotice('没有可重做的修改');
  if (!applyPatch(patch, 'after')) {
    state.future.push(patch);
    return setNotice('重做失败：目标元素已不存在或内容已变化');
  }
  clearDetachedSelection();
  state.history.push(patch);
  setNotice('已重做上一项修改');
};

const cancelHistoryEntry = (id: string) => {
  const cancelled = state.history.find((patch) => patch.id === id);
  if (!cancelled) return;
  const all = [...state.history];
  for (const patch of [...all].reverse()) applyPatch(patch, 'before');
  state.history = all.filter((patch) => patch.id !== id);
  for (const patch of state.history) applyPatch(patch, 'after');
  clearDetachedSelection();
  state.future = [];
  state.cancelled.push(cancelled);
  setNotice(`已取消“${cancelled.label}”这项修改`);
};

const clearSelection = () => {
  selected = null;
  selectedTextFragment = null;
  workspaceSelectedTargets = [];
  state.deletePending = false;
  state.historyOpen = false;
  render();
};

type PageSelection = {
  element: HTMLElement;
  textFragment: TextFragment | null;
};

const selectElement = (element: HTMLElement, textFragment: TextFragment | null = null) => {
  selected = element;
  selectedTextFragment =
    textFragment && textFragmentBelongsTo(element, textFragment) ? textFragment : null;
  const target = targetForSelected(element);
  const textNodeIndex =
    target && selectedTextFragment
      ? directTextFragmentIndex(element, selectedTextFragment.nodes[0]!)
      : undefined;
  workspaceSelectedTargets =
    target && textNodeIndex !== undefined ? [{ ...target, textNodeIndex }] : target ? [target] : [];
  state.deletePending = false;
  state.historyOpen = false;
  state.notice = '';
  const objectCapability = objectCapabilityFor(element, selectedTextFragment);
  if (objectCapability.status === 'whole-object' || objectCapability.status === 'style-only') {
    state.activePanel = 'appearance';
  } else {
    state.activePanel = 'text';
  }
  render();
};

const selectionFromEvent = (event: MouseEvent): PageSelection | null => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return null;
  let current: HTMLElement | null = target;
  while (current && current !== document.body) {
    if (isTextFragmentWrapper(current)) {
      const owner = current.parentElement;
      const textFragment = owner
        ? textFragmentForNode(owner, current.firstChild as Text | null)
        : null;
      if (owner && textFragment) return { element: owner, textFragment };
    }
    if (!current.closest(`[data-${HOST_ID}]`) && current.dataset.dockIgnore !== 'true')
      return {
        element: current,
        textFragment:
          current.children.length > 0
            ? directTextFragmentAtPoint(document, current, event.clientX, event.clientY)
            : null,
      };
    current = current.parentElement;
  }
  return null;
};

const onPageClick = (event: MouseEvent) => {
  if (event.composedPath().includes(host)) return;
  if (state.fileMenuOpen) {
    state.fileMenuOpen = false;
    ui.querySelector('.dock-toolbar-popover')?.remove();
    updateToolbar();
  }
  if (state.historyOpen) {
    state.historyOpen = false;
    renderHistoryPopover();
  }
  if (!state.active) return;
  const selection = selectionFromEvent(event);
  if (!selection) return;
  event.preventDefault();
  event.stopPropagation();
  selectElement(selection.element, selection.textFragment);
};

const isDockInputEvent = (event: KeyboardEvent) =>
  event
    .composedPath()
    .some(
      (entry) =>
        entry instanceof HTMLInputElement ||
        entry instanceof HTMLTextAreaElement ||
        entry instanceof HTMLSelectElement ||
        (entry instanceof HTMLElement &&
          (entry.isContentEditable || entry.closest('.dock-toolbar') !== null)),
    );

const directionForKey = (key: string): DockNavigationDirection | null =>
  key === 'ArrowUp'
    ? 'parent'
    : key === 'ArrowDown'
      ? 'child'
      : key === 'ArrowLeft'
        ? 'previous'
        : key === 'ArrowRight'
          ? 'next'
          : null;

const onKeyDown = (event: KeyboardEvent) => {
  if (
    !state.active ||
    !selected ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    isDockInputEvent(event)
  )
    return;
  const direction = directionForKey(event.key);
  if (!direction) return;
  const next = nextDockElement(selected, direction, document);
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  selectElement(next);
};

const drawSelection = () => {
  if (!selected?.isConnected || !state.active) {
    selectionBox.style.display = 'none';
    return;
  }
  let rect: TextFragmentRect = selected.getBoundingClientRect();
  const textRect = textFragmentClientRect(selected, selectedTextFragment);
  if (textRect && (textRect.width || textRect.height)) rect = textRect;
  Object.assign(selectionBox.style, {
    display: 'block',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
};

const applyPanelPosition = () => {
  const maxX = Math.max(12, window.innerWidth - panel.offsetWidth - 12);
  const maxY = Math.max(12, window.innerHeight - panel.offsetHeight - 12);
  state.position = {
    x: Math.min(Math.max(12, state.position.x), maxX),
    y: Math.min(Math.max(12, state.position.y), maxY),
  };
  panel.style.left = `${state.position.x}px`;
  panel.style.top = `${state.position.y}px`;
};

const bindDrag = () => {
  const handle = panel.querySelector<HTMLElement>('[data-dock-drag-handle]');
  if (!handle) return;
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('[data-action="dock-exit"]'))
      return;
    drag = { x: event.clientX, y: event.clientY, left: state.position.x, top: state.position.y };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag) return;
    state.position = {
      x: Math.min(
        Math.max(12, drag.left + event.clientX - drag.x),
        Math.max(12, window.innerWidth - panel.offsetWidth - 12),
      ),
      y: Math.min(
        Math.max(12, drag.top + event.clientY - drag.y),
        Math.max(12, window.innerHeight - panel.offsetHeight - 12),
      ),
    };
    applyPanelPosition();
  });
  const end = () => {
    drag = null;
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
};

const applyToolbarPosition = () => {
  const toolbar = ui?.querySelector<HTMLElement>('.dock-toolbar');
  if (!toolbar) return;
  const size = { width: toolbar.offsetWidth, height: toolbar.offsetHeight };
  if (!size.width || !size.height) return;
  if (!state.toolbarPosition)
    state.toolbarPosition = defaultDockToolbarPosition(size, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  state.toolbarPosition = clampDockToolbarPosition(state.toolbarPosition, size, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  toolbar.style.left = `${state.toolbarPosition.x}px`;
  toolbar.style.top = `${state.toolbarPosition.y}px`;
  toolbar.style.right = 'auto';
  toolbar.style.bottom = 'auto';
  toolbar.style.transform = 'none';
};

const bindToolbarDrag = (toolbar: HTMLElement) => {
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  toolbar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (
      target?.closest(
        'button:not(.dock-toolbar-drag-handle), a, input, textarea, select, .dock-toolbar-popover',
      )
    )
      return;
    applyToolbarPosition();
    const position = state.toolbarPosition;
    if (!position) return;
    drag = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
    toolbar.setPointerCapture(event.pointerId);
    toolbar.classList.add('is-dragging');
    event.preventDefault();
  });
  toolbar.addEventListener('pointermove', (event) => {
    if (!drag) return;
    state.toolbarPosition = clampDockToolbarPosition(
      {
        x: drag.left + event.clientX - drag.x,
        y: drag.top + event.clientY - drag.y,
      },
      { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    applyToolbarPosition();
  });
  const end = (event: PointerEvent) => {
    if (!drag) return;
    drag = null;
    toolbar.classList.remove('is-dragging');
    if (toolbar.hasPointerCapture(event.pointerId)) toolbar.releasePointerCapture(event.pointerId);
  };
  toolbar.addEventListener('pointerup', end);
  toolbar.addEventListener('pointercancel', end);
};

const moveToolbarByKeyboard = (key: string) => {
  const toolbar = ui?.querySelector<HTMLElement>('.dock-toolbar');
  if (!toolbar) return;
  applyToolbarPosition();
  if (!state.toolbarPosition) return;
  const step = 16;
  const delta =
    key === 'ArrowLeft'
      ? { x: -step, y: 0 }
      : key === 'ArrowRight'
        ? { x: step, y: 0 }
        : key === 'ArrowUp'
          ? { x: 0, y: -step }
          : { x: 0, y: step };
  state.toolbarPosition = clampDockToolbarPosition(
    { x: state.toolbarPosition.x + delta.x, y: state.toolbarPosition.y + delta.y },
    { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
  );
  applyToolbarPosition();
};

const renderHistory = () => {
  if (!state.historyOpen) return '';
  const records = [
    ...state.history.map((patch) => ({ patch, cancelled: false })),
    ...state.cancelled.map((patch) => ({ patch, cancelled: true })),
  ];
  return `<section class="history-popover dock-history-popover" role="dialog" aria-label="当前会话修改记录"><div class="history-heading"><strong>修改记录</strong><span>${records.length} 项</span></div>${records.length ? records.map(({ patch, cancelled }) => `<div class="history-row ${cancelled ? 'is-cancelled' : ''}"><div><strong>${escapeHtml(patch.label)}</strong><small>${escapeHtml(patch.targetLabel)}</small></div>${cancelled ? '<em>已取消</em>' : `<button class="history-cancel" data-cancel-history="${patch.id}" title="取消此项" aria-label="取消此项">取消</button>`}</div>`).join('') : '<p class="history-empty">尚未产生直接修改。</p>'}</section>`;
};

const renderHistoryPopover = () => {
  const anchor = ui?.querySelector<HTMLElement>('.dock-toolbar-history-anchor');
  if (!anchor) return;
  anchor.querySelector('.dock-history-popover')?.remove();
  if (state.historyOpen) anchor.insertAdjacentHTML('beforeend', renderHistory());
};

const controlValue = (element: HTMLElement, property: StyleProperty) => {
  const value = readStyle(element, property);
  return property === 'color' ||
    property === 'background-color' ||
    property === 'background' ||
    property === 'border-color'
    ? toHexColor(value)
    : value;
};

const numericStyleValue = (element: HTMLElement, property: StyleProperty) => {
  const value = Number.parseFloat(readStyle(element, property));
  return Number.isFinite(value) ? String(Math.round(value)) : '0';
};

const renderStyleField = (
  element: HTMLElement,
  property: StyleProperty,
  label: string,
  input: 'text' | 'color' | 'number' | 'range' = 'text',
  unit?: 'px',
) => {
  const value =
    unit === 'px' ? numericStyleValue(element, property) : controlValue(element, property);
  const rangeLabel = `${value}${unit ?? ''}`;
  const inputMarkup = `<input data-dock-style="${property}" type="${input}" value="${escapeHtml(value)}"${unit ? ` data-dock-unit="${unit}"` : ''}${input === 'number' ? ' min="0" max="80" step="1"' : ''}${input === 'range' ? ` min="0" max="40" step="1" title="${rangeLabel}" aria-valuetext="${rangeLabel}"` : ''} />`;
  const controlMarkup =
    input === 'range'
      ? `<span class="range-control">${inputMarkup}<output data-dock-range-output="${property}">${rangeLabel}</output></span>`
      : input === 'color'
        ? `<span class="color-control">${inputMarkup}<code>${escapeHtml(value)}</code></span>`
        : inputMarkup;
  return `<label class="field${input === 'range' ? ' field-range' : ''}${input === 'color' ? ' field-color' : ''}"><span>${label}</span>${controlMarkup}</label>`;
};

const updateRangePresentation = (input: HTMLInputElement) => {
  if (input.type !== 'range') return;
  const label = `${input.value}${input.dataset.dockUnit ?? ''}`;
  const output = input.closest('.range-control')?.querySelector<HTMLOutputElement>('output');
  if (output) output.textContent = label;
  input.title = label;
  input.setAttribute('aria-valuetext', label);
};

const renderTabButton = (panelName: DockState['activePanel'], label: string, disabled = false) =>
  `<button class="quick-tab ${state.activePanel === panelName ? 'is-active' : ''}" data-panel="${panelName}" aria-selected="${state.activePanel === panelName}"${disabled ? ' disabled aria-disabled="true"' : ''}>${label}</button>`;

const renderObjectCapabilityNote = (capability: ObjectCapability) =>
  `<div class="object-capability-note object-capability-note--${capability.status}"><strong>${capability.label}</strong><p>${capability.description}</p></div>`;

const renderAlignmentButtons = (
  property: 'text-align' | 'vertical-align',
  values: string[],
  labels: string[],
  element: HTMLElement,
) => {
  const current = readStyle(element, property);
  return values
    .map(
      (value, index) =>
        `<button class="alignment-button ${current === value ? 'is-active' : ''}" data-style-property="${property}" data-style-value="${value}" data-style-label="${labels[index] ?? value}">${labels[index] ?? value}</button>`,
    )
    .join('');
};

const renderSelectedEditorBase = (element: HTMLElement) => {
  const objectCapability = objectCapabilityFor(element, selectedTextFragment);
  const objectIsUnstable = objectCapability.status === 'unstable';
  const tabs = `<div class="quick-tabs" role="tablist" aria-label="元素属性">${renderTabButton('text', '文字', !objectCapability.canEditText)}${renderTabButton('appearance', '外观', objectIsUnstable)}${renderTabButton('spacing', '间距', objectIsUnstable)}</div>`;
  if (objectIsUnstable || (state.activePanel === 'text' && !objectCapability.canEditText)) {
    return `${tabs}${renderObjectCapabilityNote(objectCapability)}`;
  }
  if (state.activePanel === 'appearance') {
    const borderStyle = readStyle(element, 'border-style') || 'none';
    const borderStyleField = `<label class="field field-wide"><span>边框样式</span><select data-dock-style="border-style"><option value="solid" ${borderStyle === 'solid' ? 'selected' : ''}>实线</option><option value="dashed" ${borderStyle === 'dashed' ? 'selected' : ''}>虚线</option><option value="dotted" ${borderStyle === 'dotted' ? 'selected' : ''}>点线</option><option value="none" ${borderStyle === 'none' ? 'selected' : ''}>无边框</option></select></label>`;
    const visible = readStyle(element, 'visibility') !== 'hidden';
    const visibilityAfter = visibilityAfterValue(element, visible);
    return `${tabs}${objectCapability.status === 'direct' ? '' : renderObjectCapabilityNote(objectCapability)}<div class="dock-controls dock-appearance-controls"><section class="property-section"><span class="control-section-label">颜色</span><div class="style-grid style-grid--primary">${renderStyleField(element, 'background', '元素背景', 'color')}${renderStyleField(element, 'border-color', '边框颜色', 'color')}</div></section><section class="property-section property-section--secondary"><div class="section-heading"><span class="control-section-label">边框细节</span><small>圆角、粗细和样式</small></div><div class="style-grid">${renderStyleField(element, 'border-radius', '圆角', 'range', 'px')}${renderStyleField(element, 'border-width', '边框粗细', 'range', 'px')}</div>${borderStyleField}</section><section class="property-section property-section--secondary visibility-section"><div class="section-heading"><span class="control-section-label">可见性</span><small>只影响画布，不改变页面布局</small></div><button class="visibility-toggle ${visible ? 'is-active' : ''}" aria-label="${visible ? '暂时隐藏对象' : '恢复对象显示'}" data-style-property="visibility" data-style-value="${visibilityAfter}" data-style-label="${visible ? '暂时隐藏对象' : '恢复对象显示'}"><span class="visibility-copy"><strong>${visible ? '在画布中显示' : '暂时隐藏对象'}</strong><small>${visible ? '对象当前可见' : '对象保留位置，布局不变'}</small></span><b>${visible ? '显示中' : '已隐藏'}</b><i aria-hidden="true"></i></button></section></div>`;
  }
  if (state.activePanel === 'spacing') {
    const sides = (kind: 'padding' | 'margin', label: string) =>
      `<section class="spacing-section spacing-section--${kind}"><div class="section-heading"><span class="control-section-label">${label}</span><small>${kind === 'padding' ? '元素内部' : '元素外部'}</small></div><div class="box-value-grid">${renderStyleField(element, `${kind}-top`, '上', 'number', 'px')}${renderStyleField(element, `${kind}-right`, '右', 'number', 'px')}${renderStyleField(element, `${kind}-bottom`, '下', 'number', 'px')}${renderStyleField(element, `${kind}-left`, '左', 'number', 'px')}</div></section>`;
    return `${tabs}${objectCapability.status === 'direct' ? '' : renderObjectCapabilityNote(objectCapability)}<div class="dock-controls dock-spacing-controls"><section class="spacing-section spacing-section--alignment"><span class="control-section-label">文字位置</span><div class="alignment-row"><span>水平</span><div class="alignment-buttons">${renderAlignmentButtons('text-align', ['left', 'center', 'right'], ['靠左', '居中', '靠右'], element)}</div></div><div class="alignment-row"><span>垂直</span><div class="alignment-buttons">${renderAlignmentButtons('vertical-align', ['top', 'middle', 'bottom'], ['靠上', '居中', '靠下'], element)}</div></div></section><div class="box-model-editor" aria-label="盒模型间距">${sides('margin', '外边距')}${sides('padding', '内边距')}</div><p class="dock-tab-note">四边可分别调整，修改会即时预览并进入记录。</p></div>`;
  }
  const textDecoration = readStyle(element, 'text-decoration');
  const isDecorationActive = (token: string) => textDecoration.includes(token);
  const fontFamily = readStyle(element, 'font-family');
  return `${tabs}<div class="dock-controls dock-text-controls"><label class="field field-wide field-content"><span>文字内容</span><input data-dock-text type="text" value="${escapeHtml(readText(element, selectedTextFragment))}" /></label><div class="style-grid style-grid--primary">${renderStyleField(element, 'color', '文字颜色', 'color')}${renderStyleField(element, 'font-size', '字号', 'range', 'px')}</div><section class="property-section property-section--secondary"><div class="section-heading"><span class="control-section-label">字体与格式</span><small>字体、高亮和文字装饰</small></div><div class="style-grid">${renderStyleField(element, 'background-color', '文字高亮', 'color')}<label class="field"><span>字体</span><select data-dock-style="font-family">${renderFontOptions(fontFamily)}</select></label></div><div class="format-actions"><button class="format-button ${readStyle(element, 'font-weight') === '700' ? 'is-active' : ''}" data-format="bold"><strong>B</strong> 加粗</button><button class="format-button ${readStyle(element, 'font-style') === 'italic' ? 'is-active' : ''}" data-format="italic"><em>I</em> 倾斜</button><button class="format-button ${isDecorationActive('underline') ? 'is-active' : ''}" data-format="underline"><u>U</u> 下划线</button><button class="format-button ${isDecorationActive('line-through') ? 'is-active' : ''}" data-format="strike"><s>S</s> 删除线</button></div></section></div>`;
};

const renderSelectedEditor = (element: HTMLElement) =>
  renderSelectedEditorBase(element).replace(
    /<input data-dock-text type="text" value="[^"]*" \/>/,
    `<textarea data-dock-text rows="3">${escapeHtml(readText(element, selectedTextFragment))}</textarea>`,
  );

const renderDeleteConfirmation = (element: HTMLElement) =>
  state.deletePending
    ? `<div class="delete-confirm" role="alert"><div class="delete-confirm-copy"><strong>确认移除这个对象？</strong><span>“${escapeHtml(labelFor(element, selectedTextFragment))}”会从页面结构中移除，但仍可通过撤销恢复。</span><small>如果只是暂时不展示，请使用下方“可见性”里的隐藏。</small></div><div class="delete-confirm-actions"><button data-action="delete-cancel">取消</button><button class="delete-confirm-primary" data-action="delete-confirm">移除对象</button></div></div>`
    : '';

const elementRoleLabel = (element: HTMLElement, textFragment: TextFragment | null = null) => {
  if (textFragment && textFragmentBelongsTo(element, textFragment) && textFragment.text.trim())
    return '文本';
  if (/^H[1-6]$/.test(element.tagName)) return '标题';
  if (element instanceof HTMLButtonElement) return '按钮';
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    return '输入框';
  if (element instanceof HTMLLIElement) return '列表项';
  if (element instanceof HTMLImageElement) return '图片';
  if (element instanceof HTMLCanvasElement) return '画布';
  return '元素';
};

const capabilityBadgeLabel = (objectCapability: ObjectCapability) =>
  objectCapability.status === 'direct'
    ? '可编辑'
    : objectCapability.status === 'style-only'
      ? '可调整'
      : objectCapability.status === 'whole-object'
        ? '整体调整'
        : '不可修改';

const render = () => {
  host.style.display = state.active ? 'block' : 'none';
  const objectCapability = selected ? objectCapabilityFor(selected, selectedTextFragment) : null;
  const selectedRole = selected ? elementRoleLabel(selected, selectedTextFragment) : '';
  panel.innerHTML = `<header class="panel-header" data-dock-drag-handle><div class="panel-brand"><span class="panel-brand-mark">${dockIcon('brand')}</span><div><strong>点睛</strong><small>${state.active ? 'AI 创作的最后一笔' : '已暂停编辑'}</small></div></div><div class="panel-header-actions"><span class="drag-dots" aria-label="拖动 Dock 面板" title="拖动 Dock 面板"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></div></header><div class="panel-content">${selected && objectCapability ? `<div class="selected-head"><span class="selected-mark">${selectedRole === '标题' ? 'T' : dockIcon('select')}</span><div><strong>${escapeHtml(labelFor(selected, selectedTextFragment))}</strong><small>当前页面 / ${selectedRole}</small></div><span class="selected-status selected-status--${objectCapability.status}">${capabilityBadgeLabel(objectCapability)}</span><button data-action="clear" aria-label="取消选择" title="取消选择">×</button></div><div class="object-toolbar"><div class="object-actions" aria-label="对象操作"><button data-action="copy" aria-label="复制对象" title="复制对象">${objectActionIcon('copy')}</button><button data-action="move-up" aria-label="上移对象" title="上移对象">${objectActionIcon('up')}</button><button data-action="move-down" aria-label="下移对象" title="下移对象">${objectActionIcon('down')}</button><button class="object-action-danger" data-action="delete" aria-label="删除对象" title="删除对象">${objectActionIcon('delete')}</button></div><p class="keyboard-hint">↑↓ 层级 · ←→ 同级</p></div>${renderSelectedEditor(selected)}` : '<div class="empty-state"><strong>选择页面元素</strong><p>点击页面里的标题、按钮、列表行或模块。</p></div>'}${state.notice ? `<p class="sr-status" role="status">${escapeHtml(state.notice)}</p>` : ''}</div>`;
  if (selectedTextFragment)
    panel
      .querySelectorAll<HTMLElement>(
        '[data-action="copy"], [data-action="move-up"], [data-action="move-down"]',
      )
      .forEach((button) => button.remove());
  const deleteButton = panel.querySelector<HTMLElement>('[data-action="delete"]');
  deleteButton?.setAttribute('aria-label', '从页面结构中移除对象');
  deleteButton?.setAttribute('title', '从页面结构中移除对象（可撤销）');
  if (selected && state.deletePending)
    panel
      .querySelector('.object-toolbar')
      ?.insertAdjacentHTML('afterend', renderDeleteConfirmation(selected));
  if (state.webCopyMode) {
    const note = document.createElement('div');
    note.className = 'web-copy-note';
    note.innerHTML =
      '<strong>网页副本模式</strong><span>修改只作用于当前标签页，不会写回原网站。</span>';
    panel.querySelector('.panel-content')?.prepend(note);
  }
  applyPanelPosition();
  applyToolbarPosition();
  panel
    .querySelector<HTMLElement>('.drag-dots')
    ?.insertAdjacentHTML(
      'afterend',
      `<button class="panel-close" data-action="dock-exit" aria-label="退出 Dock" title="退出 Dock">${dockIcon('close')}</button>`,
    );
  bindDrag();
  panel
    .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      '[data-dock-text], [data-dock-style]',
    )
    .forEach((input) => {
      // Bind to the real control so Shadow DOM event retargeting cannot hide the input.
      const elementAtRender = selected;
      input.addEventListener('change', () => onBoundInputChange(input, elementAtRender));
      if (input instanceof HTMLInputElement) {
        if (input.type === 'range') {
          updateRangePresentation(input);
          input.addEventListener('input', () => updateRangePresentation(input));
        }
        input.addEventListener('keydown', onUiKeyDown);
      }
    });
  drawSelection();
  renderHistoryPopover();
  updateToolbar();
};

const toggleFormat = (format: 'bold' | 'italic' | 'underline' | 'strike') => {
  if (!selected) return setNotice('请先选择页面元素');
  if (format === 'bold') {
    const weight = Number.parseInt(readStyle(selected, 'font-weight'), 10) || 400;
    return commitPatch('style', 'font-weight', weight >= 700 ? '400' : '700', '切换加粗');
  }
  if (format === 'italic') {
    return commitPatch(
      'style',
      'font-style',
      readStyle(selected, 'font-style') === 'italic' ? 'normal' : 'italic',
      '切换倾斜',
    );
  }
  const token = format === 'underline' ? 'underline' : 'line-through';
  const current = readStyle(selected, 'text-decoration')
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => !part.includes('solid') && !part.includes('rgb'));
  const next = current.includes(token)
    ? current.filter((part) => part !== token)
    : [...current, token];
  return commitPatch(
    'style',
    'text-decoration',
    next.length ? next.join(' ') : 'none',
    format === 'underline' ? '切换下划线' : '切换删除线',
  );
};

const onUiClick = (event: Event) => {
  const target =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>(
          '[data-action], [data-cancel-history], [data-panel], [data-style-property], [data-format]',
        )
      : null;
  if (!target) return;
  event.stopPropagation();
  const panelName = target.dataset.panel as DockState['activePanel'] | undefined;
  if (panelName) {
    state.activePanel = panelName;
    render();
    return;
  }
  const styleProperty = target.dataset.styleProperty as StyleProperty | undefined;
  if (styleProperty && target.dataset.styleValue !== undefined) {
    return commitPatch(
      'style',
      styleProperty,
      target.dataset.styleValue,
      target.dataset.styleLabel ?? '调整位置',
    );
  }
  if (target.dataset.format)
    return toggleFormat(target.dataset.format as 'bold' | 'italic' | 'underline' | 'strike');
  const action = target.dataset.action;
  if (action === 'dock-exit') return exitDock();
  if (target.dataset.cancelHistory) return cancelHistoryEntry(target.dataset.cancelHistory);
  if (action === 'delete-cancel') {
    state.deletePending = false;
    state.notice = '已取消移除，页面结构未变化';
    render();
    return;
  }
  if (action === 'delete-confirm') return deleteSelected();
  if (action === 'clear') return clearSelection();
  if (action === 'copy') return duplicateSelected();
  if (action === 'move-up') return moveSelected(-1);
  if (action === 'move-down') return moveSelected(1);
  if (action === 'delete') return requestDeleteSelected();
};

const onBoundInputChange = (
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  element: HTMLElement | null,
) => {
  if (!element) return;
  if (input.dataset.dockText !== undefined) {
    commitPatchFor(
      element,
      'text',
      textPropertyFor(element),
      input.value,
      '修改文字',
      element === selected ? selectedTextFragment : null,
    );
    return;
  }
  const property = input.dataset.dockStyle as StyleProperty | undefined;
  const after = input.dataset.dockUnit === 'px' ? `${input.value}px` : input.value;
  if (property)
    commitPatchFor(
      element,
      'style',
      property,
      after,
      `调整${styleProperties.find((item) => item.property === property)?.label ?? '样式'}`,
    );
};

const dockFileMenuMarkup = () =>
  `<div class="dock-toolbar-popover dock-toolbar-popover--file" role="menu"><span class="dock-popover-title">文件</span><button data-action="dock-open-html" role="menuitem"><span class="popover-icon">${dockIcon('file')}</span><span><strong>打开 HTML</strong><small>绑定本地文件名</small></span></button><button data-action="open-html-export" role="menuitem"><span class="popover-icon">${dockIcon('export')}</span><span><strong>导出 HTML</strong><small>选择保存位置</small></span></button><button data-action="export-viewport-png" role="menuitem"><span class="popover-icon">${dockIcon('export')}</span><span><strong>整页 PNG</strong><small>完整页面截图，不包含点睛界面</small></span></button></div>`;

const safeFileStem = (value: string) =>
  [...value]
    .map((character) =>
      character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character) ? '-' : character,
    )
    .join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 80) || '页面';

const exportViewportPng = async () => {
  setNotice('正在隐藏点睛界面并生成整页 PNG…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'workspace/capture-visible' });
    if (!response?.ok || !response.dataUrl) throw new Error(response?.error ?? '截图失败');
    const anchor = document.createElement('a');
    anchor.href = response.dataUrl;
    anchor.download = `点睛-${safeFileStem(response.title || document.title)}-整页.png`;
    anchor.click();
    setNotice('整页 PNG 已导出，点睛界面和原滚动位置已恢复');
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '整页 PNG 导出失败');
  }
};

const nextPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

const pageCaptureMetrics = () => {
  const root = document.documentElement;
  const body = document.body;
  return {
    scrollHeight: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, window.innerHeight),
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
  };
};

const hideRepeatedFixedElements = (hide: boolean) => {
  if (!hide) {
    captureFixedElementStyles.forEach((style, element) => {
      element.style.setProperty('visibility', style.value, style.priority);
    });
    return;
  }
  if (!captureFixedElementStyles.size) {
    document.querySelectorAll<HTMLElement>('body *').forEach((element) => {
      if (element === host || element.closest(`[data-${HOST_ID}]`)) return;
      const position = getComputedStyle(element).position;
      if (position !== 'fixed' && position !== 'sticky') return;
      captureFixedElementStyles.set(element, {
        value: element.style.getPropertyValue('visibility'),
        priority: element.style.getPropertyPriority('visibility'),
      });
    });
  }
  captureFixedElementStyles.forEach((_style, element) => {
    element.style.setProperty('visibility', 'hidden', 'important');
  });
};

const preparePageCapture = async () => {
  captureHiddenBefore = host.hidden;
  captureHostStyleBefore = host.getAttribute('style') ?? '';
  captureScrollBefore = { x: window.scrollX, y: window.scrollY };
  captureScrollBehaviorBefore = {
    value: document.documentElement.style.getPropertyValue('scroll-behavior'),
    priority: document.documentElement.style.getPropertyPriority('scroll-behavior'),
  };
  host.hidden = true;
  host.style.setProperty('display', 'none', 'important');
  document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
  await nextPaint();
  return { ready: true, ...pageCaptureMetrics() };
};

const scrollPageCapture = async (top: number) => {
  const { scrollHeight, viewportHeight } = pageCaptureMetrics();
  const targetTop = Math.min(Math.max(0, top), Math.max(0, scrollHeight - viewportHeight));
  window.scrollTo(captureScrollBefore.x, targetTop);
  hideRepeatedFixedElements(targetTop > 0);
  await nextPaint();
  return { top: window.scrollY };
};

const restorePageCapture = async () => {
  hideRepeatedFixedElements(false);
  captureFixedElementStyles.clear();
  if (captureScrollBehaviorBefore)
    document.documentElement.style.setProperty(
      'scroll-behavior',
      captureScrollBehaviorBefore.value,
      captureScrollBehaviorBefore.priority,
    );
  host.setAttribute('style', captureHostStyleBefore);
  host.hidden = captureHiddenBefore;
  window.scrollTo(captureScrollBefore.x, captureScrollBefore.y);
  await nextPaint();
  return { restored: true };
};

const workspaceExportHtml = async (onProgress?: (progress: WorkspaceExportProgress) => void) => {
  const snapshot = await createOfflineHtmlSnapshot(document, {
    sourceUrl: location.href,
    onProgress,
    prepareClone: (copy) => {
      copy.querySelector(`[data-${HOST_ID}]`)?.remove();
      copy.removeAttribute('data-dianjing-local-preview');
      copy.removeAttribute('data-dianjing-workspace-source');
      copy
        .querySelectorAll('[data-dianjing-target]')
        .forEach((element) => element.removeAttribute('data-dianjing-target'));
      copy
        .querySelectorAll('[data-dianjing-selected]')
        .forEach((element) => element.removeAttribute('data-dianjing-selected'));
    },
  });
  if (snapshot.failures.length)
    throw new Error(`离线资源未能完整采集：${snapshot.failures.slice(0, 3).join('；')}`);
  return snapshot;
};

const buildWorkspaceState = (): WorkspacePageState => {
  const sourceElements = [
    document.documentElement,
    ...document.documentElement.querySelectorAll<HTMLElement>('*'),
  ];
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const cloneElements = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
  const ids = new Map<HTMLElement, string>();
  const targets = new Map<HTMLElement, TargetRef>();
  const parents = new Map<HTMLElement, HTMLElement | null>();
  const depths = new Map<HTMLElement, number>();

  sourceElements.forEach((element, index) => {
    if (
      element === host ||
      isTextFragmentWrapper(element) ||
      element.closest(`[data-${HOST_ID}]`) ||
      ['HTML', 'HEAD', 'BODY', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE'].includes(element.tagName)
    )
      return;
    const target = targetForSelected(element);
    if (!target) return;
    const id = workspaceTargetKey(target);
    ids.set(element, id);
    targets.set(element, target);
    if (isWorkspaceCanvasSource) element.dataset.dianjingTarget = id;
    cloneElements[index]?.setAttribute('data-dianjing-target', id);
  });

  const selectedIds = workspaceSelectedTargets.map(workspaceTargetKey);
  const selectedIdSet = new Set(selectedIds);
  const selectedTextOwnerIds = new Set(
    workspaceSelectedTargets
      .filter((target) => target.textNodeIndex !== undefined)
      .map((target) => workspaceTargetKey({ ...target, textNodeIndex: undefined })),
  );
  const expandedIds = new Set(workspaceExpandedTargets.map(workspaceTargetKey));
  const selectedPathIds = new Set(selectedIds);
  const selectedContextParentIds = new Set<string>();
  [...ids].forEach(([element, id]) => {
    let parent = element.parentElement;
    while (parent && !ids.has(parent)) parent = parent.parentElement;
    parents.set(element, parent);
    let depth = 0;
    let cursor = parent;
    while (cursor) {
      depth += 1;
      cursor = parents.get(cursor) ?? null;
    }
    depths.set(element, depth);
    const selectedTextOwner = selectedTextOwnerIds.has(id);
    if (!selectedIdSet.has(id) && !selectedTextOwner) return;
    if (selectedTextOwner) {
      selectedPathIds.add(id);
      selectedContextParentIds.add(id);
    }
    const directParentId = parent ? ids.get(parent) : undefined;
    if (directParentId) selectedContextParentIds.add(directParentId);
    let ancestor = parent;
    while (ancestor) {
      const ancestorId = ids.get(ancestor);
      if (ancestorId) selectedPathIds.add(ancestorId);
      ancestor = parents.get(ancestor) ?? null;
    }
  });
  type WorkspaceNode = {
    domNode: Node;
    element: HTMLElement;
    id: string;
    target: WorkspaceTarget;
    parent: HTMLElement | null;
    depth: number;
    textFragment: TextFragment | null;
  };
  const elementNodes: WorkspaceNode[] = [...ids].map(([element, id]) => ({
    domNode: element,
    element,
    id,
    target: targets.get(element)!,
    parent: parents.get(element) ?? null,
    depth: depths.get(element) ?? 0,
    textFragment: null,
  }));
  const textFragments: WorkspaceNode[] = elementNodes.flatMap((node) => {
    if (!shouldExposeDirectTextFragments(node.element, selectedTextOwnerIds.has(node.id)))
      return [];
    return directTextFragments(node.element).flatMap((textFragment) => {
      if (!textFragment.text.trim()) return [];
      return [
        {
          domNode: textFragment.nodes[0]!,
          element: node.element,
          id: workspaceTargetKey({ ...node.target, textNodeIndex: textFragment.index }),
          target: { ...node.target, textNodeIndex: textFragment.index },
          parent: node.element,
          depth: node.depth + 1,
          textFragment,
        },
      ];
    });
  });
  const nodes = [...elementNodes, ...textFragments].sort((left, right) => {
    const relation = left.domNode.compareDocumentPosition(right.domNode);
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    if (relation & Node.DOCUMENT_POSITION_CONTAINS) return -1;
    if (relation & Node.DOCUMENT_POSITION_CONTAINED_BY) return 1;
    return 0;
  });
  const parentIdsWithChildren = new Set(
    nodes
      .map((node) => (node.parent ? ids.get(node.parent) : undefined))
      .filter((id): id is string => Boolean(id)),
  );
  const regionTags = new Set(['MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER']);
  const regionFor = (element: HTMLElement) => {
    let current: HTMLElement | null = element;
    let region: HTMLElement | null = null;
    while (current && current !== document.body && current !== document.documentElement) {
      if (regionTags.has(current.tagName)) region = current;
      current = current.parentElement;
    }
    if (!region) {
      region = element;
      let parent = region.parentElement;
      while (parent && ids.has(parent)) {
        region = parent;
        parent = parent.parentElement;
      }
    }
    if (!region) return null;
    const regionId = ids.get(region);
    if (!regionId) return null;
    return {
      regionId,
      regionLabel: labelFor(region),
    };
  };
  const selectableTargets: WorkspaceSelectableTarget[] = nodes.map((node) => {
    const region = regionFor(node.element);
    return {
      id: node.id,
      target: node.target,
      parentId: node.parent ? ids.get(node.parent) : undefined,
      hasChildren: parentIdsWithChildren.has(node.id),
      depth: node.depth,
      tag: node.textFragment ? '#text' : node.element.tagName.toLowerCase(),
      label: labelFor(node.element, node.textFragment),
      role: elementRoleLabel(node.element, node.textFragment),
      text: readText(node.element, node.textFragment).slice(0, 500),
      ...(region ?? {}),
    };
  });
  const elements: WorkspaceElement[] = nodes
    .filter((node) => {
      const parentId = node.parent ? ids.get(node.parent) : undefined;
      return (
        node.depth <= 1 ||
        selectedPathIds.has(node.id) ||
        (parentId !== undefined &&
          (expandedIds.has(parentId) || selectedContextParentIds.has(parentId)))
      );
    })
    .map((node) => {
      const objectCapability = objectCapabilityFor(node.element, node.textFragment);
      const styleElement = node.textFragment
        ? (node.textFragment.wrapper ?? node.element)
        : node.element;
      const styles = Object.fromEntries(
        [
          'color',
          'background-color',
          'font-size',
          'font-weight',
          'font-family',
          'font-style',
          'text-decoration',
          'text-align',
          'vertical-align',
          'visibility',
          'display',
          'position',
          'left',
          'top',
          'width',
          'height',
          'min-width',
          'line-height',
          'gap',
          'flex-direction',
          'justify-content',
          'background',
          'border-color',
          'border-width',
          'border-style',
          'padding-top',
          'padding-right',
          'padding-bottom',
          'padding-left',
          'margin-top',
          'margin-right',
          'margin-bottom',
          'margin-left',
          'border-radius',
        ].map((property) => {
          if (node.textFragment && !node.textFragment.wrapper) {
            if (property === 'position') return [property, 'static'];
            if (property === 'left' || property === 'top') return [property, '0px'];
          }
          return [property, readStyle(styleElement, property as StyleProperty)];
        }),
      );
      return {
        id: node.id,
        target: node.target,
        parentId: node.parent ? ids.get(node.parent) : undefined,
        hasChildren: parentIdsWithChildren.has(node.id),
        childrenLoaded:
          !parentIdsWithChildren.has(node.id) || node.depth === 0 || expandedIds.has(node.id),
        depth: node.depth,
        tag: node.textFragment ? '#text' : node.element.tagName.toLowerCase(),
        label: labelFor(node.element, node.textFragment),
        role: elementRoleLabel(node.element, node.textFragment),
        text: readText(node.element, node.textFragment).slice(0, 500),
        capability: objectCapability.status,
        styles,
      };
    });
  const validSelectedIds = availableWorkspaceSelectionIds(selectedIds, selectableTargets);

  clone.querySelector(`[data-${HOST_ID}]`)?.remove();
  clone.querySelectorAll('script,noscript').forEach((element) => element.remove());
  clone.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith('on')) element.removeAttribute(attribute.name);
    }
    element.removeAttribute('autofocus');
    element.removeAttribute('contenteditable');
  });
  const head = clone.querySelector('head');
  if (head) {
    const base = document.createElement('base');
    base.href = location.href;
    head.prepend(base);
    const snapshotStyle = document.createElement('style');
    snapshotStyle.textContent =
      '[data-dianjing-target]{cursor:default!important}[data-dianjing-target][data-dianjing-selected="true"]{outline:2px solid #1677ff!important;outline-offset:2px!important}';
    head.append(snapshotStyle);
  }

  const validSelectedIdSet = new Set(validSelectedIds);
  const selectedElementIds = new Set(
    workspaceSelectedTargets
      .filter((target) => validSelectedIdSet.has(workspaceTargetKey(target)))
      .map((target) => workspaceTargetKey({ ...target, textNodeIndex: undefined })),
  );
  clone.querySelectorAll<HTMLElement>('[data-dianjing-target]').forEach((element) => {
    if (selectedElementIds.has(element.dataset.dianjingTarget ?? ''))
      element.dataset.dianjingSelected = 'true';
  });

  return {
    url: location.href,
    title: document.title,
    capabilityLabel: capability.label,
    capabilityStatus: capability.status,
    selectedIds: validSelectedIds,
    elements,
    selectableTargets,
    history: [
      ...state.history.map((patch) => ({
        id: patch.id,
        label: patch.label,
        targetLabel: patch.targetLabel,
        createdAt: patch.createdAt,
        kind: patch.kind,
        property: patch.property,
        before: patch.before,
        after: patch.after,
        beforeSource: patch.beforeSource,
        semanticPath: patch.semanticPath,
        target: patch.target,
        textNodeIndex: patch.textNodeIndex,
      })),
      ...state.cancelled.map((patch) => ({
        id: patch.id,
        label: patch.label,
        targetLabel: patch.targetLabel,
        createdAt: patch.createdAt,
        kind: patch.kind,
        property: patch.property,
        before: patch.before,
        after: patch.after,
        beforeSource: patch.beforeSource,
        semanticPath: patch.semanticPath,
        target: patch.target,
        textNodeIndex: patch.textNodeIndex,
        cancelled: true,
      })),
    ],
    futureCount: state.future.length,
    snapshotHtml: `<!doctype html>${clone.outerHTML}`,
    notice: state.notice,
    capturedAt: new Date().toISOString(),
    canvas: {
      width: Math.max(320, Math.round(window.innerWidth)),
      height: Math.max(240, Math.round(window.innerHeight)),
    },
  };
};

type WorkspaceLayoutBox = {
  handle: WorkspaceLayoutHandle;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type WorkspaceLayoutValidation = (handles: WorkspaceTargetHandle[]) => string | null;

const layoutParentForHandle = (handle: WorkspaceTargetHandle): HTMLElement | null =>
  handle.kind === 'text-fragment' ? handle.owner : handle.element.parentElement;

const resolveWorkspaceLayoutTargets = (
  targets: WorkspaceTarget[],
  validate?: WorkspaceLayoutValidation,
): { ok: true; handles: WorkspaceLayoutHandle[] } | { ok: false; error: string } => {
  const resolvedTargets: WorkspaceTargetHandle[] = [];
  const seenTargetKeys = new Set<string>();
  const ownersWithFragments = new Set<HTMLElement>();
  const elementOwners = new Set<HTMLElement>();

  for (const target of targets) {
    const resolved = resolveWorkspaceTargetHandle(target);
    if (!resolved.ok) return resolved;
    const handle = resolved.handle;
    const targetKey = workspaceTargetKey(handle.target);
    if (seenTargetKeys.has(targetKey))
      return { ok: false, error: '同一个实际布局对象被重复选择，请清理选择后重试' };
    seenTargetKeys.add(targetKey);
    if (handle.kind === 'text-fragment') ownersWithFragments.add(handle.owner);
    else elementOwners.add(handle.element);
    resolvedTargets.push(handle);
  }

  if ([...ownersWithFragments].some((owner) => elementOwners.has(owner)))
    return {
      ok: false,
      error: '父容器与其文字片段不能同时参与批量布局，请取消其中一个选择',
    };

  if (
    resolvedTargets.some(
      (handle) => handle.kind === 'text-fragment' && !handle.fragment.nodes.length,
    )
  )
    return { ok: false, error: '文字片段已失效，未修改页面' };

  const validationError = validate?.(resolvedTargets);
  if (validationError) return { ok: false, error: validationError };

  const handles: WorkspaceLayoutHandle[] = [];
  for (const handle of resolvedTargets) {
    const materialized = materializeWorkspaceLayoutHandle(handle);
    if (!materialized) return { ok: false, error: '文字片段无法物化为布局对象，未修改页面' };
    handles.push(materialized);
  }
  return { ok: true, handles };
};

const workspaceLayoutBoxes = (handles: WorkspaceLayoutHandle[]): WorkspaceLayoutBox[] =>
  handles.map((handle) => {
    const element = handle.layoutElement;
    const rect = element.getBoundingClientRect();
    return {
      handle,
      element,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  });

const commitLayoutStyle = (
  handle: WorkspaceLayoutHandle,
  property: StyleProperty,
  after: string,
  label: string,
) =>
  handle.kind === 'text-fragment'
    ? commitPatchFor(handle.owner, 'style', property, after, label, handle.fragment)
    : commitPatchFor(handle.element, 'style', property, after, label);

const moveWorkspaceLayoutTargetBy = (
  handle: WorkspaceLayoutHandle,
  deltaX: number,
  deltaY: number,
  label: string,
) => {
  if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
  const element = handle.layoutElement;
  const computed = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const position = objectMovePosition({
    position: computed.position,
    left: computed.left,
    top: computed.top,
    right: computed.right,
    bottom: computed.bottom,
    offsetLeft: element.offsetLeft,
    offsetTop: element.offsetTop,
    rectLeft: rect.left,
    rectTop: rect.top,
  });
  if (position.position)
    commitLayoutStyle(handle, 'position', position.position, '启用对象自由移动');
  if (position.clearRight) commitLayoutStyle(handle, 'right', 'auto', '解除右侧定位锚点');
  if (position.clearBottom) commitLayoutStyle(handle, 'bottom', 'auto', '解除底部定位锚点');
  if (Math.abs(deltaX) >= 0.5)
    commitLayoutStyle(handle, 'left', `${Math.round(position.left + deltaX)}px`, label);
  if (Math.abs(deltaY) >= 0.5)
    commitLayoutStyle(handle, 'top', `${Math.round(position.top + deltaY)}px`, label);
};

const moveWorkspaceTextFragmentBy = (
  handle: WorkspaceLayoutHandle,
  deltaX: number,
  deltaY: number,
  label: string,
) => {
  if (handle.kind !== 'text-fragment') return setNotice('当前对象不是独立文字对象');
  moveWorkspaceLayoutTargetBy(handle, deltaX, deltaY, label);
};

const alignWorkspaceElements = (
  handles: WorkspaceLayoutHandle[],
  alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom',
  guide?: WorkspaceGuide,
) => {
  const boxes = workspaceLayoutBoxes(handles);
  const minimumObjects = guide ? 1 : 2;
  if (boxes.length < minimumObjects)
    return setNotice(guide ? '至少选择一个对象才能对齐' : '至少选择两个对象才能对齐');
  const anchor = boxes[0]!;
  const guidePositionX = guide?.orientation === 'vertical' ? guide.position - window.scrollX : 0;
  const guidePositionY = guide?.orientation === 'horizontal' ? guide.position - window.scrollY : 0;
  const labels = {
    left: '左对齐',
    center: '水平居中',
    right: '右对齐',
    top: '顶部对齐',
    middle: '垂直居中',
    bottom: '底部对齐',
  } as const;
  for (const [index, box] of boxes.entries()) {
    if (!guide && index === 0) continue;
    const deltaX =
      alignment === 'left'
        ? (guide?.orientation === 'vertical' ? guidePositionX : anchor.left) - box.left
        : alignment === 'center'
          ? (guide?.orientation === 'vertical'
              ? guidePositionX
              : (anchor.left + anchor.right) / 2) -
            (box.left + box.right) / 2
          : alignment === 'right'
            ? (guide?.orientation === 'vertical' ? guidePositionX : anchor.right) - box.right
            : 0;
    const deltaY =
      alignment === 'top'
        ? (guide?.orientation === 'horizontal' ? guidePositionY : anchor.top) - box.top
        : alignment === 'middle'
          ? (guide?.orientation === 'horizontal'
              ? guidePositionY
              : (anchor.top + anchor.bottom) / 2) -
            (box.top + box.bottom) / 2
          : alignment === 'bottom'
            ? (guide?.orientation === 'horizontal' ? guidePositionY : anchor.bottom) - box.bottom
            : 0;
    moveWorkspaceLayoutTargetBy(
      box.handle,
      deltaX,
      deltaY,
      guide ? `参考线${labels[alignment]}` : `批量${labels[alignment]}`,
    );
  }
};

const workspaceGuideValidationError = (guide: WorkspaceGuide | undefined) => {
  if (!guide) return null;
  if (guide.orientation !== 'vertical' && guide.orientation !== 'horizontal')
    return '参考线方向无效，未修改页面';
  if (!Number.isFinite(guide.position) || !Number.isInteger(guide.position) || guide.position < 0)
    return '参考线位置必须是非负整数 px，未修改页面';
  return null;
};

const workspaceGuideAlignmentError = (
  guide: WorkspaceGuide | undefined,
  alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom',
) => {
  if (!guide) return null;
  const verticalAlignment = alignment === 'left' || alignment === 'center' || alignment === 'right';
  const horizontalAlignment =
    alignment === 'top' || alignment === 'middle' || alignment === 'bottom';
  if (guide.orientation === 'vertical' && !verticalAlignment)
    return '竖直参考线只支持左、水平居中、右对齐，未修改页面';
  if (guide.orientation === 'horizontal' && !horizontalAlignment)
    return '水平参考线只支持顶部、垂直居中、底部对齐，未修改页面';
  return null;
};

const distributeWorkspaceElements = (
  handles: WorkspaceLayoutHandle[],
  direction: 'horizontal' | 'vertical',
) => {
  const boxes = workspaceLayoutBoxes(handles);
  if (boxes.length < 3) return setNotice('至少选择三个对象才能等距分布');
  const ordered = [...boxes].sort((left, right) =>
    direction === 'horizontal' ? left.left - right.left : left.top - right.top,
  );
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const span = direction === 'horizontal' ? last.right - first.left : last.bottom - first.top;
  const totalSize = ordered.reduce(
    (total, box) => total + (direction === 'horizontal' ? box.width : box.height),
    0,
  );
  const gap = (span - totalSize) / (ordered.length - 1);
  let cursor = direction === 'horizontal' ? first.left : first.top;
  for (const box of ordered) {
    const delta = cursor - (direction === 'horizontal' ? box.left : box.top);
    moveWorkspaceLayoutTargetBy(
      box.handle,
      direction === 'horizontal' ? delta : 0,
      direction === 'vertical' ? delta : 0,
      direction === 'horizontal' ? '水平等距分布' : '垂直等距分布',
    );
    cursor += (direction === 'horizontal' ? box.width : box.height) + gap;
  }
};

const selectWorkspaceTargets = (
  targetsToSelect: WorkspaceTarget[],
): { ok: true } | { ok: false; error: string } => {
  const resolved: WorkspaceTargetHandle[] = [];
  for (const target of targetsToSelect) {
    const result = resolveWorkspaceTargetHandle(target);
    if (!result.ok) return result;
    resolved.push(result.handle);
  }
  const selectedTextOwners = new Set(
    resolved.filter((handle) => handle.kind === 'text-fragment').map((handle) => handle.owner),
  );
  if (
    resolved.some((handle) => handle.kind === 'element' && selectedTextOwners.has(handle.element))
  )
    return {
      ok: false,
      error: '父容器与其文字片段不能同时选中，请取消其中一个选择',
    };
  workspaceSelectedTargets = resolved.map((handle) => handle.target);
  const primary = resolved.at(-1);
  selected = primary?.kind === 'text-fragment' ? primary.owner : (primary?.element ?? null);
  selectedTextFragment = primary?.kind === 'text-fragment' ? primary.fragment : null;
  state.deletePending = false;
  state.notice = resolved.length > 1 ? `已选择 ${resolved.length} 个对象，可进行批量布局` : '';
  if (selected) {
    const objectCapability = objectCapabilityFor(selected, selectedTextFragment);
    state.activePanel = objectCapability.canEditText ? 'text' : 'appearance';
  }
  render();
  return { ok: true };
};

const handleWorkspaceCommand = async (
  command: WorkspaceCommand,
  onProgress?: (progress: WorkspaceExportProgress) => void,
) => {
  if (command.action === 'get-state') {
    workspaceExpandedTargets = command.expandedTargets ?? workspaceExpandedTargets;
    return { ok: true, state: buildWorkspaceState() };
  }
  if (command.action === 'select') {
    const selection = selectWorkspaceTargets(command.targets);
    if (!selection.ok) return selection;
  }
  if (command.action === 'change') {
    const change = command.change;
    const resolved = resolveWorkspaceTargetHandle(change.target);
    if (!resolved.ok) return resolved;
    const handle = resolved.handle;
    const owner = handle.kind === 'text-fragment' ? handle.owner : handle.element;
    const fragment = handle.kind === 'text-fragment' ? handle.fragment : null;
    if (change.kind === 'text') {
      if (change.target.textNodeIndex !== undefined && !fragment)
        return { ok: false, error: '文字片段已失效，请刷新工作台后重试' };
      commitPatchFor(owner, 'text', textPropertyFor(owner), change.after, change.label, fragment);
    } else {
      const property = change.property as StyleProperty;
      const isInternalPositionProperty = property === 'right' || property === 'bottom';
      if (
        !styleProperties.some((item) => item.property === property) &&
        !isInternalPositionProperty
      )
        return { ok: false, error: `不支持直接修改 ${change.property}` };
      const styleTarget =
        handle.kind === 'text-fragment'
          ? materializeDirectTextFragment(handle.owner, handle.fragment.index)
          : handle.element;
      if (!styleTarget) return { ok: false, error: '文字对象已失效，请刷新工作台后重试' };
      if (
        handle.kind === 'text-fragment' &&
        (property === 'left' || property === 'top') &&
        readStyle(styleTarget, 'position') === 'static'
      )
        commitPatchFor(
          handle.owner,
          'style',
          'position',
          'relative',
          '启用文字对象自由移动',
          fragment,
        );
      commitPatchFor(owner, 'style', property, change.after, change.label, fragment);
    }
  }
  if (command.action === 'align') {
    const guideError = workspaceGuideValidationError(command.guide);
    if (guideError) return { ok: false, error: guideError };
    const alignmentError = workspaceGuideAlignmentError(command.guide, command.alignment);
    if (alignmentError) return { ok: false, error: alignmentError };
    const minimumObjects = command.guide ? 1 : 2;
    const resolved = resolveWorkspaceLayoutTargets(command.targets, (handles) =>
      handles.length < minimumObjects
        ? command.guide
          ? '至少选择一个对象才能对齐'
          : '至少选择两个对象才能对齐'
        : null,
    );
    if (!resolved.ok) return resolved;
    alignWorkspaceElements(resolved.handles, command.alignment, command.guide);
  }
  if (command.action === 'distribute') {
    const resolved = resolveWorkspaceLayoutTargets(command.targets, (handles) =>
      handles.length < 3 ? '至少选择三个对象才能等距分布' : null,
    );
    if (!resolved.ok) return resolved;
    distributeWorkspaceElements(resolved.handles, command.direction);
  }
  if (command.action === 'gap') {
    const resolved = resolveWorkspaceLayoutTargets(command.targets, (handles) => {
      const parents = handles.map(layoutParentForHandle);
      const parent = parents[0];
      return parent && parents.every((candidate) => candidate === parent)
        ? null
        : '只有同一父容器中的对象可以统一分布或间距';
    });
    if (!resolved.ok) return resolved;
    const parent = layoutParentForHandle(resolved.handles[0]!);
    if (!parent) return { ok: false, error: '统一间距的父容器已失效，未修改页面' };
    const direction = command.direction === 'horizontal' ? 'row' : 'column';
    const display = readStyle(parent, 'display');
    if (display !== 'flex' && display !== 'grid')
      commitPatchFor(parent, 'style', 'display', 'flex', '启用容器布局');
    commitPatchFor(
      parent,
      'style',
      'flex-direction',
      direction,
      command.direction === 'horizontal' ? '水平排列' : '垂直排列',
    );
    commitPatchFor(parent, 'style', 'gap', `${Math.max(0, command.value)}px`, '统一对象间距');
  }
  if (command.action === 'size') {
    const resolved = resolveWorkspaceLayoutTargets(command.targets, (handles) =>
      handles.length < 2 ? '至少选择两个对象才能统一尺寸' : null,
    );
    if (!resolved.ok) return resolved;
    for (const handle of resolved.handles) {
      if (
        handle.kind === 'text-fragment' &&
        getComputedStyle(handle.layoutElement).display === 'inline'
      )
        commitLayoutStyle(handle, 'display', 'inline-block', '启用文字对象尺寸');
    }
    const elements = resolved.handles.map((handle) => handle.layoutElement);
    const width = Math.max(...elements.map((element) => element.getBoundingClientRect().width));
    const height = Math.max(...elements.map((element) => element.getBoundingClientRect().height));
    for (const [index] of elements.entries()) {
      const handle = resolved.handles[index]!;
      if (command.dimension === 'width' || command.dimension === 'both')
        commitLayoutStyle(handle, 'width', `${Math.round(width)}px`, '统一对象宽度');
      if (command.dimension === 'height' || command.dimension === 'both')
        commitLayoutStyle(handle, 'height', `${Math.round(height)}px`, '统一对象高度');
    }
  }
  if (command.action === 'group') {
    if (command.targets.some((target) => target.textNodeIndex !== undefined))
      return { ok: false, error: '文字对象暂不支持组合，未改变父容器' };
    const elements: HTMLElement[] = [];
    for (const target of command.targets) {
      const resolved = resolveWorkspaceElementHandle(target);
      if (!resolved.ok) return resolved;
      elements.push(resolved.handle.element);
    }
    groupWorkspaceTargets(elements);
  }
  if (command.action === 'undo') undo();
  if (command.action === 'redo') redo();
  if (command.action === 'cancel-history') cancelHistoryEntry(command.id);
  if (command.action === 'move-text') {
    if (command.target.textNodeIndex === undefined)
      return { ok: false, error: '当前对象不是独立文字对象' };
    const resolved = resolveWorkspaceLayoutHandle(command.target);
    if (!resolved.ok) return resolved;
    if (resolved.handle.kind !== 'text-fragment')
      return { ok: false, error: '当前对象不是独立文字对象' };
    const selection = selectWorkspaceTargets([command.target]);
    if (!selection.ok) return selection;
    moveWorkspaceTextFragmentBy(resolved.handle, command.deltaX, command.deltaY, '移动文字对象');
  }
  if (command.action === 'move' || command.action === 'duplicate' || command.action === 'delete') {
    if (command.action !== 'delete' && command.target.textNodeIndex !== undefined)
      return {
        ok: false,
        error:
          command.action === 'move'
            ? '文字对象不支持结构上移或下移，未改变父容器'
            : '文字对象暂不支持复制，未改变父容器',
      };
    const resolved = resolveWorkspaceTargetHandle(command.target);
    if (!resolved.ok) return resolved;
    const element =
      resolved.handle.kind === 'text-fragment' ? resolved.handle.owner : resolved.handle.element;
    const selectedTextFragment =
      resolved.handle.kind === 'text-fragment' ? resolved.handle.fragment : null;
    selectElement(element, selectedTextFragment);
    if (command.target.textNodeIndex !== undefined) {
      if (command.action === 'delete') deleteSelected();
    } else {
      if (command.action === 'move') moveSelected(command.delta);
      if (command.action === 'duplicate') duplicateSelected();
      if (command.action === 'delete') deleteSelected();
    }
  }
  if (command.action === 'place') {
    if (
      command.target.textNodeIndex !== undefined ||
      command.destination.textNodeIndex !== undefined
    )
      return { ok: false, error: '文字对象不支持结构拖放，未改变父容器' };
    const source = resolveWorkspaceElementHandle(command.target);
    if (!source.ok) return source;
    const destination = resolveWorkspaceElementHandle(command.destination);
    if (!destination.ok) return destination;
    const element = source.handle.element;
    const destinationElement = destination.handle.element;
    if (!element || !destinationElement)
      return { ok: false, error: '拖动对象或目标位置已失效，请刷新后重试' };
    selectElement(element);
    placeSelected(element, destinationElement, command.position);
  }
  if (command.action === 'place-many') {
    if (
      !command.targets.length ||
      command.targets.some((target) => target.textNodeIndex !== undefined) ||
      command.destination.textNodeIndex !== undefined
    )
      return { ok: false, error: '文字对象不支持结构拖放，未改变父容器' };
    const elements: HTMLElement[] = [];
    for (const target of command.targets) {
      const resolved = resolveWorkspaceElementHandle(target);
      if (!resolved.ok) return resolved;
      elements.push(resolved.handle.element);
    }
    const destination = resolveWorkspaceElementHandle(command.destination);
    if (!destination.ok) return destination;
    placeSelectedMany(elements, destination.handle.element, command.position);
  }
  if (command.action === 'export-html') {
    const snapshot = await workspaceExportHtml(onProgress);
    return {
      ok: true,
      state: buildWorkspaceState(),
      html: snapshot.html,
      warnings: snapshot.warnings,
    };
  }
  return { ok: true, state: buildWorkspaceState() };
};

const openWorkspace = async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'workspace/open',
      mode: state.webCopyMode ? 'web-copy' : 'local-page',
    });
    setNotice(
      response?.ok
        ? '完整工作台已打开；所有确认修改会回写当前标签页并进入同一历史'
        : (response?.error ?? '完整工作台打开失败'),
    );
  } catch {
    setNotice('完整工作台打开失败，请重新加载扩展后重试');
  }
};

const onUiKeyDown = (event: KeyboardEvent) => {
  const toolbarHandle =
    event.target instanceof HTMLElement && event.target.closest('.dock-toolbar-drag-handle');
  if (toolbarHandle && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    moveToolbarByKeyboard(event.key);
    return;
  }
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  if (input?.dataset.dockText !== undefined && event.key === 'Enter') {
    event.preventDefault();
    input.blur();
  }
};

const createUi = () => {
  host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.dockExtensionHost = '';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .dock-ui { color:#26384e; font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
    .dock-panel { position:fixed; width:318px; max-height:calc(100vh - 120px); overflow:auto; pointer-events:auto; border:1px solid #cfdbe8; border-radius:12px; background:#fff; box-shadow:0 18px 44px rgba(27,55,87,.2); }
    .panel-header { display:flex; align-items:center; justify-content:space-between; min-height:42px; padding:0 12px; border-bottom:1px solid #e7edf3; cursor:grab; user-select:none; }
    .panel-header:active { cursor:grabbing; }
    .panel-header strong,.panel-header small,.selected-head strong,.selected-head small { display:block; }
    .panel-header strong { color:#203650; font-size:13px; }
    .panel-header small,.selected-head small { margin-top:2px; color:#8b9bad; font-size:10px; }
    .drag-dots { color:#aebccc; font-size:18px; letter-spacing:2px; }
    .panel-close { display:grid; width:25px; height:25px; margin-left:4px; padding:0; place-items:center; border:0; color:#7d8fa3; background:transparent; }
    .panel-close:hover { border-color:#c7dafa; background:#f1f6fc; color:#1e63c0; }
    .panel-close .dock-icon { width:14px; height:14px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.8; }
    .panel-content { padding:12px; }
    .selected-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding-bottom:9px; border-bottom:1px solid #edf1f5; }
    .selected-head strong { max-width:246px; overflow:hidden; color:#2a4768; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
    button { border:1px solid #d5e0eb; border-radius:6px; background:#fff; color:#5f748d; cursor:pointer; font:inherit; }
    button:hover { border-color:#a9c7f2; background:#f3f8ff; color:#1d62bd; }
    .selected-head button { width:25px; height:25px; border:0; font-size:18px; }
    .keyboard-hint { margin:7px 0 10px; color:#91a0b0; font-size:10px; text-align:right; }
    .web-copy-note { display:grid; gap:3px; margin:0 0 10px; padding:9px 10px; border:1px solid #b9d5f7; border-radius:7px; color:#1d5d9f; background:#edf6ff; }
    .web-copy-note strong { font-size:11px; }.web-copy-note span { font-size:9px; line-height:1.5; }
    .quick-tabs { display:grid; grid-template-columns:repeat(3,1fr); gap:2px; margin:0 -2px 10px; padding-bottom:6px; border-bottom:1px solid #e8eef4; }
    .quick-tab { min-height:28px; border:0; background:transparent; color:#72869e; }
    .quick-tab:hover { background:#f4f8fc; color:#285c9f; }
    .quick-tab.is-active { border-radius:6px; background:#e8f1ff; color:#1e63c0; font-weight:600; }
    .quick-tab:disabled { cursor:not-allowed; color:#b2bdc9; opacity:.72; }
    .dock-controls { min-height:160px; }
    .field-wide { grid-column:1 / -1; }
    .field { display:grid; gap:4px; margin:8px 0; }
    .field > span { color:#72869e; font-size:10px; }
    input,textarea { box-sizing:border-box; width:100%; min-height:28px; padding:5px 7px; border:1px solid #d3dfe9; border-radius:6px; background:#fff; color:#2b425d; font:inherit; }
    textarea { min-height:68px; resize:vertical; line-height:1.5; }
    input[type=color] { height:28px; padding:2px; }
    .range-control { display:flex; align-items:center; gap:8px; min-width:0; }
    .range-control input[type=range] { min-width:0; flex:1; padding:0; }
    .range-control output { min-width:36px; color:#5f7691; font:10px/1.2 "Cascadia Code",Consolas,monospace; text-align:right; }
    .style-grid { display:grid; grid-template-columns:1fr 1fr; gap:0 7px; }
    .object-actions { display:flex; gap:6px; margin:0 0 8px; }
    .object-actions button { display:grid; width:36px; height:30px; place-items:center; padding:0; }
    .object-actions svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.7; }
    .object-actions .object-action-danger { color:#b55b62; }
    .format-actions { display:grid; grid-template-columns:repeat(2,1fr); gap:6px; margin-top:8px; }
    .format-button { min-height:28px; }
    .format-button.is-active { border-color:#a9c7f2; background:#e8f1ff; color:#1e63c0; }
    .visibility-toggle { width:100%; min-height:30px; margin-top:8px; text-align:left; }
    .visibility-toggle span { float:right; color:#2b7de9; }
    .spacing-section { padding:8px 0; border-bottom:1px solid #edf1f5; }
    .spacing-section:last-of-type { border-bottom:0; }
    .control-section-label { display:block; margin-bottom:6px; color:#607991; font-size:11px; font-weight:600; }
    .alignment-row { display:grid; grid-template-columns:28px 1fr; align-items:center; gap:7px; margin:5px 0; }
    .alignment-row > span { color:#8a9bad; font-size:10px; }
    .alignment-buttons { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
    .alignment-button { min-height:28px; padding:0 4px; font-size:10px; }
    .alignment-button.is-active { border-color:#a9c7f2; background:#e8f1ff; color:#1e63c0; font-weight:600; }
    .box-value-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
    .box-value-grid .field { gap:3px; margin:0; }
    .box-value-grid .field > span { color:#8a9bad; font-size:10px; }
    .box-value-grid input { min-height:28px; padding:4px 5px; text-align:right; }
    .empty-state { padding:14px 2px 7px; }
    .empty-state strong { color:#385675; font-size:12px; }
    .empty-state p { margin:4px 0 0; color:#8999aa; font-size:11px; }
    .object-capability-note { margin-top:8px; padding:9px; border:1px solid #dce8f4; border-radius:7px; background:#f7fbff; }
    .object-capability-note strong { display:block; color:#385675; font-size:11px; }
    .object-capability-note p { margin:4px 0 0; color:#71869e; font-size:10px; line-height:1.5; }
    .object-capability-note--unstable { border-color:#ead9b7; background:#fffbf2; }
    .object-capability-note--unstable strong { color:#8b641c; }
    .history-popover { padding:10px; border:1px solid #dce7f1; border-radius:8px; background:#f9fbfd; }
    .dock-toolbar-history-anchor { position:relative; }
    .dock-history-popover { position:absolute; left:50%; bottom:calc(100% + 10px); z-index:55; width:300px; max-height:min(420px,calc(100vh - 96px)); margin:0; overflow:auto; transform:translateX(-50%); box-shadow:0 14px 30px rgba(25,56,94,.18); }
    .dock-history-popover .history-heading { position:sticky; top:0; z-index:1; margin:-2px -2px 0; padding:2px 2px 8px; background:#f9fbfd; }
    .history-heading,.history-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .history-heading { padding-bottom:6px; color:#48647f; }
    .history-heading span,.history-row small { color:#8a9aac; font-size:10px; }
    .history-row { padding:7px 0; border-top:1px solid #e7eef5; }
    .history-row strong,.history-row small { display:block; }
    .history-row strong { color:#496580; font-size:10px; }
    .history-row button { padding:3px 6px; font-size:9px; }
    .history-cancel { border-color:transparent; background:transparent; color:#7b8da2; }
    .history-cancel:hover { border-color:#c7dafa; background:#fff; color:#1e63c0; }
    .history-row em { color:#a4afbb; font-size:9px; font-style:normal; }
    .history-row.is-cancelled { opacity:.7; }
    .history-empty { margin:4px 0 0; color:#91a0b0; font-size:10px; }
    .dock-toolbar { position:fixed; left:50%; bottom:18px; display:flex; flex-wrap:nowrap; align-items:center; gap:2px; min-height:44px; padding:5px 6px; transform:translateX(-50%); pointer-events:auto; border:1px solid #cfdbe8; border-radius:10px; background:#fff; box-shadow:0 12px 28px rgba(25,56,94,.15); cursor:grab; touch-action:none; }
    .dock-toolbar.is-dragging { cursor:grabbing; user-select:none; }
    .dock-toolbar-drag-handle { width:24px !important; min-height:32px !important; margin-right:1px; border:0 !important; color:#91a4b8 !important; cursor:grab !important; }
    .dock-toolbar.is-dragging .dock-toolbar-drag-handle { cursor:grabbing !important; }
    .dock-toolbar-drag-handle:hover:not(:disabled) { background:#f3f7fc !important; color:#527aa8 !important; }
    .dock-toolbar-drag-handle .drag-grip { display:grid; width:9px; height:15px; grid-template-columns:repeat(2,3px); grid-template-rows:repeat(3,3px); gap:2px 3px; place-content:center; }
    .dock-toolbar-drag-handle .drag-grip i { width:3px; height:3px; border-radius:50%; background:currentColor; }
    .dock-toolbar-group { display:flex; align-items:center; gap:2px; }
    .dock-toolbar button { display:grid; box-sizing:border-box; width:34px; min-height:32px; place-items:center; padding:0; border:1px solid transparent; border-radius:7px; background:transparent; color:#647b95; cursor:pointer; font:inherit; }
    .dock-toolbar button:hover:not(:disabled) { border-color:#d4e2f2; background:#f3f7fc; color:#1e63c0; }
    .dock-toolbar button:focus-visible { border-color:#8fb3e5; outline:2px solid rgba(47,113,204,.2); outline-offset:1px; }
    .dock-toolbar button:disabled { cursor:not-allowed; opacity:.42; }
    .dock-toolbar-button { position:relative; }
    .dock-toolbar-button .toolbar-icon { display:inline-grid; place-items:center; color:currentColor; }
    .dock-toolbar-button .toolbar-icon .dock-icon { width:16px; height:16px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.8; }
    .dock-toolbar-button--history { width:43px !important; padding:0 3px !important; }
    .dock-toolbar-button--prompt { border-color:#c7dafa !important; background:#f3f7ff !important; color:#275fae !important; }
    .dock-toolbar-button--prompt:hover:not(:disabled) { border-color:#8fb3e5 !important; background:#e8f1ff !important; }
    .dock-toolbar-button--workspace { width:37px !important; border-color:#c7dafa !important; background:#eef5ff !important; color:#1f6fd1 !important; }
    .dock-toolbar-button--workspace:hover:not(:disabled) { border-color:#8fb3e5 !important; background:#e2efff !important; }
    .dock-toolbar-button--workspace .toolbar-icon { color:#2675dc; }
    .dock-capability-button { color:#647b95; }
    .dock-capability-button--checking { color:#8798aa; }
    .dock-capability-button--editable-exportable { color:#1d6fd1; }
    .dock-capability-button--editable-only,.dock-capability-button--exportable-only { color:#637b95; }
    .dock-capability-button--preview-only { color:#9aa7b4; }
    .dock-toolbar-button .toolbar-count { position:absolute; top:3px; right:3px; display:grid; min-width:16px; height:16px; padding:0 3px; place-items:center; box-sizing:border-box; border-radius:5px; background:#eaf2ff; color:#1e66c2; font-size:9px; line-height:1; }
    .dock-toolbar-divider { width:1px; height:20px; margin:0 3px; background:#e1e9f1; }
    .dock-toolbar-menu-anchor { position:relative; }
    .dock-toolbar-button.is-active { border-color:#c7dafa; background:#eef5ff; color:#1e63c0; }
    .dock-toolbar-button .toolbar-caret { display:inline-grid; position:absolute; right:5px; bottom:5px; place-items:center; color:#8a9bad; }
    .dock-toolbar-button .toolbar-caret .dock-icon { width:10px; height:10px; stroke-width:2; }
    .dock-toolbar-button[data-tooltip]::after { position:absolute; bottom:calc(100% + 9px); left:50%; z-index:60; padding:5px 7px; transform:translate(-50%,3px); pointer-events:none; border:1px solid #2b405c; border-radius:5px; background:#243a56; color:#fff; content:attr(data-tooltip); font-size:10px; font-weight:600; line-height:1; opacity:0; transition:opacity 120ms ease,transform 120ms ease; white-space:nowrap; }
    .dock-toolbar-button[data-tooltip]::before { position:absolute; bottom:calc(100% + 4px); left:50%; z-index:61; width:6px; height:6px; transform:translate(-50%,3px) rotate(45deg); pointer-events:none; border-right:1px solid #2b405c; border-bottom:1px solid #2b405c; background:#243a56; content:""; opacity:0; transition:opacity 120ms ease,transform 120ms ease; }
    .dock-toolbar-button[data-tooltip]:hover::after,.dock-toolbar-button[data-tooltip]:hover::before,.dock-toolbar-button[data-tooltip]:focus-visible::after,.dock-toolbar-button[data-tooltip]:focus-visible::before { transform:translate(-50%,0); opacity:1; }
    .dock-toolbar-popover { position:absolute; right:-1px; bottom:calc(100% + 10px); z-index:50; display:grid; width:214px; padding:5px; border:1px solid #cfdbe8; border-radius:9px; background:#fff; box-shadow:0 14px 30px rgba(25,56,94,.18); }
    .dock-popover-title { padding:5px 8px 4px; color:#8a9bad; font-size:9px; font-weight:750; letter-spacing:.04em; }
    .dock-toolbar-popover button { display:grid; grid-template-columns:20px minmax(0,1fr); gap:2px 7px; width:100%; min-height:44px; padding:7px 8px; border:0; border-radius:7px; background:transparent; color:#35516f; text-align:left; }
    .dock-toolbar-popover button:hover,.dock-toolbar-popover button:focus-visible { border-color:transparent; background:#f3f7fc; outline:none; }
    .dock-toolbar-popover button strong,.dock-toolbar-popover button small { display:block; }
    .dock-toolbar-popover button strong { font-size:10px; font-weight:750; }
    .dock-toolbar-popover button small { margin-top:2px; color:#8a9bad; font-size:9px; line-height:1.2; }
    .dock-toolbar-popover .popover-icon { display:grid; width:20px; height:20px; place-items:center; border-radius:5px; background:#eef5ff; color:#2675dc; }
    .dock-toolbar-popover .popover-icon .dock-icon { width:13px; height:13px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.8; }

    /* Approved Dock inspector direction: spacious controls, explicit hierarchy, one blue accent. */
    .dock-ui { color:#172b45; font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
    .dock-panel { width:min(456px,calc(100vw - 24px)); height:min(860px,calc(100dvh - 40px)); max-height:calc(100dvh - 24px); overflow:auto; border-color:#d5e1ee; border-radius:16px; box-shadow:0 20px 56px rgba(40,71,110,.18); }
    .panel-header { position:sticky; top:0; z-index:5; min-height:76px; padding:0 22px; border-bottom-color:#dfe7f0; background:rgba(255,255,255,.97); backdrop-filter:blur(12px); }
    .panel-brand,.panel-header-actions { display:flex; align-items:center; }
    .panel-brand { gap:13px; min-width:0; }
    .panel-brand > div { min-width:0; }
    .panel-brand-mark,.selected-mark { display:grid; flex:0 0 auto; place-items:center; border:1px solid #d9e5f2; border-radius:9px; background:#f7faff; color:#1267e9; }
    .panel-brand-mark { width:34px; height:34px; }
    .panel-brand-mark .dock-icon { width:20px; height:20px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.8; }
    .panel-brand-mark .dock-brand-image { display:block; width:27px; height:27px; object-fit:contain; }
    .panel-header strong { color:#132640; font-size:20px; font-weight:750; letter-spacing:-.01em; }
    .panel-header small { margin-top:1px; color:#71839a; font-size:13px; }
    .panel-header-actions { gap:10px; }
    .drag-dots { display:grid; width:21px; height:21px; grid-template-columns:repeat(3,3px); grid-auto-rows:3px; gap:3px; place-content:center; color:transparent; font-size:0; letter-spacing:0; }
    .drag-dots i { width:3px; height:3px; border-radius:50%; background:#8092aa; }
    .panel-close { width:34px; height:34px; margin-left:0; border-radius:8px; }
    .panel-close .dock-icon { width:18px; height:18px; }
    .panel-content { padding:22px; }
    .selected-head { display:grid; grid-template-columns:42px minmax(0,1fr) auto 30px; gap:12px; padding-bottom:18px; }
    .selected-mark { width:40px; height:40px; color:#263f5f; font:24px/1 Georgia,"Times New Roman",serif; }
    .selected-mark .dock-icon { width:20px; height:20px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.8; }
    .selected-head > div { min-width:0; }
    .selected-head strong { max-width:none; color:#172b45; font-size:18px; font-weight:750; }
    .selected-head small { color:#7186a0; font-size:13px; }
    .selected-status { padding:5px 8px; border:1px solid #82b3ff; border-radius:7px; color:#1267e9; font-size:12px; font-weight:700; white-space:nowrap; }
    .selected-status--whole-object,.selected-status--style-only { border-color:#c9d8e8; color:#526d89; }
    .selected-status--unstable { border-color:#e7c98f; color:#8b641c; }
    .selected-head button { width:30px; height:30px; font-size:20px; }
    .object-toolbar { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:16px 0; }
    .object-actions { gap:10px; margin:0; }
    .object-actions button { width:54px; height:42px; border-color:#d7e2ee; border-radius:8px; }
    .object-actions svg { width:20px; height:20px; }
    .object-actions .object-action-danger { margin-left:4px; color:#d3423d; }
    .keyboard-hint { margin:0; color:#6e84a0; font-size:12px; white-space:nowrap; }
    .quick-tabs { min-height:50px; gap:0; margin:0 0 20px; padding:0; overflow:hidden; border:1px solid #d5e1ee; border-radius:9px; }
    .quick-tab { min-height:50px; border-radius:0; color:#415875; font-size:15px; }
    .quick-tab + .quick-tab { border-left:1px solid #edf1f6; }
    .quick-tab:hover { background:#f7faff; }
    .quick-tab.is-active { border-radius:0; background:#f8fbff; color:#0968f0; font-weight:700; box-shadow:inset 0 -3px 0 #0b72ff; }
    .dock-controls { min-height:0; }
    .field { gap:7px; margin:12px 0; }
    .field > span,.control-section-label { color:#223b5b; font-size:14px; font-weight:650; }
    input,textarea,select { box-sizing:border-box; width:100%; min-height:42px; padding:9px 11px; border:1px solid #d4e0ec; border-radius:7px; background:#fff; color:#213650; font:inherit; outline:none; }
    input:focus,textarea:focus,select:focus { border-color:#74aaf6; box-shadow:0 0 0 3px rgba(44,119,224,.12); }
    textarea { min-height:104px; resize:vertical; line-height:1.55; }
    .style-grid { gap:0 12px; }
    .color-control { display:flex; min-height:42px; align-items:center; gap:10px; padding:3px 10px 3px 3px; border:1px solid #d4e0ec; border-radius:7px; background:#fff; }
    .color-control input[type=color] { width:54px; height:34px; min-height:34px; padding:2px; border:0; border-radius:5px; box-shadow:none; }
    .color-control code { color:#435976; font:13px/1.2 "Cascadia Code",Consolas,monospace; }
    .range-control { gap:10px; min-height:42px; }
    .range-control input[type=range] { min-height:32px; padding:0; border:0; box-shadow:none; accent-color:#0b72ff; }
    .range-control output { display:grid; min-width:54px; height:40px; place-items:center; border:1px solid #d4e0ec; border-radius:7px; color:#314b69; background:#fff; font-size:13px; text-align:center; }
    .format-actions { gap:10px; margin-top:14px; }
    .format-button { min-height:42px; color:#314b69; font-size:14px; }
    .format-button.is-active { border-color:#8eb7f3; background:#eef5ff; color:#0b67df; }
    .dock-appearance-controls > .style-grid { gap:12px; }
    .dock-appearance-controls > .style-grid .field { margin:0; padding:13px; border:1px solid #dce5ef; border-radius:9px; background:#fff; }
    .dock-appearance-controls > .field-wide { margin-top:12px; }
    .visibility-toggle { min-height:44px; margin-top:14px; padding:0 12px; color:#2e4867; font-size:14px; }
    .spacing-section { padding:14px 0; }
    .control-section-label { margin-bottom:10px; }
    .alignment-row { grid-template-columns:48px 1fr; gap:10px; margin:9px 0; }
    .alignment-row > span,.box-value-grid .field > span { color:#687f9b; font-size:13px; }
    .alignment-buttons { gap:0; }
    .alignment-button { min-height:42px; border-radius:0; font-size:13px; }
    .alignment-button:first-child { border-radius:7px 0 0 7px; }
    .alignment-button:last-child { border-radius:0 7px 7px 0; }
    .alignment-button + .alignment-button { border-left:0; }
    .box-value-grid { gap:10px; }
    .box-value-grid input { min-height:42px; padding:8px; }
    .dock-tab-note { margin:14px 0 0; color:#6e84a0; font-size:13px; line-height:1.55; }
    .empty-state { padding:24px 4px 18px; }
    .empty-state strong { font-size:16px; }
    .empty-state p { margin-top:6px; font-size:13px; }
    .dock-toolbar { min-height:58px; padding:6px; gap:2px; border-color:#c9dcf4; border-radius:13px; background:rgba(255,255,255,.97); box-shadow:0 14px 34px rgba(37,71,112,.17); backdrop-filter:blur(12px); }
    .dock-toolbar-group { gap:2px; }
    .dock-toolbar button { width:34px; min-height:40px; border-radius:9px; }
    .dock-toolbar button:active:not(:disabled) { transform:translateY(1px); }
    .dock-capability-button { width:34px; color:#1267e9; }
    .dock-capability-button--editable-exportable { border-color:transparent; background:transparent; }
    .dock-toolbar-button .toolbar-icon .dock-icon { width:18px; height:18px; }
    .dock-toolbar-button--history { width:43px !important; }
    .dock-toolbar-button--prompt,.dock-toolbar-button--workspace { border-color:#bfd6f7 !important; background:#eef5ff !important; color:#1267e9 !important; }
    .dock-toolbar-button--workspace { width:37px !important; }
    .dock-toolbar-button .toolbar-count { top:4px; right:3px; min-width:17px; height:17px; font-size:10px; }
    .dock-toolbar-divider { height:24px; margin:0 2px; background:#dce6f0; }
    .dock-history-popover { width:330px; }
    @media (max-width:600px) {
      .dock-panel { width:calc(100vw - 24px); height:auto; max-height:calc(100dvh - 92px); }
      .panel-content { padding:16px; }
      .selected-head { grid-template-columns:40px minmax(0,1fr) 28px; }
      .selected-status { display:none; }
      .object-toolbar { align-items:flex-start; flex-direction:column; }
      .dock-toolbar { bottom:12px; max-width:calc(100vw - 24px); }
    }

    /* Compact inspector refinement: semantic hierarchy, progressive disclosure, fewer frames. */
    .dock-ui { color:#1b2d43; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
    .dock-panel {
      width:min(420px,calc(100vw - 24px));
      height:auto;
      max-height:calc(100dvh - 88px);
      overflow:auto;
      border-color:#d7e0e9;
      border-radius:14px;
      background:#fbfcfe;
      box-shadow:0 22px 54px rgba(27,52,82,.16),0 2px 8px rgba(27,52,82,.08);
      scrollbar-width:thin;
      scrollbar-color:#c7d3df transparent;
    }
    .panel-header { min-height:64px; padding:0 18px; background:rgba(251,252,254,.96); }
    .panel-brand { gap:11px; }
    .panel-brand-mark {
      width:32px;
      height:32px;
      border:1px solid #d9e5f2;
      border-radius:8px;
      background:#f7faff;
      color:#1267e9;
      box-shadow:none;
    }
    .panel-brand-mark .dock-icon { width:19px; height:19px; stroke-width:1.65; }
    .panel-brand-mark .dock-brand-image { width:25px; height:25px; }
    .panel-header strong { font-size:18px; font-weight:720; letter-spacing:-.015em; }
    .panel-header small { color:#718095; font-size:12px; }
    .panel-header-actions { gap:7px; }
    .panel-close { width:30px; height:30px; }
    .panel-content { padding:16px 18px 18px; }
    .selected-head {
      grid-template-columns:36px minmax(0,1fr) auto 26px;
      gap:10px;
      padding:2px 0 14px;
      border-bottom:1px solid #e6ebf0;
    }
    .selected-mark { width:34px; height:34px; border-radius:8px; font-size:19px; background:#f2f6fb; }
    .selected-mark .dock-icon { width:17px; height:17px; }
    .selected-head strong { font-size:15px; font-weight:700; letter-spacing:-.01em; }
    .selected-head small { margin-top:1px; font-size:11px; }
    .selected-status { padding:3px 7px; border:0; border-radius:5px; background:#eaf3ff; font-size:11px; }
    .selected-status--whole-object,.selected-status--style-only { background:#edf2f7; }
    .selected-status--unstable { background:#fff5e3; }
    .selected-head button { width:26px; height:26px; font-size:18px; }
    .object-toolbar { gap:12px; padding:12px 0 14px; }
    .object-actions { gap:6px; }
    .object-actions button { width:40px; height:34px; border-color:transparent; border-radius:7px; background:#f1f4f8; }
    .object-actions button:hover { border-color:transparent; background:#e6edf5; }
    .object-actions .object-action-danger { margin-left:5px; background:transparent; }
    .object-actions .object-action-danger:hover { background:#fff0ef; color:#c73531; }
    .object-actions svg { width:17px; height:17px; stroke-width:1.65; }
    .keyboard-hint { color:#8290a2; font-size:11px; }
    .quick-tabs { min-height:40px; margin:0 0 16px; border:0; border-radius:8px; background:#eef2f6; }
    .quick-tab { min-height:40px; color:#53657a; font-size:13px; }
    .quick-tab + .quick-tab { border-left:0; }
    .quick-tab:hover { background:#e7edf4; color:#2a527e; }
    .quick-tab.is-active { margin:3px; border-radius:6px; background:#fff; color:#0b65d8; box-shadow:0 1px 4px rgba(38,63,91,.12); }
    .quick-tab.is-active + .quick-tab { margin-left:0; }
    .field { gap:6px; margin:10px 0; }
    .field > span,.control-section-label { color:#31465e; font-size:12px; font-weight:650; }
    input,textarea,select { min-height:38px; padding:8px 10px; border-color:#d8e0e8; border-radius:7px; background:#fff; font-size:13px; }
    textarea { min-height:76px; resize:vertical; }
    .field-content { margin-top:0; }
    .style-grid { gap:0 10px; }
    .style-grid--primary { margin-top:2px; }
    .color-control { min-height:38px; gap:9px; padding:3px 8px 3px 3px; border-color:#d8e0e8; }
    .color-control input[type=color] { width:44px; height:30px; min-height:30px; }
    .color-control code { font-size:11px; }
    .range-control { min-height:38px; }
    .range-control output { min-width:49px; height:36px; border-color:#d8e0e8; font-size:12px; }
    .property-section { padding:2px 0 12px; }
    .property-section > .control-section-label { display:block; margin-bottom:3px; }
    .property-section--secondary { margin-top:8px; padding-top:12px; border-top:1px solid #e6ebf0; }
    .format-actions { gap:6px; margin-top:8px; }
    .format-button { min-height:36px; border-color:transparent; background:#f1f4f8; font-size:12px; }
    .format-button:hover { border-color:transparent; background:#e8eef5; }
    .format-button.is-active { border-color:transparent; background:#e7f1ff; }
    .dock-appearance-controls > .style-grid,.dock-appearance-controls > .property-section .style-grid { gap:10px; }
    .dock-appearance-controls > .style-grid .field,.dock-appearance-controls > .property-section .field { margin:8px 0 0; padding:0; border:0; background:transparent; }
    .dock-appearance-controls > .field-wide { margin-top:8px; }
    .visibility-toggle { display:flex; align-items:center; justify-content:space-between; min-height:40px; margin-top:12px; padding:0 4px; border:0; background:transparent; color:#30465f; }
    .visibility-toggle:hover { border:0; background:transparent; }
    .visibility-toggle i { position:relative; width:30px; height:18px; border-radius:10px; background:#0b6ff2; }
    .visibility-toggle i::after { position:absolute; top:3px; right:3px; width:12px; height:12px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(16,39,67,.25); content:""; }
    .visibility-section .section-heading { margin-bottom:8px; }
    .visibility-toggle { display:flex; align-items:center; gap:10px; min-height:48px; margin-top:0; padding:7px 9px; border:1px solid #d8e1ea; border-radius:8px; background:#fff; text-align:left; }
    .visibility-toggle:hover { border-color:#b8cbe0; background:#f8fbff; }
    .visibility-copy { display:grid; min-width:0; flex:1; gap:2px; float:none!important; }
    .visibility-copy strong { overflow:hidden; color:#30465f; font-size:12px; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
    .visibility-copy small { color:#8593a3; font-size:10px; line-height:1.35; }
    .visibility-toggle b { flex:0 0 auto; color:#2b7de9; font-size:10px; font-weight:650; }
    .visibility-toggle:not(.is-active) b { color:#8795a5; }
    .visibility-toggle:not(.is-active) i { background:#aebdca; }
    .visibility-toggle:not(.is-active) i::after { right:auto; left:3px; }
    .delete-confirm { display:grid; gap:10px; margin:0 0 14px; padding:11px; border:1px solid #efc4c1; border-radius:9px; background:#fff7f6; }
    .delete-confirm-copy { display:grid; gap:3px; }
    .delete-confirm-copy strong { color:#963b38; font-size:12px; }
    .delete-confirm-copy span,.delete-confirm-copy small { color:#7d6666; font-size:10px; line-height:1.45; }
    .delete-confirm-copy small { color:#9d8585; }
    .delete-confirm-actions { display:flex; justify-content:flex-end; gap:7px; }
    .delete-confirm-actions button { min-height:30px; padding:0 10px; font-size:11px; }
    .delete-confirm-primary { border-color:#d45851; color:#fff; background:#c7443e; }
    .delete-confirm-primary:hover { border-color:#b63a35; color:#fff; background:#b63a35; }
    .box-model-editor { display:grid; gap:10px; margin-top:4px; }
    .spacing-section { border:0; border-radius:9px; }
    .spacing-section--alignment { padding:2px 0 13px; border-bottom:1px solid #e6ebf0; border-radius:0; }
    .spacing-section--margin { padding:11px; background:#f7f2e9; box-shadow:inset 0 0 0 1px #eee2cf; }
    .spacing-section--padding { padding:11px; background:#edf5f8; box-shadow:inset 0 0 0 1px #d9e9ef; }
    .section-heading { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:7px; }
    .section-heading .control-section-label { margin:0; }
    .section-heading small { color:#8795a6; font-size:10px; }
    .alignment-row { grid-template-columns:38px 1fr; gap:8px; margin:7px 0; }
    .alignment-row > span,.box-value-grid .field > span { font-size:11px; }
    .alignment-button { min-height:36px; border-color:#d8e0e8; font-size:12px; }
    .box-value-grid { gap:7px; }
    .box-value-grid input { min-height:34px; padding:6px; font-variant-numeric:tabular-nums; }
    .dock-tab-note { margin:10px 0 0; color:#7d8da1; font-size:11px; }
    .dock-toolbar {
      box-sizing:border-box;
      height:48px;
      min-height:0;
      padding:4px;
      gap:1px;
      border-color:#d4dee8;
      border-radius:14px;
      background:rgba(252,253,255,.96);
      box-shadow:0 14px 32px rgba(29,52,78,.15),0 2px 8px rgba(29,52,78,.07);
    }
    .dock-toolbar-group { gap:1px; }
    .dock-toolbar button { width:34px; min-height:34px; border-radius:7px; color:#52677f; }
    .dock-toolbar button:hover:not(:disabled) { border-color:transparent; background:#edf2f7; color:#0b65d8; }
    .dock-toolbar-button .toolbar-icon .dock-icon { width:17px; height:17px; stroke-width:1.75; }
    .dock-icon-fill { fill:currentColor; stroke:none; }
    .dock-toolbar-button--history { width:39px !important; }
    .dock-toolbar-button--workspace { width:36px !important; border:0 !important; background:#0b6ff2 !important; color:#fff !important; box-shadow:0 4px 10px rgba(11,111,242,.22); }
    .dock-toolbar-button--workspace:hover:not(:disabled) { background:#075fcf !important; color:#fff !important; }
    .dock-toolbar-button--workspace .toolbar-icon { color:inherit; }
    .dock-capability-button { width:36px; }
    .dock-toolbar-button .toolbar-count { top:2px; right:1px; min-width:15px; height:15px; border:2px solid #fcfdff; border-radius:7px; background:#0b6ff2; color:#fff; font-size:8px; }
    .dock-toolbar-divider { height:18px; margin:0 3px; background:#dce3ea; }
    .dock-toolbar-button .toolbar-caret { right:4px; bottom:4px; }
    .dock-toolbar-popover { border-color:#d7e0e9; border-radius:10px; box-shadow:0 16px 36px rgba(27,52,82,.16); }
    @media (max-width:600px) {
      .dock-panel { width:calc(100vw - 24px); max-height:calc(100dvh - 80px); }
      .panel-content { padding:14px; }
      .selected-head { grid-template-columns:34px minmax(0,1fr) 26px; }
      .style-grid { grid-template-columns:1fr; }
      .keyboard-hint { display:none; }
      .object-toolbar { align-items:center; flex-direction:row; }
    }
    @media (prefers-reduced-motion:reduce) {
      .dock-ui *, .dock-ui *::before, .dock-ui *::after { scroll-behavior:auto !important; transition-duration:.01ms !important; }
    }
    .sr-status,.toolbar-file-input { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); clip-path:inset(50%); border:0; white-space:nowrap; }
    .selection-box { position:fixed; display:none; box-sizing:border-box; pointer-events:none; border:2px solid #2675dc; background:rgba(38,117,220,.08); }
  `;
  ui = document.createElement('div');
  ui.className = 'dock-ui';
  panel = document.createElement('div');
  panel.className = 'dock-panel';
  selectionBox = document.createElement('div');
  selectionBox.className = 'selection-box';
  const toolbar = document.createElement('nav');
  toolbar.className = 'dock-toolbar';
  toolbar.setAttribute('aria-label', '点睛工具');
  toolbar.innerHTML = `<button type="button" class="dock-toolbar-drag-handle" data-action="dock-toolbar-drag" aria-label="调整 Dock 工具栏位置" data-tooltip="拖动调整位置"><span class="drag-grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span></button><div class="dock-toolbar-group dock-toolbar-group--status">${capabilityButton()}</div><span class="dock-toolbar-divider"></span><div class="dock-toolbar-group"><button class="dock-toolbar-button dock-toolbar-icon-button" data-action="undo" disabled data-tooltip="撤销" aria-label="撤销"><span class="toolbar-icon">${dockIcon('undo')}</span></button><button class="dock-toolbar-button dock-toolbar-icon-button" data-action="redo" disabled data-tooltip="重做" aria-label="重做"><span class="toolbar-icon">${dockIcon('redo')}</span></button><div class="dock-toolbar-menu-anchor dock-toolbar-history-anchor"><button class="dock-toolbar-button dock-toolbar-icon-button dock-toolbar-button--history" data-action="history" data-tooltip="修改记录" aria-label="修改记录"><span class="toolbar-icon">${dockIcon('history')}</span><span class="toolbar-count history-count">0</span></button></div></div><span class="dock-toolbar-divider"></span><div class="dock-toolbar-group"><div class="dock-toolbar-menu-anchor"><button class="dock-toolbar-button dock-toolbar-icon-button" data-action="dock-file-menu" data-tooltip="文件" aria-label="文件操作" aria-expanded="false"><span class="toolbar-icon">${dockIcon('file')}</span><span class="toolbar-caret">${dockIcon('chevron')}</span></button></div><button class="dock-toolbar-button dock-toolbar-icon-button" data-action="copy-prompt" data-tooltip="复制 AI 提示词" aria-label="复制 AI 提示词"><span class="toolbar-icon">${dockIcon('prompt')}</span></button></div><span class="dock-toolbar-divider"></span><button class="dock-toolbar-button dock-toolbar-icon-button dock-toolbar-button--workspace" data-action="dock-enter-workspace" data-tooltip="进入完整工作台" aria-label="进入完整工作台"><span class="toolbar-icon">${dockIcon('workspace')}</span></button>`;
  const fileInput = document.createElement('input');
  fileInput.className = 'toolbar-file-input';
  fileInput.type = 'file';
  fileInput.accept = '.html,.htm,text/html';
  fileInput.setAttribute('aria-label', '选择 HTML 文件');
  ui.append(panel, toolbar, fileInput);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.html') && !lowerName.endsWith('.htm')) {
      setNotice('只支持打开 .html 或 .htm 文件');
    } else {
      setNotice(`已选择“${file.name}”；Dock 当前通过导出生成静态副本，不直接写回磁盘`);
    }
    fileInput.value = '';
  });
  shadow.append(style, selectionBox, ui);
  document.documentElement.append(host);
  bindToolbarDrag(toolbar);
  ui.addEventListener('click', onUiClick);
  ui.addEventListener('keydown', onUiKeyDown);
  render();
  window.setTimeout(() => {
    capability = detectCapability();
    render();
  }, 0);
};

const onToolbarClick = (event: Event) => {
  const target =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'dock-toolbar-drag') return;
  if (action === 'capability') {
    state.notice = `${capability.label}：${capability.description}`;
    render();
    return;
  }
  const toolbar = ui.querySelector<HTMLElement>('.dock-toolbar');
  if (action === 'undo') return undo();
  if (action === 'redo') return redo();
  if (action === 'history') {
    state.fileMenuOpen = false;
    toolbar?.querySelector('.dock-toolbar-popover')?.remove();
    state.historyOpen = !state.historyOpen;
    render();
    return;
  }
  if (action === 'dock-file-menu') {
    state.historyOpen = false;
    renderHistoryPopover();
    state.fileMenuOpen = !state.fileMenuOpen;
    const anchor = toolbar?.querySelector<HTMLElement>('.dock-toolbar-menu-anchor');
    const existingMenu = anchor?.querySelector('.dock-toolbar-popover');
    if (state.fileMenuOpen && anchor && !existingMenu)
      anchor.insertAdjacentHTML('beforeend', dockFileMenuMarkup());
    if (!state.fileMenuOpen) existingMenu?.remove();
    updateToolbar();
    return;
  }
  if (action === 'dock-open-html') {
    state.fileMenuOpen = false;
    toolbar?.querySelector('.dock-toolbar-popover')?.remove();
    updateToolbar();
    ui.querySelector<HTMLInputElement>('.toolbar-file-input')?.click();
    return;
  }
  if (action === 'open-html-export') {
    state.fileMenuOpen = false;
    toolbar?.querySelector('.dock-toolbar-popover')?.remove();
    updateToolbar();
    return exportHtml();
  }
  if (action === 'export-viewport-png') {
    state.fileMenuOpen = false;
    toolbar?.querySelector('.dock-toolbar-popover')?.remove();
    updateToolbar();
    return void exportViewportPng();
  }
  if (action === 'copy-prompt' || action === 'export-prompt') return exportPrompt();
  if (action === 'dock-enter-workspace') {
    state.fileMenuOpen = false;
    toolbar?.querySelector('.dock-toolbar-popover')?.remove();
    updateToolbar();
    void openWorkspace();
    return;
  }
};

function updateToolbar(): void {
  const toolbar = ui.querySelector<HTMLElement>('.dock-toolbar');
  if (!toolbar) return;
  const capabilityElement = toolbar.querySelector<HTMLButtonElement>('[data-action="capability"]');
  if (capabilityElement) {
    capabilityElement.className = `dock-toolbar-button dock-toolbar-icon-button dock-capability-button dock-capability-button--${capability.status}`;
    capabilityElement.setAttribute('aria-label', capability.label);
    capabilityElement.setAttribute(
      'data-tooltip',
      `${capability.label}：${capability.description}`,
    );
    capabilityElement.title = capability.label;
    capabilityElement.innerHTML = `<span class="toolbar-icon">${dockIcon(capabilityIcon(capability.status))}</span>`;
  }
  const undoButton = toolbar.querySelector<HTMLButtonElement>('[data-action="undo"]');
  const redoButton = toolbar.querySelector<HTMLButtonElement>('[data-action="redo"]');
  const historyCount = toolbar.querySelector<HTMLElement>('.toolbar-count');
  if (undoButton) undoButton.disabled = state.history.length === 0;
  if (redoButton) redoButton.disabled = state.future.length === 0;
  if (historyCount)
    historyCount.textContent = String(state.history.length + state.cancelled.length);
  const fileButton = toolbar.querySelector<HTMLButtonElement>('[data-action="dock-file-menu"]');
  if (fileButton) {
    fileButton.classList.toggle('is-active', state.fileMenuOpen);
    fileButton.setAttribute('aria-expanded', String(state.fileMenuOpen));
  }
}

const toggleDock = () => {
  state.active = !state.active;
  state.notice = state.active ? '已打开；点击页面元素开始直接编辑' : 'Dock 已暂停';
  render();
};

const exitDock = () => {
  state.active = false;
  state.fileMenuOpen = false;
  state.historyOpen = false;
  selected = null;
  selectedTextFragment = null;
  state.notice = 'Dock 已退出；点击浏览器插件图标可重新打开';
  render();
};

createUi();
ui.addEventListener('click', onToolbarClick);
document.addEventListener('click', onPageClick, true);
document.addEventListener('keydown', onKeyDown, true);
window.addEventListener('scroll', drawSelection, true);
window.addEventListener('resize', () => {
  drawSelection();
  applyPanelPosition();
  applyToolbarPosition();
});
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage)
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'dock/ping') {
      sendResponse({ ready: true });
      return;
    }
    if (message?.type === 'dock/toggle') {
      state.webCopyMode = message.mode === 'web-copy';
      toggleDock();
      sendResponse({ active: state.active });
      return;
    }
    if (message?.type === 'dock/capture-prepare') {
      void preparePageCapture().then(sendResponse);
      return true;
    }
    if (message?.type === 'dock/capture-scroll') {
      void scrollPageCapture(Number(message.top) || 0).then(sendResponse);
      return true;
    }
    if (message?.type === 'dock/capture-restore') {
      void restorePageCapture().then(sendResponse);
      return true;
    }
    if (message?.type === 'workspace/command') {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
      const reportProgress = (progress: WorkspaceExportProgress) => {
        if (!sessionId) return;
        void chrome.runtime
          .sendMessage({ type: 'workspace/export-progress', sessionId, progress })
          .catch(() => undefined);
      };
      void handleWorkspaceCommand(message.command as WorkspaceCommand, reportProgress)
        .then(sendResponse)
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : '工作台命令执行失败',
          }),
        );
      return true;
    }
  });

if (isWorkspaceCanvasSource) {
  host!.hidden = true;
  const bridgeWindow = window as typeof window & {
    __dianjingWorkspaceCommand?: typeof handleWorkspaceCommand;
  };
  bridgeWindow.__dianjingWorkspaceCommand = handleWorkspaceCommand;
}

if (document.documentElement.dataset.dianjingLocalPreview === 'true') toggleDock();
