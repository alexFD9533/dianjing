import { describe, expect, it } from 'vitest';
import { clampDockToolbarPosition, defaultDockToolbarPosition } from './toolbar-position';

describe('Dock toolbar position', () => {
  const size = { width: 320, height: 48 };
  const viewport = { width: 1280, height: 720 };

  it('starts at the bottom center', () => {
    expect(defaultDockToolbarPosition(size, viewport)).toEqual({ x: 480, y: 654 });
  });

  it('keeps the toolbar inside the viewport', () => {
    expect(clampDockToolbarPosition({ x: -80, y: 900 }, size, viewport)).toEqual({
      x: 12,
      y: 660,
    });
    expect(clampDockToolbarPosition({ x: 1100, y: -20 }, size, viewport)).toEqual({
      x: 948,
      y: 12,
    });
  });
});
