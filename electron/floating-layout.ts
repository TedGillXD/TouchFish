export interface FloatingPosition {
  x: number;
  y: number;
}

export interface FloatingRectangle extends FloatingPosition {
  width: number;
  height: number;
}

export const FLOATING_COMPACT = { width: 164, height: 44 } as const;
export const FLOATING_MEDIA_COMPACT = { width: 200, height: 44 } as const;
export const FLOATING_EXPANDED = { width: 264, height: 148 } as const;
const GAP = 16;

export function validFloatingPosition(value: unknown): value is FloatingPosition {
  if (!value || typeof value !== "object") return false;
  const point = value as FloatingPosition;
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Math.abs(point.x) <= 10_000_000 &&
    Math.abs(point.y) <= 10_000_000
  );
}

/** Coordinates and work areas are Electron DIP units, including negative displays. */
export function floatingBounds(
  position: FloatingPosition | undefined,
  expanded: boolean,
  workAreas: FloatingRectangle[],
  primaryIndex = 0,
  mediaActive = false,
): FloatingRectangle {
  if (!workAreas.length) throw new Error("没有可用的显示器工作区。");
  let area = workAreas[Math.max(0, Math.min(primaryIndex, workAreas.length - 1))];
  const size = expanded ? FLOATING_EXPANDED : mediaActive ? FLOATING_MEDIA_COMPACT : FLOATING_COMPACT;
  let point = position ?? {
    x: area.x + area.width - FLOATING_COMPACT.width - GAP,
    y: area.y + GAP,
  };
  if (position) {
    // Select the nearest usable work area when a remembered monitor was removed.
    const center = {
      x: position.x + FLOATING_COMPACT.width / 2,
      y: position.y + FLOATING_COMPACT.height / 2,
    };
    let nearest = Infinity;
    for (const candidate of workAreas) {
      const dx = Math.max(candidate.x - center.x, 0, center.x - candidate.x - candidate.width);
      const dy = Math.max(candidate.y - center.y, 0, center.y - candidate.y - candidate.height);
      const distance = dx * dx + dy * dy;
      if (distance < nearest) {
        nearest = distance;
        area = candidate;
      }
    }
  }
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  point = {
    x: Math.max(area.x, Math.min(point.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(point.y, area.y + area.height - height)),
  };
  return { x: Math.round(point.x), y: Math.round(point.y), width, height };
}
