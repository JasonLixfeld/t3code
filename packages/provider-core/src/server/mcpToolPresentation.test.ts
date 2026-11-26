import { describe, expect, it } from "@effect/vitest";
import { mcpToolPresentation } from "./mcpToolPresentation.ts";

describe("mcpToolPresentation", () => {
  it.each([
    "javascript:alert(1)",
    "file:///tmp/logo.png",
    "not a URL",
    "https://example.com/" + "x".repeat(4096),
  ])("ignores an invalid logo %s", (iconUrl) => {
    expect(
      mcpToolPresentation({
        serverName: "weather",
        toolName: "get_weather",
        iconUrl,
        title: "x".repeat(161),
      }),
    ).toEqual({
      title: "get weather",
      toolSource: { key: "mcp:weather", name: "weather", kind: "integration" },
    });
  });

  it.each(["t3_mission_roster", "t3_mission_add", "t3_mission_release", "t3_mission_tag"])(
    "leaves T3's own mission tool %s to the shared table, not its raw name",
    (tool) => {
      expect(mcpToolPresentation({ toolName: `mcp__t3-code__${tool}` })).toEqual({});
    },
  );
});
