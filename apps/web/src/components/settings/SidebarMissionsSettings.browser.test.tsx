import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { GeneralSettingsPanel } from "./SettingsPanels";

const update = vi.hoisted(() => vi.fn());

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => update,
}));

it("writes each sidebar mission switch to its own setting", async () => {
  await using screen = await render(<GeneralSettingsPanel />);
  for (const [label, key] of [
    ["Missions", "sidebarMissionsEnabled"],
    ["Missions heading", "sidebarMissionsHeaderVisible"],
    ["Threads heading", "sidebarThreadsHeaderVisible"],
  ] as const) {
    update.mockClear();
    const toggle = screen.getByRole("switch", { name: label, exact: true }).element();
    await act(() => (toggle as HTMLElement).click());
    expect(update).toHaveBeenCalledExactlyOnceWith({ [key]: false });
  }
});
