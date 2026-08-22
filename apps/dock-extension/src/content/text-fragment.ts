export type TextFragmentRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/**
 * One logical run of direct text in an element.
 *
 * `index` is the protocol-compatible textNodeIndex. It identifies a logical
 * fragment, rather than an individual DOM Text node. A fragment may contain
 * several Text nodes and may cross hidden/out-of-flow direct children.
 */
export type TextFragment = {
  owner: HTMLElement;
  index: number;
  nodes: Text[];
  wrapper: HTMLElement | null;
  text: string;
};

type TextFragmentWrapperElement = HTMLElement & {
  readonly __dianjingTextFragmentWrapper: true;
};

const isTextNode = (node: Node | null | undefined): node is Text =>
  Boolean(node && node.nodeType === 3);
const isElementNode = (node: Node): node is Element => node.nodeType === 1;

export const isTextFragmentWrapper = (
  node: Node | null,
): node is TextFragmentWrapperElement =>
  Boolean(
    node &&
      node.nodeType === 1 &&
      (node as Element).ownerDocument.defaultView &&
      (node as Element & { dataset?: DOMStringMap }).dataset?.dianjingTextFragment === 'true',
  );

/**
 * Pure text leaves are represented by their element to avoid duplicate tree
 * rows. Once a logical text fragment is selected, however, it must remain
 * exposed even if materialization leaves only fragment wrappers as children.
 */
export const shouldExposeDirectTextFragments = (
  owner: HTMLElement,
  selectedTextOwner = false,
) =>
  selectedTextOwner ||
  [...owner.children].some((child) => !isTextFragmentWrapper(child));

const wrapperTextNodes = (wrapper: HTMLElement): Text[] =>
  [...wrapper.childNodes].filter(isTextNode);

const computedChildStyle = (element: Element) =>
  element.ownerDocument.defaultView?.getComputedStyle(element);

/**
 * Hidden and out-of-flow direct children do not interrupt a normal text run.
 * Their own contents are still represented by the regular element scanner.
 */
export const isNonFlowTextBoundary = (node: Node): boolean => {
  if (!isElementNode(node)) return false;
  const computed = computedChildStyle(node);
  return (
    computed?.display === 'none' ||
    computed?.position === 'absolute' ||
    computed?.position === 'fixed'
  );
};

const fragmentWrapperForNodes = (owner: HTMLElement, nodes: Text[]) => {
  const wrappers = [...owner.children].filter(isTextFragmentWrapper);
  return (
    wrappers.find((wrapper) => nodes.some((node) => wrapper.contains(node))) as HTMLElement | undefined
  ) ?? null;
};

const fragmentFromNodes = (owner: HTMLElement, index: number, nodes: Text[]): TextFragment => ({
  owner,
  index,
  nodes,
  wrapper: fragmentWrapperForNodes(owner, nodes),
  get text() {
    return nodes.map((node) => node.data).join('');
  },
});

/**
 * Reads logical direct-text fragments in source order.
 *
 * Comments, whitespace-only nodes, text-fragment wrappers, display:none
 * children, and absolute/fixed children do not create boundaries. Any other
 * direct element participating in normal flow is a fragment boundary.
 */
export const directTextFragments = (owner: HTMLElement): TextFragment[] => {
  const groups: Text[][] = [];
  let current: Text[] = [];
  const flush = () => {
    if (current.some((node) => node.data.trim())) groups.push(current);
    current = [];
  };

  for (const child of [...owner.childNodes]) {
    if (isTextNode(child)) {
      current.push(child);
      continue;
    }
    if (isTextFragmentWrapper(child)) {
      current.push(...wrapperTextNodes(child));
      continue;
    }
    if (isElementNode(child)) {
      if (!isNonFlowTextBoundary(child)) flush();
      continue;
    }
    // Comments and other non-rendering nodes do not split the current run.
  }
  flush();

  return groups.map((nodes, index) => fragmentFromNodes(owner, index, nodes));
};

export const directTextFragmentIndex = (owner: HTMLElement, node: Text): number | undefined => {
  const fragment = directTextFragments(owner).find((candidate) => candidate.nodes.includes(node));
  return fragment?.index;
};

export const resolveDirectTextFragment = (
  owner: HTMLElement,
  index: number | undefined,
): TextFragment | null => {
  if (index === undefined) return null;
  return directTextFragments(owner)[index] ?? null;
};

export const textFragmentForNode = (owner: HTMLElement, node: Text | null): TextFragment | null => {
  if (!node) return null;
  return directTextFragments(owner).find((fragment) => fragment.nodes.includes(node)) ?? null;
};

export const textFragmentBelongsTo = (owner: HTMLElement, fragment: TextFragment | null) =>
  Boolean(fragment && fragment.owner === owner && directTextFragments(owner).some((candidate) => candidate.nodes.some((node) => fragment.nodes.includes(node))));

export const textNodeBelongsTo = (owner: HTMLElement, node: Text): boolean =>
  directTextFragments(owner).some((fragment) => fragment.nodes.includes(node));

export const textNodeWrapper = (owner: HTMLElement, node: Text): HTMLElement | null => {
  const parent = node.parentElement;
  return parent && isTextFragmentWrapper(parent) && parent.parentElement === owner ? parent : null;
};

export const readDirectTextFragment = (
  owner: HTMLElement,
  index: number | undefined,
): string | null => resolveDirectTextFragment(owner, index)?.text ?? null;

