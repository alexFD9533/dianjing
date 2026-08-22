import { resolveTarget } from '@workbench/selector-engine';
import {
  directTextFragments,
  materializeDirectTextFragment,
  resolveDirectTextFragment,
  type TextFragment,
} from '../content/text-fragment';
import type { WorkspaceTarget } from './workspace-protocol';

export type WorkspaceElementHandle = {
  kind: 'element';
  target: WorkspaceTarget;
  element: HTMLElement;
};

export type WorkspaceTextFragmentHandle = {
  kind: 'text-fragment';
  target: WorkspaceTarget & { textNodeIndex: number };
  owner: HTMLElement;
  fragment: TextFragment;
};

export type WorkspaceTargetHandle = WorkspaceElementHandle | WorkspaceTextFragmentHandle;

export type WorkspaceTargetResolution =
  | { ok: true; handle: WorkspaceTargetHandle }
  | { ok: false; error: string };

export type WorkspaceElementResolution =
  | { ok: true; handle: WorkspaceElementHandle }
  | { ok: false; error: string };

export type WorkspaceLayoutHandle =
  | (WorkspaceElementHandle & { layoutElement: HTMLElement })
  | (WorkspaceTextFragmentHandle & { layoutElement: HTMLElement });

export type WorkspaceLayoutResolution =
  | { ok: true; handle: WorkspaceLayoutHandle }
  | { ok: false; error: string };

const ownerTargetOf = (target: WorkspaceTarget): WorkspaceTarget => {
  const ownerTarget = { ...target };
  delete ownerTarget.textNodeIndex;
  return ownerTarget;
};

const resolutionError = (target: WorkspaceTarget, reason: 'missing' | 'ambiguous') =>
  target.textNodeIndex === undefined
    ? reason === 'ambiguous'
      ? '目标元素定位不唯一，请刷新工作台后重试'
      : '目标元素已失效，请刷新工作台后重试'
    : reason === 'ambiguous'
      ? '文字片段的所属元素定位不唯一，请刷新工作台后重试'
      : '文字片段的所属元素已失效，请刷新工作台后重试';

/** Resolves the owner element without silently accepting a text-fragment target. */
export const resolveWorkspaceElementHandle = (
  target: WorkspaceTarget,
  root: ParentNode = document,
): WorkspaceElementResolution => {
  if (target.textNodeIndex !== undefined)
    return { ok: false, error: '文字对象不是结构元素，当前操作不能使用其父容器' };
  const result = resolveTarget(ownerTargetOf(target), root);
  if (!('element' in result)) return { ok: false, error: resolutionError(target, result.reason) };
  return { ok: true, handle: { kind: 'element', target, element: result.element } };
};

/** Resolves either an element handle or a logical text-fragment handle. */
export const resolveWorkspaceTargetHandle = (
  target: WorkspaceTarget,
  root: ParentNode = document,
): WorkspaceTargetResolution => {
  const result = resolveTarget(ownerTargetOf(target), root);
  if (!('element' in result)) return { ok: false, error: resolutionError(target, result.reason) };
  if (target.textNodeIndex === undefined)
    return { ok: true, handle: { kind: 'element', target, element: result.element } };
  if (!Number.isInteger(target.textNodeIndex) || target.textNodeIndex < 0)
    return { ok: false, error: '文字片段索引无效，请刷新工作台后重试' };
  const fragment = resolveDirectTextFragment(result.element, target.textNodeIndex);
  if (!fragment)
    return { ok: false, error: '文字片段已失效，请刷新工作台后重试' };
  return {
    ok: true,
    handle: {
      kind: 'text-fragment',
      target: { ...ownerTargetOf(target), textNodeIndex: target.textNodeIndex },
      owner: result.element,
      fragment,
    },
  };
};

export const materializeWorkspaceLayoutHandle = (
  handle: WorkspaceTargetHandle,
): WorkspaceLayoutHandle | null => {
  if (handle.kind === 'element')
    return { ...handle, layoutElement: handle.element };
  const layoutElement = materializeDirectTextFragment(handle.owner, handle.fragment.index);
  if (!layoutElement) return null;
  const fragment = resolveDirectTextFragment(handle.owner, handle.fragment.index);
  if (!fragment) return null;
  return { ...handle, fragment, layoutElement };
};

/** Resolves a layout target and materializes text only at the layout boundary. */
export const resolveWorkspaceLayoutHandle = (
  target: WorkspaceTarget,
  root: ParentNode = document,
): WorkspaceLayoutResolution => {
  const resolved = resolveWorkspaceTargetHandle(target, root);
  if (!resolved.ok) return resolved;
  const handle = materializeWorkspaceLayoutHandle(resolved.handle);
  if (!handle)
    return { ok: false, error: '文字片段物化后无法重新定位，请刷新工作台后重试' };
  return { ok: true, handle };
};

export const workspaceTargetIsTextFragment = (target: WorkspaceTarget) =>
  target.textNodeIndex !== undefined;

export const workspaceTargetOwner = (handle: WorkspaceTargetHandle) =>
  handle.kind === 'element' ? handle.element : handle.owner;

export const workspaceTargetFragments = (owner: HTMLElement) => directTextFragments(owner);
