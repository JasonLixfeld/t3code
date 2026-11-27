import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  prompt: "",
  canOperate: true,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    missionDefaultPrompt: state.prompt,
  })) as never,
  useScopedSettingsMixed: () => false,
  useScopedSettingsWriteAllowed: () => state.canOperate,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({ targets: [] })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({ resetAction, children }: { resetAction: ReactNode; children: ReactNode }) => (
    <div>
      {resetAction}
      {children}
    </div>
  )) as never,
}));

import { MissionPromptSettings } from "./MissionPromptSettings";

it("saves an edit trimmed, resets to empty, and offers neither without the operate grant", async () => {
  state.prompt = "";
  state.canOperate = true;
  await using screen = await render(<MissionPromptSettings />);
  expect(
    screen.getByRole("button", { name: "Reset mission prompt to default" }).query(),
  ).toBeNull();
  const textarea = page.getByRole("textbox", { name: "Mission prompt" });
  await userEvent.fill(textarea, "  Review every pull request.  ");
  await userEvent.click(document.body);
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
    missionDefaultPrompt: "Review every pull request.",
  });

  state.updateSettings.mockClear();
  state.prompt = "Review every pull request.";
  await screen.rerender(<MissionPromptSettings />);
  await page.getByRole("button", { name: "Reset mission prompt to default" }).click();
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({ missionDefaultPrompt: "" });

  state.canOperate = false;
  await screen.rerender(<MissionPromptSettings />);
  await expect.element(textarea).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Reset mission prompt to default" }).query(),
  ).toBeNull();
});