/** Writes a complete logical fragment while preserving its DOM contributors. */
export const writeDirectTextFragment = (
  owner: HTMLElement,
  index: number | undefined,
  value: string,
): boolean => {
  const fragment = resolveDirectTextFragment(owner, index);
  if (!fragment?.nodes.length) return false;
  fragment.nodes[0]!.data = value;
  fragment.nodes.slice(1).forEach((node) => (node.data = ''));
  return true;
};


/**
 * Materializes a whole logical fragment into one lightweight span. The span
 * replaces only the text contributors; hidden/out-of-flow sibling elements
 * remain direct children of the original owner.
 */
export const materializeDirectTextFragment = (
  owner: HTMLElement,
  index: number | undefined,
): HTMLElement | null => {
  const fragment = resolveDirectTextFragment(owner, index);
  if (!fragment?.nodes.length) return null;
  const firstNode = fragment.nodes[0]!;
  const existing = fragment.wrapper;
  const firstToken = existing ?? (firstNode.parentElement === owner ? firstNode : null);
  const wrapper =
    existing ??
    (() => {
      const created = owner.ownerDocument.createElement('span');
      created.dataset.dianjingTextFragment = 'true';
      created.dataset.textFragmentIndex = String(fragment.index);
      created.dataset.editId =
        globalThis.crypto?.randomUUID?.() ??
        `dianjing-text-fragment-${Date.now()}-${Math.random()}`;
      return created;
    })();

  if (!wrapper.parentElement || wrapper.parentElement !== owner) {
    if (!firstToken) return null;
    owner.insertBefore(wrapper, firstToken);
  } else if (firstToken && wrapper !== firstToken) {
    owner.insertBefore(wrapper, firstToken);
  }

  wrapper.dataset.textFragmentIndex = String(fragment.index);
  const firstNonTextChild = () =>
    [...wrapper.childNodes].find((child) => !isTextNode(child)) ?? null;
  for (const node of fragment.nodes) {
    if (node.parentNode === wrapper) continue;
    wrapper.insertBefore(node, firstNonTextChild());
  }
  for (const candidate of [...owner.children].filter(isTextFragmentWrapper)) {
    if (candidate !== wrapper && candidate.parentElement === owner && candidate.childNodes.length === 0)
      candidate.remove();
  }
  return wrapper;
};

const rectLike = (rect: DOMRect | DOMRectReadOnly | ClientRect): TextFragmentRect => ({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  width: rect.width,
  height: rect.height,
});

const unionRects = (rects: Array<DOMRect | DOMRectReadOnly | ClientRect>): TextFragmentRect | null => {
  const visible = rects.filter((rect) => rect.width > 0 || rect.height > 0);
  if (!visible.length) return null;
  const left = Math.min(...visible.map((rect) => rect.left));
  const top = Math.min(...visible.map((rect) => rect.top));
  const right = Math.max(...visible.map((rect) => rect.right));
  const bottom = Math.max(...visible.map((rect) => rect.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

/** Measures every Text node in a logical fragment, or its materialized span. */
export const textFragmentClientRect = (
  owner: HTMLElement,
  fragment: TextFragment | null,
): TextFragmentRect | null => {
  if (!fragment || !textFragmentBelongsTo(owner, fragment)) return null;
  const wrapper =
    fragment.wrapper && fragment.wrapper.isConnected &&
    fragment.nodes.every((node) => fragment.wrapper?.contains(node))
      ? fragment.wrapper
      : null;
  if (wrapper) return rectLike(wrapper.getBoundingClientRect());
  const rects: Array<DOMRect | DOMRectReadOnly | ClientRect> = [];
  for (const node of fragment.nodes) {
    try {
      const range = owner.ownerDocument.createRange();
      range.selectNodeContents(node);
      rects.push(...Array.from(range.getClientRects()));
    } catch {
      // A detached or invalid text node contributes no measurable rectangle.
    }
  }
  return unionRects(rects);
};

type CaretPositionDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const pointIsInsideTextNode = (document: Document, node: Text, x: number, y: number) => {
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    if (!rects.length) return null;
    return rects.some(
      (rect) =>
        x >= rect.left - 2 &&
        x <= rect.right + 2 &&
        y >= rect.top - 2 &&
        y <= rect.bottom + 2,
    );
  } catch {
    return null;
  }
};

export const directTextFragmentAtPoint = (
  document: Document,
  owner: HTMLElement,
  x: number,
  y: number,
): TextFragment | null => {
  const fragments = directTextFragments(owner).filter((fragment) => fragment.text.trim());
  const directCandidate = fragments.find((fragment) =>
    fragment.nodes.some((node) => pointIsInsideTextNode(document, node, x, y) === true),
  );
  if (directCandidate) return directCandidate;

  const pointDocument = document as CaretPositionDocument;
  const positionNode = pointDocument.caretPositionFromPoint?.(x, y)?.offsetNode;
  const rangeNode = pointDocument.caretRangeFromPoint?.(x, y)?.startContainer;
  const candidate = positionNode ?? rangeNode;
  if (!isTextNode(candidate)) return null;
  const fragment = textFragmentForNode(owner, candidate);
  if (!fragment || !candidate.data.trim()) return null;
  return pointIsInsideTextNode(document, candidate, x, y) === false ? null : fragment;
};
