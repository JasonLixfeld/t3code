import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import {
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsPatch,
} from "../../hooks/useSettings";
import { GeneralSettingsPanel } from "./SettingsPanels";

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [], members: [] },
    environments: [],
    targets: [],
    target: undefined,
    deviceOnly: true,
  })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettingsMixed: () => false,
}));

const STORAGE_KEY = "t3code:client-settings:v1";
const storedBefore = localStorage.getItem(STORAGE_KEY);
const writesDone = () => persistClientSettingsPatch({});

it("saves each sidebar mission switch to its own client setting", async () => {
  const previous = getClientSettings();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  onTestFinished(async () => {
    await writesDone();
    if (storedBefore === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, storedBefore);
    __setClientSettingsForTests(previous);
  });
  await using screen = await render(<GeneralSettingsPanel />);
  for (const [label, key] of [
    ["Missions heading", "sidebarMissionsHeaderVisible"],
    ["Threads heading", "sidebarThreadsHeaderVisible"],
    ["Missions", "sidebarMissionsEnabled"],
  ] as const) {
    const toggle = screen.getByRole("switch", { name: label, exact: true });
    await act(() => (toggle.element() as HTMLElement).click());
    expect(getClientSettings()[key]).toBe(false);
    await expect.element(toggle).not.toBeChecked();
  }
  await writesDone();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({
    sidebarMissionsEnabled: false,
    sidebarMissionsHeaderVisible: false,
    sidebarThreadsHeaderVisible: false,
  });
});
