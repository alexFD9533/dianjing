import { describe, expect, it } from 'vitest';
import type { WorkspaceElement } from '../shared/workspace-protocol';
import { buildObjectTreeRows, isEditTreeWrapper, objectTreePathFor } from './object-tree';

const makeElement = (id: string, overrides: Partial<WorkspaceElement> = {}): WorkspaceElement => ({
  id,
  target: { editId: id },
  hasChildren: false,
  childrenLoaded: true,
  depth: 0,
  tag: '#text',
  label: `文本 · ${id}`,
  role: '文本',
  text: id,
  capability: 'direct',
  styles: {},
  ...overrides,
});

const deepSingleBranch = () => [
  makeElement('root', {
    tag: 'main',
    label: '主内容区',
    hasChildren: true,
    depth: 0,
  }),
  makeElement('wrapper-1', {
    target: { editId: 'wrapper-1' },
    parentId: 'root',
    tag: 'div',
    label: '内容容器',
    role: '元素',
    capability: 'style-only',
    hasChildren: true,
    depth: 1,
  }),
  makeElement('wrapper-2', {
    target: { editId: 'wrapper-2' },
    parentId: 'wrapper-1',
    tag: 'span',
    label: '内容容器',
    role: '元素',
    capability: 'style-only',
    hasChildren: true,
    depth: 2,
  }),
  makeElement('wrapper-3', {
    target: { editId: 'wrapper-3' },
    parentId: 'wrapper-2',
    tag: 'div',
    label: '内容容器',
    role: '元素',
    capability: 'unstable',
    hasChildren: true,
    depth: 3,
  }),
  makeElement('leaf', {
    parentId: 'wrapper-3',
    depth: 4,
  }),
];

