import { describe, expect, it } from 'vitest';
import { resolveTarget, targetFor } from './index';

describe('resolveTarget', () => {
  it('does not guess when edit ids duplicate', () => {
    document.body.innerHTML = '<p data-edit-id="title"></p><p data-edit-id="title"></p>';
    expect(resolveTarget({ editId: 'title' })).toEqual({ reason: 'ambiguous' });
  });

  it('uses a unique fallback selector when no edit id exists', () => {
    document.body.innerHTML = '<p id="stable-title">Title</p>';
    expect(targetFor(document.querySelector('p')!)).toEqual({ fallbackSelector: '#stable-title' });
  });

  it('builds a verified DOM path for an unmarked card title', () => {
    document.body.innerHTML = '<section><article><h2>风险监测</h2></article><article><h2>数据摘要</h2></article></section>';
    const title = document.querySelector<HTMLElement>('article h2')!;
    const target = targetFor(title);
    expect(target).toEqual({ fallbackSelector: 'body > section:nth-of-type(1) > article:nth-of-type(1) > h2:nth-of-type(1)' });
    expect(resolveTarget(target!)).toEqual({ element: title });
  });
});
