import { describe, expect, it } from 'vitest';
import { objectMovePosition } from '../shared/object-position';

const baseMetrics = {
  left: 'auto',
  top: 'auto',
  right: 'auto',
  bottom: 'auto',
  offsetLeft: 120,
  offsetTop: 340,
  rectLeft: 12,
  rectTop: 24,
};

describe('objectMovePosition', () => {
  it('converts an absolute bottom-anchored object to its current top coordinate', () => {
    expect(
      objectMovePosition({
        ...baseMetrics,
        position: 'absolute',
        left: '39px',
        bottom: '14px',
        offsetLeft: 39,
        offsetTop: 520,
      }),
    ).toEqual({
      position: null,
      left: 39,
      top: 520,
      clearRight: false,
      clearBottom: true,
    });
  });

  it('converts a right-bottom anchored object without changing its visible position', () => {
    expect(
      objectMovePosition({
        ...baseMetrics,
        position: 'absolute',
        right: '12px',
        bottom: '16px',
        offsetLeft: 420,
        offsetTop: 280,
      }),
    ).toEqual({
      position: null,
      left: 420,
      top: 280,
      clearRight: true,
      clearBottom: true,
    });
  });

  it('enables relative positioning for static objects without activating ignored anchors', () => {
    expect(
      objectMovePosition({
        ...baseMetrics,
        position: 'static',
        right: '8px',
        bottom: '10px',
      }),
    ).toEqual({
      position: 'relative',
      left: 0,
      top: 0,
      clearRight: true,
      clearBottom: true,
    });
  });

  it('uses viewport coordinates for fixed objects', () => {
    expect(
      objectMovePosition({
        ...baseMetrics,
        position: 'fixed',
        right: '20px',
        bottom: '30px',
        rectLeft: 760,
        rectTop: 420,
      }),
    ).toEqual({
      position: null,
      left: 760,
      top: 420,
      clearRight: true,
      clearBottom: true,
    });
  });
});
