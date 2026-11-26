import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  // app.config.ts copies this into process.env, which would turn undefined into "undefined".
  loadRepoEnv: () =>
    Object.fromEntries(
      [
        "APP_VARIANT",
        "T3CODE_FORK_BUNDLE_ID",
        "T3CODE_FORK_TEAM_ID",
        "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
        "T3CODE_RELAY_URL",
      ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

function stubForkEnv(teamId: string | undefined) {
  vi.stubEnv("T3CODE_FORK_BUNDLE_ID", "io.example.t3fork");
  vi.stubEnv("T3CODE_FORK_TEAM_ID", teamId);
  vi.stubEnv("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_upstream");
  vi.stubEnv("T3CODE_RELAY_URL", "https://relay.example.com");
}

it("gives a fork build its own identity without T3's domains, updates, EAS project or cloud", async () => {
  stubForkEnv("ABCDE12345");
  const config = await loadConfig("production");
  expect(config.name).toBe("T3 Fork");
  expect(config.scheme).toBe("t3fork");
  expect(config.ios?.bundleIdentifier).toBe("io.example.t3fork");
  expect(config.ios?.appleTeamId).toBe("ABCDE12345");
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    "$(AppIdentifierPrefix)io.example.t3fork",
  ]);
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.updates).toEqual({ enabled: false });
  expect(config.owner).toBeUndefined();
  expect(config.extra?.eas?.projectId).toBeUndefined();
  expect(config.extra?.iosPersonalTeamBuild).toBe(true);
  expect(config.plugins).toContainEqual([
    "expo-notifications",
    expect.objectContaining({ enableRemoteNotifications: false }),
  ]);
  expect(config.plugins).toContainEqual(["expo-dev-client", { addGeneratedScheme: false }]);
  expect(config.extra?.clerk?.publishableKey).toBeNull();
  expect(config.extra?.relay?.url).toBeNull();
});

it.each([undefined, "abcde12345", "ABC"])(
  "rejects a fork build with T3CODE_FORK_TEAM_ID=%j",
  async (teamId) => {
    stubForkEnv(teamId);
    await expect(loadConfig("production")).rejects.toThrow("T3CODE_FORK_TEAM_ID");
  },
);
