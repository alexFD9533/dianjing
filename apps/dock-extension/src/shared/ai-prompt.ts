export type PromptTarget = {
  editId?: string;
  fallbackSelector?: string;
};

export type PromptOperationKind = 'text' | 'style' | 'structure' | 'layout';

/** Describes where the before value came from in the live preview. */
export type PromptValueSource = 'inline' | 'computed' | 'observed' | 'unknown';

export type PromptOperationInput = {
  id: string;
  kind: PromptOperationKind;
  property: string;
  before: string;
  after: string;
  beforeSource?: PromptValueSource;
  label: string;
  targetLabel: string;
  semanticPath?: string;
  target?: PromptTarget;
  textNodeIndex?: number;
  createdAt: string;
  cancelled?: boolean;
};

export type PromptPageContext = {
  url: string;
  title: string;
  scopeLabel?: string;
  sourceMode?: string;
  viewport?: { width: number; height: number };
};

/** A final state for one property, retained for machine-readable traceability. */
export type PromptGroupedOperation = {
  taskId: string;
  kind: PromptOperationKind;
  property: string;
  label: string;
  targetLabel: string;
  semanticPath?: string;
  target?: PromptTarget;
  targetHint: string;
  before: string;
  after: string;
  beforeSource?: PromptValueSource;
  processCount: number;
  operationIds: string[];
  firstCreatedAt: string;
  lastCreatedAt: string;
  textNodeIndex?: number;
};

/** Human-facing task: one page object with all of its final changes together. */
export type PromptElementTask = {
  taskId: string;
  targetLabel: string;
  semanticPath?: string;
  target?: PromptTarget;
  targetHint: string;
  changes: PromptGroupedOperation[];
  processCount: number;
  operationIds: string[];
  firstCreatedAt: string;
  lastCreatedAt: string;
};

export type PromptContext = {
  version: 2;
  page: PromptPageContext;
  operations: PromptOperationInput[];
  /** Property-level final states for tracing and future machine consumers. */
  groupedOperations: PromptGroupedOperation[];
  /** Non-structural changes grouped by logical page object for the main prompt. */
  elementTasks: PromptElementTask[];
  /** Structure changes remain chronological because their order can affect the result. */
  structureOperations: PromptGroupedOperation[];
};

export type PromptPacket = {
  prompt: string;
  context: PromptContext;
  hasChanges: boolean;
};

const normalizeValue = (value: string | undefined) => (value ?? '').trim();

const quote = (value: string) => JSON.stringify(value ?? '');

const comparableValue = (kind: PromptOperationKind, value: string | undefined) =>
  kind === 'text' ? (value ?? '') : normalizeValue(value);

const targetKey = (
  target: PromptTarget | undefined,
  semanticPath: string | undefined,
  targetLabel: string,
  textNodeIndex?: number,
) => {
  const base = target?.editId
    ? `edit:${target.editId}`
    : target?.fallbackSelector
      ? `selector:${target.fallbackSelector}`
      : semanticPath
        ? `path:${semanticPath}`
        : `label:${targetLabel}`;
  return textNodeIndex === undefined ? base : `${base}::text:${textNodeIndex}`;
};

const operationTargetKey = (operation: PromptOperationInput) =>
  targetKey(
    operation.target,
    operation.semanticPath,
    operation.targetLabel,
    operation.textNodeIndex,
  );

const groupedTargetKey = (group: PromptGroupedOperation) =>
  targetKey(group.target, group.semanticPath, group.targetLabel, group.textNodeIndex);

const formatTargetHint = (operation: Pick<PromptOperationInput, 'target' | 'textNodeIndex'>) => {
  const selectors: string[] = [];
  if (operation.target?.editId) selectors.push(`[data-edit-id="${operation.target.editId}"]`);
  if (operation.target?.fallbackSelector)
    selectors.push(`候选选择器：${operation.target.fallbackSelector}`);
  const textFragment =
    operation.textNodeIndex === undefined ? '' : '；仅修改该元素的直接文字片段，保留其内部子元素';
  if (!selectors.length)
    return textFragment ? `未提供稳定选择器${textFragment}` : '未提供稳定选择器';
  return `${selectors.join('；')}${textFragment}`;
};

const canSquash = (operation: PromptOperationInput) =>
  operation.kind === 'text' || operation.kind === 'style' || operation.kind === 'layout';

