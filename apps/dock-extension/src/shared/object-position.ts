type CssPositionValue = {
  position: string;
  left: string;
  top: string;
  right: string;
  bottom: string;
};

export type ObjectPositionMetrics = CssPositionValue & {
  offsetLeft: number;
  offsetTop: number;
  rectLeft: number;
  rectTop: number;
};

export type ObjectMovePosition = {
  position: 'relative' | null;
  left: number;
  top: number;
  clearRight: boolean;
  clearBottom: boolean;
};

const parsePixels = (value: string) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && value.trim() !== 'auto' ? parsed : null;
};

/**
 * Convert an element's current positioning anchors into a stable left/top
 * basis before applying a canvas drag delta.
 */
export const objectMovePosition = (metrics: ObjectPositionMetrics): ObjectMovePosition => {
  if (metrics.position === 'static') {
    return {
      position: 'relative',
      left: 0,
      top: 0,
      clearRight: metrics.right.trim() !== 'auto',
      clearBottom: metrics.bottom.trim() !== 'auto',
    };
  }

  const fixedPosition = metrics.position === 'fixed';
  return {
    position: null,
    left: parsePixels(metrics.left) ?? (fixedPosition ? metrics.rectLeft : metrics.offsetLeft),
    top: parsePixels(metrics.top) ?? (fixedPosition ? metrics.rectTop : metrics.offsetTop),
    clearRight: metrics.right.trim() !== 'auto',
    clearBottom: metrics.bottom.trim() !== 'auto',
  };
};
