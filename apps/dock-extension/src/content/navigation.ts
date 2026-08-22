export type DockNavigationDirection = 'parent' | 'child' | 'previous' | 'next';

const excludedTags = new Set([
  'BODY',
  'HTML',
  'HEAD',
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'BR',
  'HR',
]);
const semanticTags = new Set([
  'A',
  'ARTICLE',
  'ASIDE',
  'BUTTON',
  'CANVAS',
  'FOOTER',
  'FORM',
  'HEADER',
  'IMG',
  'INPUT',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'SECTION',
  'SELECT',
  'TABLE',
  'TEXTAREA',
  'UL',
  'VIDEO',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'STRONG',
  'SPAN',
]);

const hasDirectText = (element: HTMLElement) =>
  [...element.childNodes].some((node) => node.nodeType === 3 && Boolean(node.textContent?.trim()));

export const isDockNavigable = (element: HTMLElement): boolean => {
  if (excludedTags.has(element.tagName)) return false;
  if (element.closest('[data-dock-extension-host]')) return false;
  if (element.dataset.dockIgnore === 'true') return false;
  return Boolean(
    element.dataset.editId ||
    element.id ||
    element.className ||
    element.getAttribute('role') ||
    semanticTags.has(element.tagName) ||
    hasDirectText(element),
  );
};

export const dockNavigableNodes = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('*')].filter(isDockNavigable);

const parentFor = (current: HTMLElement, nodes: HTMLElement[]): HTMLElement | null => {
  let parent = current.parentElement;
  while (parent) {
    if (nodes.includes(parent)) return parent;
    parent = parent.parentElement;
  }
  return null;
};

const childrenFor = (parent: HTMLElement, nodes: HTMLElement[]): HTMLElement[] =>
  nodes.filter(
    (node) => node !== parent && parent.contains(node) && parentFor(node, nodes) === parent,
  );

const siblingsFor = (current: HTMLElement, nodes: HTMLElement[]): HTMLElement[] => {
  const parent = parentFor(current, nodes);
  if (parent) return childrenFor(parent, nodes);
  return current.parentElement
    ? nodes.filter((node) => node.parentElement === current.parentElement)
    : [current];
};

export const nextDockElement = (
  current: HTMLElement,
  direction: DockNavigationDirection,
  root: ParentNode,
): HTMLElement | null => {
  const nodes = dockNavigableNodes(root);
  if (!nodes.includes(current)) return null;
  if (direction === 'parent') return parentFor(current, nodes);
  if (direction === 'child') return childrenFor(current, nodes)[0] ?? null;

  const siblings = siblingsFor(current, nodes);
  const index = siblings.indexOf(current);
  if (index < 0) return null;
  return siblings[index + (direction === 'previous' ? -1 : 1)] ?? null;
};