const groupOperations = (operations: PromptOperationInput[]): PromptGroupedOperation[] => {
  const groups = new Map<string, PromptGroupedOperation>();
  const ordered: PromptGroupedOperation[] = [];

  for (const operation of operations) {
    if (operation.cancelled) continue;
    const key = canSquash(operation)
      ? `${operation.kind}:${operation.property}:${operationTargetKey(operation)}`
      : `structure:${operation.id}`;
    const existing = groups.get(key);
    if (!existing) {
      const group: PromptGroupedOperation = {
        taskId: `TASK-${ordered.length + 1}`,
        kind: operation.kind,
        property: operation.property,
        label: operation.label,
        targetLabel: operation.targetLabel,
        semanticPath: operation.semanticPath,
        target: operation.target,
        targetHint: formatTargetHint(operation),
        before: operation.before,
        after: operation.after,
        beforeSource: operation.beforeSource,
        processCount: 1,
        operationIds: [operation.id],
        firstCreatedAt: operation.createdAt,
        lastCreatedAt: operation.createdAt,
        textNodeIndex: operation.textNodeIndex,
      };
      groups.set(key, group);
      ordered.push(group);
      continue;
    }

    existing.after = operation.after;
    existing.lastCreatedAt = operation.createdAt;
    existing.processCount += 1;
    existing.operationIds.push(operation.id);
  }

  return ordered.filter(
    (group) =>
      comparableValue(group.kind, group.before) !== comparableValue(group.kind, group.after),
  );
};

const buildElementTasks = (groups: PromptGroupedOperation[]): PromptElementTask[] => {
  const tasks = new Map<string, PromptElementTask>();
  const ordered: PromptElementTask[] = [];

  for (const group of groups) {
    if (group.kind === 'structure') continue;
    const key = groupedTargetKey(group);
    const existing = tasks.get(key);
    if (existing) {
      existing.changes.push(group);
      existing.processCount += group.processCount;
      existing.operationIds.push(...group.operationIds);
      existing.lastCreatedAt = group.lastCreatedAt;
      continue;
    }

    const task: PromptElementTask = {
      taskId: `ELEMENT-${ordered.length + 1}`,
      targetLabel: group.targetLabel,
      semanticPath: group.semanticPath,
      target: group.target,
      targetHint: group.targetHint,
      changes: [group],
      processCount: group.processCount,
      operationIds: [...group.operationIds],
      firstCreatedAt: group.firstCreatedAt,
      lastCreatedAt: group.lastCreatedAt,
    };
    tasks.set(key, task);
    ordered.push(task);
  }

  return ordered;
};

const propertyLabel = (kind: PromptOperationKind, property: string) => {
  if (kind === 'text') return '文案';
  if (kind === 'structure' && property === 'position') return '同级顺序';
  if (kind === 'structure' && property === 'placement') return '语义位置';
  if (kind === 'structure' && property === 'presence') return '节点存在性';
  if (kind === 'structure' && property === 'group') return '组合关系';
  return property;
};

const beforeSourceLabel = (source: PromptValueSource | undefined) => {
  if (source === 'inline') return '当前内联值';
  if (source === 'computed') return '当前计算值';
  if (source === 'observed') return '当前状态';
  return '当前值';
};

const changeSummary = (group: PromptGroupedOperation) => {
  const count =
    group.processCount > 1 ? `；累计记录 ${group.processCount} 次，源码只需实现最终值` : '';
  const valueChange = `${propertyLabel(group.kind, group.property)}：${beforeSourceLabel(group.beforeSource)} ${quote(group.before)} -> ${quote(group.after)}${count}`;
  return group.kind === 'structure' ? `结构动作：${group.label}；${valueChange}` : valueChange;
};

const inferredScopeLabel = (
  elementTasks: PromptElementTask[],
  structureOperations: PromptGroupedOperation[],
) => {
  const paths = [
    ...elementTasks.map((task) => task.semanticPath),
    ...structureOperations.map((group) => group.semanticPath),
  ]
    .filter((path): path is string => Boolean(path))
    .map((path) => path.split(' > ').filter(Boolean));
  if (!paths.length) return undefined;

  const commonLength = Math.min(...paths.map((path) => path.length));
  let prefixLength = 0;
  while (
    prefixLength < commonLength &&
    paths.every((path) => path[prefixLength] === paths[0]?.[prefixLength])
  )
    prefixLength += 1;

  if (paths.length === 1) prefixLength = Math.max(0, prefixLength - 1);
  return prefixLength ? paths[0]!.slice(0, prefixLength).join(' > ') : undefined;
};

const implementationHints = (task: PromptElementTask) => {
  const hints: string[] = [];
  if (task.changes.some((change) => change.kind === 'text'))
    hints.push('文字只修改目标直接文字片段，保留图标、标签和其他子元素。');
  if (task.changes.some((change) => change.kind === 'style' || change.kind === 'layout'))
    hints.push(
      '优先修改对应组件或局部 CSS；当前计算值不等于源码中已有显式规则，先查找规则，找不到再新增。',
    );
  return hints;
};

