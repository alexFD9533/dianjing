export type DockToolbarPoint = {
  x: number;
  y: number;
};

export type DockToolbarSize = {
  width: number;
  height: number;
};

export type DockViewport = {
  width: number;
  height: number;
};

export const clampDockToolbarPosition = (
  position: DockToolbarPoint,
  size: DockToolbarSize,
  viewport: DockViewport,
  margin = 12,
): DockToolbarPoint => {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  return {
    x: Math.min(Math.max(margin, position.x), maxX),
    y: Math.min(Math.max(margin, position.y), maxY),
  };
};

export const defaultDockToolbarPosition = (
  size: DockToolbarSize,
  viewport: DockViewport,
  bottomOffset = 18,
  margin = 12,
): DockToolbarPoint =>
  clampDockToolbarPosition(
    {
      x: (viewport.width - size.width) / 2,
      y: viewport.height - size.height - bottomOffset,
    },
    size,
    viewport,
    margin,
  );
