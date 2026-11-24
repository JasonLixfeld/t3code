import type { AutoScrollOptions } from "@dnd-kit/core";

// dnd-kit scrolls by `acceleration` pixels each 5 ms at the far end of its edge zone.
const DND_KIT_SCROLL_INTERVAL_MS = 5;

/**
 * Edge scrolling for Mission drags. Their moves are kept from dnd-kit, so its auto-scroll never
 * sees them; this scrolls the list at dnd-kit's speed for the sidebar's tuned options instead.
 */
export function createMissionEdgeScroll(options: AutoScrollOptions) {
  const threshold = typeof options.threshold?.y === "number" ? options.threshold.y : 0.2;
  const acceleration = options.acceleration ?? 10;
  let held: {
    readonly viewport: HTMLElement;
    readonly y: number;
    readonly onScroll: () => void;
    at: number;
  } | null = null;
  let frame: number | null = null;
  /** -1 to 1: how deep into the top or bottom edge zone, or past it, the pointer is. */
  const depth = (viewport: HTMLElement, y: number) => {
    const box = viewport.getBoundingClientRect();
    const zone = box.height * threshold;
    if (y < box.top + zone) return -Math.min(1, (box.top + zone - y) / zone);
    if (y > box.bottom - zone) return Math.min(1, (y - box.bottom + zone) / zone);
    return 0;
  };
  const step = (now: number) => {
    frame = null;
    if (held === null) return;
    const toward = depth(held.viewport, held.y);
    const elapsed = Math.max(0, now - held.at);
    held.at = now;
    if (toward === 0) return;
    const before = held.viewport.scrollTop;
    held.viewport.scrollTop += (toward * acceleration * elapsed) / DND_KIT_SCROLL_INTERVAL_MS;
    if (held.viewport.scrollTop !== before) held.onScroll();
    frame = requestAnimationFrame(step);
  };
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    held = null;
  };
  return {
    /** Whether the pointer is in an edge zone, and which: -1 the top, 1 the bottom, 0 neither. */
    edge: (viewport: HTMLElement, y: number) => Math.sign(depth(viewport, y)),
    /** Scrolls while the pointer rests in the edge zone, calling `onScroll` after each step. */
    hold: (viewport: HTMLElement, y: number, onScroll: () => void) => {
      held = { viewport, y, onScroll, at: held?.at ?? performance.now() };
      frame ??= requestAnimationFrame(step);
    },
    stop,
  };
}