const structureHint = (group: PromptGroupedOperation) => {
  if (group.property === 'presence') return '按节点增删语义实现，保留其他同级节点。';
  return '优先使用现有 DOM 层级、Flex/Grid、margin、padding、gap、order 或局部 wrapper，不要把视口坐标直接写成 absolute top/left。';
};

const buildPrompt = (
  page: PromptPageContext,
  elementTasks: PromptElementTask[],
  structureOperations: PromptGroupedOperation[],
) => {
  const scopeLabel = page.scopeLabel ?? inferredScopeLabel(elementTasks, structureOperations);
  const lines: string[] = [
    '点睛 AI 源码同步任务',
    '',
    '任务目标：',
    '将当前预览中已确认的最终页面修改同步到对应业务源码。页面地址用于确认运行页面和刷新验收，不等同于源码文件路径。',
    '以下只描述最终页面状态；拖动、点击等中间过程不需要复现，只有会影响 DOM 关系的结构变更按顺序保留。',
    '',
    '页面身份：',
    `- 参考页面：${page.url || '未知'}`,
    `- 页面标题：${page.title || '未知'}`,
  ];

  if (scopeLabel) lines.push(`- 修改范围：${scopeLabel}`);
  if (page.viewport) lines.push(`- 参考视口：${page.viewport.width} × ${page.viewport.height}px`);

  lines.push(
    '',
    '源码定位：',
    '- 在当前源码工作区中结合页面路由、可见文案、语义路径和稳定选择器查找对应组件。',
    '- 如果源码映射不可靠，列入 Unresolved 并说明缺失信息；不要编造文件、组件或行号。',
  );

  if (!elementTasks.length && !structureOperations.length) {
    lines.push('', '最终效果：', '- 当前没有可同步的有效修改。');
  } else {
    lines.push('', '最终效果（按页面对象归并）：');
    for (const task of elementTasks) lines.push(`- [ ] ${task.taskId} | ${task.targetLabel}`);

    lines.push('');
    for (const task of elementTasks) {
      lines.push(`${task.taskId} | ${task.targetLabel}`);
      if (task.semanticPath) lines.push(`- 语义位置：${task.semanticPath}`);
      lines.push(`- 稳定定位：${task.targetHint}`);
      lines.push('- 最终修改：');
      for (const change of task.changes) lines.push(`  - ${changeSummary(change)}`);
      for (const hint of implementationHints(task)) lines.push(`- 实现提示：${hint}`);
      lines.push('');
    }

    if (structureOperations.length) {
      lines.push('结构变更顺序（按原操作顺序）：');
      structureOperations.forEach((group, index) => {
        lines.push(`${index + 1}. ${group.targetLabel}：${changeSummary(group)}`);
        lines.push(`   - 稳定定位：${group.targetHint}`);
        lines.push(`   - 实现提示：${structureHint(group)}`);
      });
    }
  }

  lines.push(
    '',
    '实现边界：',
    '- 只修改该页面对应的业务源码和必要的局部样式，不重做整页或修改无关文件。',
    '- 不要把点睛运行时注入的 Dock、选框、标尺、overlay 或 data-dianjing-* 标记写入业务页面。',
    '- 保留原有交互、数据逻辑、响应式行为和无关内容。',
    '',
    '完成验收：',
    '- 源码结构和最终值与上面的最终效果一致。',
    '- 重新打开真实页面并刷新，确认修改仍然存在。',
    '- 检查目标区域的计算样式和视觉结果；涉及节点删除或新增时确认结构正确。',
    '- 回归检查原有交互、数据逻辑、响应式布局和其他页面区域。',
    '- 最后列出已完成项和 Unresolved，不要把无法确认的内容默认为完成。',
  );

  return lines.join('\n');
};

export const buildAiPromptPacket = (
  page: PromptPageContext,
  operations: PromptOperationInput[],
): PromptPacket => {
  const activeOperations = operations.filter((operation) => !operation.cancelled);
  const groupedOperations = groupOperations(activeOperations);
  const elementTasks = buildElementTasks(groupedOperations);
  const structureOperations = groupedOperations.filter((group) => group.kind === 'structure');
  const context: PromptContext = {
    version: 2,
    page,
    operations: activeOperations,
    groupedOperations,
    elementTasks,
    structureOperations,
  };

  return {
    prompt: buildPrompt(page, elementTasks, structureOperations),
    context,
    hasChanges: groupedOperations.length > 0,
  };
};

export const promptContextJson = (packet: PromptPacket) => JSON.stringify(packet.context, null, 2);
