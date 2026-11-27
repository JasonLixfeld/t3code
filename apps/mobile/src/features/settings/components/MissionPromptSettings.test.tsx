import {
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SettingsTarget } from "../settings-environment-filter";

type InputProps = {
  defaultValue: string;
  placeholder: string;
  editable: boolean;
  onChangeText: (text: string) => void;
  onEndEditing: () => void;
};

const mocks = vi.hoisted(() => ({
  input: null as InputProps | null,
  reset: null as (() => void) | null,
  targets: [] as ReadonlyArray<unknown>,
  operable: true,
  advertised: null as ReadonlyArray<string> | null,
  write: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppTextInput: (props: InputProps) => {
    mocks.input = props;
    return null;
  },
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: { onPress: () => void }) => {
    mocks.reset = props.onPress;
    return null;
  },
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({ availableTargets: mocks.targets }),
}));
vi.mock("../useSettingsWriter", () => ({ useSettingsWriter: () => mocks.write }));
vi.mock("../../../state/missions", () => ({
  readMissionAdvertisers: () =>
    mocks.advertised ??
    (mocks.targets as ReadonlyArray<SettingsTarget>)
      .filter((target) => target.serverConfig.environment.capabilities.missions === true)
      .map((target) => target.environmentId),
}));
vi.mock("../../../state/session", () => ({
  useEnvironmentsWithScope: (
    environments: ReadonlyArray<{ environmentId: EnvironmentId }>,
    scope: string,
  ) =>
    new Set(
      scope === AuthOrchestrationOperateScope && !mocks.operable
        ? []
        : environments.map((environment) => environment.environmentId),
    ),
}));

import { MissionPromptSettings } from "./MissionPromptSettings";

const target = (id: string, missions: boolean, prompt = "") =>
  ({
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: { capabilities: { missions } },
      settings: { ...DEFAULT_SERVER_SETTINGS, missionDefaultPrompt: prompt },
      managedPolicy: undefined,
    },
  }) as unknown as SettingsTarget;

let root: Root;
const render = () => act(() => root.render(<MissionPromptSettings />));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  mocks.input = null;
  mocks.reset = null;
  mocks.operable = true;
  mocks.advertised = null;
  mocks.write.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("MissionPromptSettings", () => {
  it("saves the trimmed prompt to every machine that serves Missions", () => {
    mocks.targets = [target("desk", true), target("laptop", true), target("old", false)];
    render();
    expect(mocks.input).toMatchObject({ defaultValue: "", editable: true });
    expect(mocks.reset).toBeNull();

    mocks.input?.onChangeText("  Check the tests.  ");
    mocks.input?.onEndEditing();
    expect(mocks.write.mock.calls[0]?.[1]).toEqual([
      { environmentId: "desk", patch: { missionDefaultPrompt: "Check the tests." } },
      { environmentId: "laptop", patch: { missionDefaultPrompt: "Check the tests." } },
    ]);
  });

  it("resets a saved prompt to empty, and shows mixed prompts as mixed", () => {
    mocks.targets = [target("desk", true, "Ship it.")];
    render();
    expect(mocks.input?.defaultValue).toBe("Ship it.");
    mocks.reset?.();
    expect(mocks.write.mock.calls[0]?.[1]).toEqual([
      { environmentId: "desk", patch: { missionDefaultPrompt: "" } },
    ]);

    mocks.targets = [target("desk", true, "Ship it."), target("laptop", true)];
    render();
    expect(mocks.input?.placeholder).toBe(
      "Mixed. Enter a prompt to apply to all selected targets.",
    );
  });

  it.each([
    [
      "a server joins before it ends editing",
      [[target("desk", true)], [target("desk", true), target("laptop", true)]],
      null,
      true,
    ],
    [
      "the servers change and change back",
      [
        [target("desk", true)],
        [target("desk", true), target("laptop", true)],
        [target("desk", true)],
      ],
      null,
      false,
    ],
    [
      "the saved prompt changes and changes back",
      [[target("desk", true, "A")], [target("desk", true, "B")], [target("desk", true, "A")]],
      null,
      false,
    ],
    ["the last server offering Missions is gone", [[target("desk", true)]], [], false],
  ] as const)(
    "drops an edit for good once %s",
    (_name, [first, ...later], advertised, endsEditing) => {
      mocks.targets = first;
      render();
      mocks.input?.onChangeText("Mine");
      for (const targets of later) {
        mocks.targets = targets;
        render();
      }
      mocks.advertised = advertised;
      if (endsEditing) mocks.input?.onEndEditing();
      act(() => root.unmount());
      root = createRoot(document.createElement("div"));
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );

  it("is read-only without the right to operate, and hidden where no machine serves Missions", () => {
    mocks.targets = [target("desk", true, "Ship it.")];
    mocks.operable = false;
    render();
    expect(mocks.input?.editable).toBe(false);
    expect(mocks.reset).toBeNull();

    mocks.input = null;
    mocks.targets = [target("old", false)];
    render();
    expect(mocks.input).toBeNull();
  });
});
