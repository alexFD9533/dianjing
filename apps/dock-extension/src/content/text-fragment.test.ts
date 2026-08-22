import { describe, expect, it, vi } from 'vitest';
import {
  directTextFragmentAtPoint,
  directTextFragmentIndex,
  directTextFragments,
  isTextFragmentWrapper,
  materializeDirectTextFragment,
  readDirectTextFragment,
  shouldExposeDirectTextFragments,
  textFragmentClientRect,
  writeDirectTextFragment,
} from './text-fragment';

describe('direct text fragments', () => {
  it('groups direct text contributors around out-of-flow children', () => {
    document.body.innerHTML =
      '<b id="owner">提升运输<span style="position:absolute">+57%</span>运行时长<svg id="icon"></svg></b>';
    const owner = document.querySelector<HTMLElement>('#owner')!;
    const textNode = owner.firstChild as Text;
    const fragments = directTextFragments(owner);
    const index = directTextFragmentIndex(owner, textNode);

    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.text).toBe('提升运输运行时长');
    expect(readDirectTextFragment(owner, index)).toBe('提升运输运行时长');
    expect(writeDirectTextFragment(owner, index, '完整文字')).toBe(true);
    expect(owner.querySelector('span')?.textContent).toBe('+57%');
    expect(owner.querySelector('#icon')).not.toBeNull();
    expect(owner.textContent).toBe('完整文字+57%');
  });

  it('absorbs multiple fragment wrappers without moving non-text siblings', () => {
    document.body.innerHTML =
      '<b id="owner"><span data-dianjing-text-fragment="true">提升</span><i style="position:absolute">+57%</i><span data-dianjing-text-fragment="true">运输</span><svg id="icon"></svg></b>';
    const owner = document.querySelector<HTMLElement>('#owner')!;
    const fragment = directTextFragments(owner)[0]!;

    expect(fragment.text).toBe('提升运输');
    const wrapper = materializeDirectTextFragment(owner, fragment.index)!;
    expect(owner.querySelectorAll('[data-dianjing-text-fragment]')).toHaveLength(1);
    expect(wrapper.textContent).toBe('提升运输');
    expect(owner.querySelector('i')?.parentElement).toBe(owner);
    expect(owner.querySelector('#icon')?.parentElement).toBe(owner);
  });

  it('keeps fragment text live after writing through an old fragment reference', () => {
    document.body.innerHTML = '<b id="owner">提升<span style="position:absolute">+57%</span>运输</b>';
    const owner = document.querySelector<HTMLElement>('#owner')!;
    const fragment = directTextFragments(owner)[0]!;

    expect(fragment.text).toBe('提升运输');
    expect(writeDirectTextFragment(owner, fragment.index, '更新后的文字')).toBe(true);
    expect(fragment.text).toBe('更新后的文字');
    expect(readDirectTextFragment(owner, fragment.index)).toBe('更新后的文字');
  });

  it('unions ranges when an old wrapper covers only part of a fragment', () => {
    document.body.innerHTML =
      '<b id="owner"><span data-dianjing-text-fragment="true">提升</span><i style="position:absolute">+57%</i>运输</b>';
    const owner = document.querySelector<HTMLElement>('#owner')!;
    const fragment = directTextFragments(owner)[0]!;
    const wrapper = fragment.wrapper!;
    expect(fragment.nodes).toHaveLength(2);

    const wrapperRect = vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 20,
      right: 60,
      bottom: 40,
      width: 50,
      height: 20,
    } as DOMRect);
    const createRange = vi.spyOn(owner.ownerDocument, 'createRange');
    let rangeIndex = 0;
    createRange.mockImplementation(() => {
      const rect = rangeIndex++ === 0
        ? { left: 10, top: 20, right: 60, bottom: 40, width: 50, height: 20 }
        : { left: 80, top: 20, right: 130, bottom: 40, width: 50, height: 20 };
      return {
        selectNodeContents: vi.fn(),
        getClientRects: () => [rect],
      } as unknown as Range;
    });

    expect(textFragmentClientRect(owner, fragment)).toEqual({
      left: 10,
      top: 20,
      right: 130,
      bottom: 40,
      width: 120,
      height: 20,
    });
    expect(wrapperRect).not.toHaveBeenCalled();
    createRange.mockRestore();
  });

  it('recognizes a fragment wrapper created in an iframe realm', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const foreignDocument = iframe.contentDocument;
    expect(foreignDocument).not.toBeNull();
    const foreignOwner = foreignDocument!.createElement('b');
    foreignOwner.innerHTML =
      '<span data-dianjing-text-fragment="true">跨 realm 文字</span>';
    foreignDocument!.body.append(foreignOwner);
    const foreignWrapper = foreignOwner.firstElementChild!;

    expect(foreignWrapper instanceof HTMLElement).toBe(false);
    expect(isTextFragmentWrapper(foreignWrapper)).toBe(true);
    expect(
      directTextFragments(foreignOwner as unknown as HTMLElement)[0]?.text,
    ).toBe('跨 realm 文字');
  });

  it('keeps a selected materialized text fragment exposed in the object state', () => {
    document.body.innerHTML =
      '<b id="owner"><span data-dianjing-text-fragment="true">基本持平</span></b>';
    const owner = document.querySelector<HTMLElement>('#owner')!;

    expect(shouldExposeDirectTextFragments(owner)).toBe(false);
    expect(shouldExposeDirectTextFragments(owner, true)).toBe(true);
    expect(directTextFragments(owner)[0]?.text).toBe('基本持平');
  });

  it('rejects a point that resolves to a nested child instead of the owner text', () => {
    document.body.innerHTML = '<b>17<small>nested</small></b>';
    const owner = document.querySelector<HTMLElement>('b')!;
    const nestedText = owner.querySelector('small')!.firstChild as Text;
    const pointDocument = document as unknown as {
      caretPositionFromPoint?: (...args: unknown[]) => unknown;
    };
    pointDocument.caretPositionFromPoint = () => ({ offsetNode: nestedText });

    expect(directTextFragmentAtPoint(document, owner, 0, 0)).toBeNull();
  });
});
