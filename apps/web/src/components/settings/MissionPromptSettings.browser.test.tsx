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

it("defaults to no mission prompt, saves an edit trimmed, and resets to empty", async () => {
  expect(DEFAULT_UNIFIED_SETTINGS.missionDefaultPrompt).toBe("");
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
});

it("offers no edit or reset to a connection that may not operate tasks", async () => {
  state.prompt = "Review every pull request.";
  state.canOperate = false;
  await using screen = await render(<MissionPromptSettings />);
  await expect.element(page.getByRole("textbox", { name: "Mission prompt" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Reset mission prompt to default" }).query(),
  ).toBeNull();
});
