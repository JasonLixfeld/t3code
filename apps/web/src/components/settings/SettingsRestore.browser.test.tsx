import { AuthOrchestrationOperateScope, type AuthEnvironmentScope } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useSettingsRestore } from "./SettingsPanels";

const state = vi.hoisted(() => ({
  mixedKeys: [] as ReadonlyArray<string>,
  operates: true,
  update: vi.fn(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useScopedSettingsMixed: (keys) => keys.some((key) => state.mixedKeys.includes(key)),
  useScopedSettingsWriteAllowed: (scope?: AuthEnvironmentScope) =>
    scope !== AuthOrchestrationOperateScope || state.operates,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ dialogs: { confirm: async () => true } })) as never,
}));

function Probe() {
  const restore = useSettingsRestore();
  return (
    <button type="button" onClick={() => void restore.restoreDefaults()}>
      {restore.changedSettingLabels.join(", ") || "Nothing to restore"}
    </button>
  );
}

it("resets a mission prompt another selected environment set, only with both scopes", async () => {
  state.mixedKeys = ["missionDefaultPrompt"];
  for (const operates of [true, false]) {
    state.operates = operates;
    state.update.mockClear();
    await using screen = await render(<Probe />);
    const button = screen.getByRole("button").element() as HTMLElement;
    expect(button.textContent).toBe(operates ? "Mission prompt" : "Nothing to restore");
    await act(() => button.click());
    await vi.waitFor(() =>
      expect(
        state.update.mock.calls.some(([patch]) => Object.hasOwn(patch, "missionDefaultPrompt")),
      ).toBe(operates),
    );
  }
});
