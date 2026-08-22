import { describe, expect, it } from 'vitest';
import { buildAiPromptPacket } from './ai-prompt';

const page = {
  url: 'http://127.0.0.1:4173/example.html#page=overview',
  title: '示例页面',
  scopeLabel: '第一张证据卡 · 左侧指标区',
  sourceMode: '当前页面',
  viewport: { width: 1912, height: 914 },
};

const pageWithoutScope = {
  ...page,
  scopeLabel: undefined,
};

const operation = (overrides: Partial<Parameters<typeof buildAiPromptPacket>[1][number]>) => ({
  id: 'operation',
  kind: 'style' as const,
  property: 'width',
  before: '100px',
  after: '120px',
  label: '调整宽度',
  targetLabel: '内容容器',
  target: { fallbackSelector: '#card' },
  createdAt: '2026-08-18T10:00:00.000Z',
  ...overrides,
});

describe('buildAiPromptPacket', () => {
  it('groups one element into one human-facing task while retaining property-level traceability', () => {
    const packet = buildAiPromptPacket(page, [
      operation({ id: 'width', property: 'width', before: '860px', after: '920px' }),
      operation({
        id: 'padding',
        property: 'padding-top',
        before: '0px',
        after: '12px',
        label: '调整上内边距',
        createdAt: '2026-08-18T10:00:01.000Z',
      }),
    ]);

    expect(packet.context.groupedOperations).toHaveLength(2);
    expect(packet.context.elementTasks).toHaveLength(1);
    expect(packet.context.elementTasks[0]?.changes).toHaveLength(2);
    expect(packet.prompt).toContain('最终效果（按页面对象归并）');
    expect(packet.prompt).toContain('ELEMENT-1 | 内容容器');
    expect(packet.prompt).toContain('width：当前值 "860px" -> "920px"');
    expect(packet.prompt).toContain('padding-top：当前值 "0px" -> "12px"');
    expect(packet.prompt).not.toContain('源码应达到');
    expect(packet.prompt).not.toContain('页面模式：');
  });

  it('merges repeated changes to the same property even when another property was edited between them', () => {
    const packet = buildAiPromptPacket(page, [
      operation({ id: 'width-1', before: '100px', after: '120px' }),
      operation({
        id: 'height',
        property: 'height',
        before: '40px',
        after: '48px',
        label: '调整高度',
        createdAt: '2026-08-18T10:00:01.000Z',
      }),
      operation({
        id: 'width-2',
        before: '120px',
        after: '140px',
        createdAt: '2026-08-18T10:00:02.000Z',
      }),
    ]);

    expect(packet.context.groupedOperations).toHaveLength(2);
    expect(packet.context.groupedOperations[0]).toMatchObject({
      before: '100px',
      after: '140px',
      processCount: 2,
    });
    expect(packet.context.elementTasks[0]?.changes).toHaveLength(2);
    expect(packet.prompt).toContain('累计记录 2 次，源码只需实现最终值');
    expect(packet.prompt).not.toContain('"120px" -> "140px"');
  });

  it('keeps separate semantic targets and direct text fragments separate', () => {
    const packet = buildAiPromptPacket(pageWithoutScope, [
      operation({
        id: 'semantic-a',
        target: undefined,
        targetLabel: '内容容器',
        semanticPath: '主内容区 > 左卡片 > 内容容器',
      }),
      operation({
        id: 'semantic-b',
        target: undefined,
        targetLabel: '内容容器',
        semanticPath: '主内容区 > 右卡片 > 内容容器',
        before: '200px',
        after: '220px',
      }),
      operation({
        id: 'text-a',
        kind: 'text',
        property: 'textContent',
        target: { editId: 'card' },
        targetLabel: '文本 · 标题',
        semanticPath: '主内容区 > 左卡片 > 文本 · 标题',
        textNodeIndex: 0,
        before: '左',
        after: '左一',
      }),
      operation({
        id: 'text-b',
        kind: 'text',
        property: 'textContent',
        target: { editId: 'card' },
        targetLabel: '文本 · 标题',
        semanticPath: '主内容区 > 左卡片 > 文本 · 标题',
        textNodeIndex: 1,
        before: '右',
        after: '右一',
      }),
    ]);

    expect(packet.context.groupedOperations).toHaveLength(4);
    expect(packet.context.elementTasks).toHaveLength(4);
    expect(packet.prompt).toContain('修改范围：主内容区');
  });

  it('keeps structure changes in chronological order', () => {
    const packet = buildAiPromptPacket(page, [
      {
        id: 'move-1',
        kind: 'structure',
        property: 'position',
        before: '3',
        after: '2',
        label: '部件上移',
        targetLabel: '文本 · 标题',
        target: { fallbackSelector: 'main > section:nth-of-type(2) h2' },
        createdAt: '2026-08-18T10:00:00.000Z',
      },
      {
        id: 'move-2',
        kind: 'structure',
        property: 'position',
        before: '2',
        after: '1',
        label: '部件上移',
        targetLabel: '文本 · 标题',
        target: { fallbackSelector: 'main > section:nth-of-type(2) h2' },
        createdAt: '2026-08-18T10:00:01.000Z',
      },
    ]);

    expect(packet.context.elementTasks).toHaveLength(0);
    expect(packet.context.structureOperations).toHaveLength(2);
    expect(packet.prompt).toContain('结构变更顺序（按原操作顺序）');
    expect(packet.prompt).toContain('结构动作：部件上移');
    expect(packet.prompt.indexOf('"3" -> "2"')).toBeLessThan(packet.prompt.indexOf('"2" -> "1"'));
  });

  it('marks computed before values without pretending an explicit source rule exists', () => {
    const packet = buildAiPromptPacket(page, [
      operation({
        id: 'computed-left',
        property: 'left',
        before: '0px',
        after: '-1px',
        beforeSource: 'computed',
      }),
    ]);

    expect(packet.prompt).toContain('left：当前计算值 "0px" -> "-1px"');
    expect(packet.prompt).toContain('当前计算值不等于源码中已有显式规则');
  });

  it('preserves meaningful text whitespace in the final state', () => {
    const packet = buildAiPromptPacket(page, [
      {
        id: 'text-whitespace',
        kind: 'text',
        property: 'textContent',
        before: ' 标题 ',
        after: ' 新标题 ',
        label: '修改文字',
        targetLabel: '文本 · 标题',
        target: { fallbackSelector: '#title' },
        createdAt: '2026-08-18T10:00:00.000Z',
      },
    ]);

    expect(packet.prompt).toContain('文案：当前值 " 标题 " -> " 新标题 "');
  });

  it('preserves meaningful line breaks and semantic target context', () => {
    const packet = buildAiPromptPacket(page, [
      {
        id: 'text-1',
        kind: 'text',
        property: 'textContent',
        before: '第一行',
        after: '第一行\n第二行',
        label: '修改文字',
        targetLabel: '文本 · 标题',
        semanticPath: '主内容区 > 第一张证据卡 > 文本 · 标题',
        target: { fallbackSelector: '#title' },
        textNodeIndex: 0,
        createdAt: '2026-08-18T10:00:00.000Z',
      },
    ]);

    expect(packet.prompt).toContain('语义位置：主内容区 > 第一张证据卡 > 文本 · 标题');
    expect(packet.prompt).toContain('文案：当前值 "第一行" -> "第一行\\n第二行"');
    expect(packet.prompt).toContain('直接文字片段');
  });

  it('omits cancelled and reverted changes from executable tasks', () => {
    const packet = buildAiPromptPacket(page, [
      operation({ id: 'cancelled', before: 'black', after: 'red', cancelled: true }),
      operation({ id: 'reverted', before: '100px', after: '100px' }),
    ]);

    expect(packet.hasChanges).toBe(false);
    expect(packet.context.operations).toHaveLength(1);
    expect(packet.context.elementTasks).toHaveLength(0);
    expect(packet.prompt).toContain('当前没有可同步的有效修改');
  });
});
