import type { Patch } from '@workbench/contracts';

export type ResolveResult = { element: HTMLElement } | { reason: 'missing' | 'ambiguous' };

const attributeSelector = (editId: string) => `[data-edit-id=${JSON.stringify(editId)}]`;

function domPath(element: HTMLElement): string | null {
  const parts: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement instanceof HTMLElement ? current.parentElement : null;
    if (!parent) return null;
    const siblings = [...parent.children].filter((sibling) => sibling.tagName === current!.tagName);
    const position = siblings.indexOf(current) + 1;
    if (!position) return null;
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${position})`);
    current = parent;
  }
  return current === document.body ? `body > ${parts.join(' > ')}` : null;
}

export function resolveTarget(target: Patch['target'], root: ParentNode = document): ResolveResult {
  if (target.editId) {
    const matches = root.querySelectorAll<HTMLElement>(attributeSelector(target.editId));
    if (matches.length === 1) return { element: matches[0]! };
    if (matches.length > 1) return { reason: 'ambiguous' };
  }
  if (!target.fallbackSelector) return { reason: 'missing' };
  try {
    const matches = root.querySelectorAll<HTMLElement>(target.fallbackSelector);
    return matches.length === 1 ? { element: matches[0]! } : { reason: matches.length ? 'ambiguous' : 'missing' };
  } catch { return { reason: 'missing' }; }
}

export function targetFor(element: HTMLElement): Patch['target'] | null {
  const editId = element.dataset.editId;
  if (editId) return { editId };
  if (/^[A-Za-z][\w-]*$/.test(element.id)) {
    const fallbackSelector = `#${element.id}`;
    if (document.querySelectorAll(fallbackSelector).length === 1) return { fallbackSelector };
  }
  const classes = [...element.classList].filter((name) => /^[A-Za-z_][\w-]*$/.test(name));
  if (classes.length) {
    const fallbackSelector = `${element.tagName.toLowerCase()}.${classes.join('.')}`;
    if (document.querySelectorAll(fallbackSelector).length === 1) return { fallbackSelector };
  }
  const fallbackSelector = domPath(element);
  if (fallbackSelector && document.querySelectorAll(fallbackSelector).length === 1) return { fallbackSelector };
  return null;
}
