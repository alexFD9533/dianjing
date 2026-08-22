import { describe, expect, it } from 'vitest';
import {
  layoutSchemeSchema,
  moveLayoutModule,
  patchSchema,
  validateLayoutScheme,
  type LayoutRule,
} from './index';

describe('patch schema', () => {
  it('rejects unsafe styles', () => {
    expect(() =>
      patchSchema.parse({
        id: '1',
        target: { editId: 'x' },
        kind: 'style',
        property: 'backgroundImage',
        before: '',
        after: 'url(x)',
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

describe('layout scheme constraints', () => {
  const rules: LayoutRule[] = [
    { moduleId: 'one', allowedSlots: ['left', 'main'], allowHide: true },
    { moduleId: 'two', allowedSlots: ['main'], allowHide: false },
  ];
  const scheme = layoutSchemeSchema.parse({
    pageId: 'page',
    layoutVersion: 1,
    slots: { left: ['one'], main: ['two'] },
    modules: {
      one: { slotId: 'left', visible: true, locked: false },
      two: { slotId: 'main', visible: true, locked: false },
    },
  });

  it('moves only protocol modules to allowed slots', () => {
    expect(moveLayoutModule(scheme, rules, 'one', 'main', 0).slots.main).toEqual(['one', 'two']);
    expect(() => moveLayoutModule(scheme, rules, 'two', 'left', 0)).toThrow('SLOT_NOT_ALLOWED');
  });

  it('detects duplicate and unsafe hidden modules', () => {
    expect(
      validateLayoutScheme({ ...scheme, slots: { left: ['one', 'one'], main: ['two'] } }, rules),
    ).toContain('DUPLICATE_MODULE:one');
    expect(
      validateLayoutScheme(
        {
          ...scheme,
          modules: { ...scheme.modules, two: { ...scheme.modules.two!, visible: false } },
        },
        rules,
      ),
    ).toContain('HIDE_NOT_ALLOWED:two');
  });

  it('accepts local-only workbench metadata without changing protocol constraints', () => {
    const enhanced = layoutSchemeSchema.parse({
      ...scheme,
      workbench: {
        canvas: {
          width: 1440,
          height: null,
          zoom: 0.8,
          grid: true,
          rulers: true,
          boundaries: true,
          guides: true,
        },
        items: {
          card: {
            selector: '#card',
            parentSelector: '#main',
            containerSelector: '#main',
            left: 16,
            top: 24,
            width: 300,
            height: 180,
            zIndex: 20,
            locked: false,
            hidden: false,
          },
        },
        groups: { group: { name: '组合 1', parentSelector: '#main', members: ['card', 'title'] } },
      },
    });
    expect(enhanced.workbench?.canvas.width).toBe(1440);
    expect(validateLayoutScheme(enhanced, rules)).toEqual([]);
  });
});
