import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createMissionEdgeScroll } from "./missionEdgeScroll";

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const runFrame = (now: number) => {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(now);
};

const viewport = () =>
  ({
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
  }) as unknown as HTMLElement;

describe("createMissionEdgeScroll", () => {
  afterEach(() => {
    frames.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const start = () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.spyOn(performance, "now").mockReturnValue(0);
    return createMissionEdgeScroll({ threshold: { x: 0, y: 0.2 }, acceleration: 10 });
  };

  it("scrolls at dnd-kit's speed, faster the deeper the pointer is in the edge zone", () => {
    const scroll = start();
    const list = viewport();
    const onScroll = vi.fn();
    expect(scroll.edge(list, 50)).toBe(0);
    expect(scroll.edge(list, 10)).toBe(-1);
    scroll.hold(list, 100, onScroll);
    runFrame(5);
    expect(list.scrollTop).toBe(10);
    scroll.hold(list, 90, onScroll);
    runFrame(25);
    expect(list.scrollTop).toBe(30);
    expect(onScroll).toHaveBeenCalledTimes(2);
  });

  it("stops scrolling once stopped, and starts its timing again on the next hold", () => {
    const scroll = start();
    const list = viewport();
    scroll.hold(list, 100, () => {});
    scroll.stop();
    expect(frames.size).toBe(0);
    runFrame(5);
    expect(list.scrollTop).toBe(0);
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    scroll.hold(list, 100, () => {});
    runFrame(1_005);
    expect(list.scrollTop).toBe(10);
  });
});
