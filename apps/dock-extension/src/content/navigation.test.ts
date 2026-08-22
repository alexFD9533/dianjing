import { describe, expect, it } from 'vitest';
import { nextDockElement } from './navigation';

describe('Dock DOM keyboard navigation', () => {
  it('moves between parent, first child and same-level siblings without wrapping', () => {
    document.body.innerHTML = `
      <main>
        <article id="card"><h2 id="title">标题</h2><button id="action">操作</button></article>
        <article id="other"><h2 id="other-title">另一张卡片</h2></article>
      </main>
    `;
    const card = document.querySelector<HTMLElement>('#card')!;
    const title = document.querySelector<HTMLElement>('#title')!;
    const action = document.querySelector<HTMLElement>('#action')!;
    const other = document.querySelector<HTMLElement>('#other')!;

    expect(nextDockElement(card, 'child', document)).toBe(title);
    expect(nextDockElement(title, 'parent', document)).toBe(card);
    expect(nextDockElement(title, 'next', document)).toBe(action);
    expect(nextDockElement(title, 'previous', document)).toBeNull();
    expect(nextDockElement(other, 'next', document)).toBeNull();
  });

  it('does not navigate into the Dock host itself', () => {
    document.body.innerHTML =
      '<main><p id="page-text">页面文字</p><div data-dock-extension-host><button>Dock</button></div></main>';
    const pageText = document.querySelector<HTMLElement>('#page-text')!;
    expect(nextDockElement(pageText, 'next', document)).toBeNull();
  });
});