describe('edit object tree', () => {
  it('compresses a deep single wrapper branch and keeps the editable leaf', () => {
    const rows = buildObjectTreeRows(deepSingleBranch(), {
      mode: 'edit',
      expandedIds: new Set(['root', 'wrapper-1', 'wrapper-2', 'wrapper-3']),
    });

    expect(rows.map((row) => row.kind)).toEqual(['object', 'compression', 'object']);
    const compression = rows[1]!;
    expect(compression.kind).toBe('compression');
    if (compression.kind === 'compression') {
      expect(compression.count).toBe(3);
      expect(compression.hiddenIds).toEqual(['wrapper-1', 'wrapper-2', 'wrapper-3']);
      expect(compression.terminalId).toBe('leaf');
      expect('target' in compression).toBe(false);
    }
    expect(rows[2]?.kind === 'object' && rows[2].element.id).toBe('leaf');
    expect(rows[2]?.depth).toBe(2);
  });

  it('keeps separate branches and does not replace a single wrapper with a compression row', () => {
    const elements = [
      makeElement('root', {
        tag: 'main',
        label: '主内容区',
        hasChildren: true,
        depth: 0,
      }),
      makeElement('left-wrapper', {
        parentId: 'root',
        tag: 'div',
        label: '内容容器',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
        depth: 1,
      }),
      makeElement('left-leaf', { parentId: 'left-wrapper', depth: 2 }),
      makeElement('right-wrapper', {
        parentId: 'root',
        tag: 'div',
        label: '内容容器',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
        depth: 1,
      }),
      makeElement('right-leaf', { parentId: 'right-wrapper', depth: 2 }),
    ];
    const rows = buildObjectTreeRows(elements, {
      mode: 'edit',
      expandedIds: new Set(['root', 'left-wrapper', 'right-wrapper']),
    });

    expect(rows.filter((row) => row.kind === 'compression')).toHaveLength(0);
    expect(rows.filter((row) => row.kind === 'object').map((row) => row.element.id)).toEqual([
      'root',
      'left-wrapper',
      'left-leaf',
      'right-wrapper',
      'right-leaf',
    ]);
  });

  it('compresses named semantic layout containers in a single editing path', () => {
    const elements = [
      makeElement('root', {
        tag: 'div',
        label: '页面元素 · #root',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
      }),
      makeElement('content', {
        parentId: 'root',
        tag: 'section',
        label: '内容区',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
        depth: 1,
      }),
      makeElement('main', {
        parentId: 'content',
        tag: 'main',
        label: '主内容区',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
        depth: 2,
      }),
      makeElement('card', {
        parentId: 'main',
        tag: 'article',
        label: '内容卡片',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
        depth: 3,
      }),
      makeElement('leaf', { parentId: 'card', depth: 4 }),
    ];

    const rows = buildObjectTreeRows(elements, {
      mode: 'edit',
      expandedIds: new Set(['root', 'content', 'main', 'card']),
    });

    expect(rows.map((row) => row.kind)).toEqual(['object', 'compression', 'object']);
    expect(rows[1]?.kind === 'compression' && rows[1].hiddenIds).toEqual([
      'content',
      'main',
      'card',
    ]);
  });

  it('compresses top ancestors around a page-selected object even when ancestors branch', () => {
    const elements = [
      makeElement('root', {
        tag: 'div',
        label: '页面元素 · #root',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
      }),
      makeElement('top-path', {
        parentId: 'root',
        tag: 'section',
        label: '内容区',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
        depth: 1,
      }),
      makeElement('unrelated-top', { parentId: 'root', depth: 1 }),
      makeElement('parent', {
        parentId: 'top-path',
        tag: 'article',
        label: '内容卡片',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
        depth: 2,
      }),
      makeElement('unrelated-branch', { parentId: 'top-path', depth: 2 }),
      makeElement('selected', { parentId: 'parent', depth: 3 }),
    ];

    const rows = buildObjectTreeRows(elements, {
      mode: 'edit',
      expandedIds: new Set(['root', 'top-path', 'parent']),
      selectedIds: ['selected'],
    });

    expect(rows.map((row) => row.kind)).toEqual(['compression', 'object']);
    expect(rows[0]?.kind === 'compression' && rows[0].hiddenIds).toEqual([
      'root',
      'top-path',
      'parent',
    ]);
    expect(rows[0]?.kind === 'compression' && rows[0].key.startsWith('selected>')).toBe(true);
    expect(rows.filter((row) => row.kind === 'object').map((row) => row.element.id)).toEqual([
      'selected',
    ]);
    expect(rows.at(-1)?.depth).toBe(1);
  });

  it('keeps the selected object siblings at the same shallow editing level', () => {
    const elements = [
      makeElement('root', {
        tag: 'div',
        label: '页面元素 · #root',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
      }),
      makeElement('parent', {
        parentId: 'root',
        tag: 'section',
        label: '内容区',
        role: '元素',
        capability: 'style-only',
        hasChildren: true,
        depth: 1,
      }),
      makeElement('selected', { parentId: 'parent', depth: 2 }),
      makeElement('sibling', { parentId: 'parent', depth: 2 }),
    ];

    const rows = buildObjectTreeRows(elements, {
      mode: 'edit',
      expandedIds: new Set(['root', 'parent']),
      selectedIds: ['selected'],
    });

    expect(rows[0]?.kind === 'compression' && rows[0].count).toBe(2);
    expect(rows.filter((row) => row.kind === 'object').map((row) => row.element.id)).toEqual([
      'selected',
      'sibling',
    ]);
    expect(rows.filter((row) => row.kind === 'object').map((row) => row.depth)).toEqual([1, 1]);
  });

  it('shows every loaded real level in full structure mode', () => {
    const elements = deepSingleBranch();
    const rows = buildObjectTreeRows(elements, {
      mode: 'full',
      expandedIds: new Set(
        elements.filter((element) => element.hasChildren).map((element) => element.id),
      ),
    });

    expect(rows.every((row) => row.kind === 'object')).toBe(true);
    expect(rows.map((row) => row.kind === 'object' && row.element.id)).toEqual([
      'root',
      'wrapper-1',
      'wrapper-2',
      'wrapper-3',
      'leaf',
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 3, 4]);
  });

  it('promotes a selected wrapper without reopening its hidden top ancestors', () => {
    const rows = buildObjectTreeRows(deepSingleBranch(), {
      mode: 'edit',
      expandedIds: new Set(['root', 'wrapper-1', 'wrapper-2', 'wrapper-3']),
      selectedIds: ['wrapper-2'],
    });

    expect(rows.some((row) => row.kind === 'object' && row.element.id === 'wrapper-2')).toBe(true);
    expect(rows.some((row) => row.kind === 'object' && row.element.id === 'leaf')).toBe(true);
    expect(rows.some((row) => row.kind === 'compression' && !row.expanded)).toBe(true);
  });

  it('keeps roots and incomplete branches out of compression', () => {
    const semantic = makeElement('semantic', {
      tag: 'div',
      label: '数据卡片',
      role: '元素',
      capability: 'style-only',
      hasChildren: true,
    });
    const incomplete = makeElement('incomplete', {
      tag: 'div',
      label: '内容容器',
      role: '元素',
      capability: 'style-only',
      hasChildren: true,
      childrenLoaded: false,
    });

    expect(isEditTreeWrapper(semantic, 1)).toBe(false);
    expect(isEditTreeWrapper(incomplete, 1)).toBe(false);
  });

  it('returns the real ancestor path for the current selection', () => {
    const elements = deepSingleBranch();
    expect(objectTreePathFor(elements, 'leaf').map((element) => element.id)).toEqual([
      'root',
      'wrapper-1',
      'wrapper-2',
      'wrapper-3',
      'leaf',
    ]);
  });
});
