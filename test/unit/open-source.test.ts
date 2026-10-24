import { describe, expect, it } from "vitest";
import channelLicense from "../../channel/LICENSE?raw";
import channelPackage from "../../channel/package.json?raw";
import license from "../../LICENSE?raw";
import rootPackage from "../../package.json?raw";
import security from "../../SECURITY.md?raw";
import trademarks from "../../TRADEMARKS.md?raw";
import wranglerRaw from "../../wrangler.jsonc?raw";

function config(): { vars: Record<string, string> } {
  return JSON.parse(
    wranglerRaw
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  );
}

describe("the open-source release", () => {
  it("licenses the server under the AGPL and the agent-side channel under MIT", () => {
    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 19 November 2007");
    expect(JSON.parse(rootPackage).license).toBe("AGPL-3.0-only");
    expect(channelLicense).toContain("MIT License");
    expect(channelLicense).toContain("Orsko");
    expect(JSON.parse(channelPackage).license).toBe("MIT");
  });

  it("says how to report a vulnerability privately, and keeps the name and marks out of the licence", () => {
    expect(security).toContain("security/advisories/new");
    expect(trademarks).toContain("not licensed");
  });

  it("keeps Orsko's analytics ids out of the committed config, so a fork never reports into them", () => {
    const vars = config().vars;
    expect(vars).not.toHaveProperty("POSTHOG_PROJECT_TOKEN");
    expect(vars).not.toHaveProperty("GA4_MEASUREMENT_ID");
    expect(wranglerRaw).not.toContain("phc_");
    expect(wranglerRaw).not.toContain("G-BMZS75YSKZ");
  });
});
