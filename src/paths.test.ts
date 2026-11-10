import { describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_HOME, REPO_ROOT, defaultDataHome, inHome, inRepo, layout, resolveDataHome } from "./paths.js";

describe("data home", () => {
  it("defaults to ~/Documents/patronum", () => {
    expect(resolveDataHome({})).toBe(join(homedir(), "Documents", "patronum"));
    expect(resolveDataHome({ PATRONUM_HOME: "  " })).toBe(defaultDataHome());
  });

  it("follows PATRONUM_HOME, expanding a leading ~ and resolving relative paths", () => {
    expect(resolveDataHome({ PATRONUM_HOME: "/srv/patronum" })).toBe("/srv/patronum");
    expect(resolveDataHome({ PATRONUM_HOME: "~/srv/patronum" })).toBe(join(homedir(), "srv", "patronum"));
    expect(resolveDataHome({ PATRONUM_HOME: "relative/home" })).toBe(resolve("relative/home"));
  });

  it("keeps collected files in the home and code files in the repository", () => {
    expect(inHome(layout.profileJson("some_handle"))).toBe(join(DATA_HOME, "data/profiles/some_handle-profile.json"));
    expect(inHome(layout.apiMap, "/srv/patronum")).toBe("/srv/patronum/cache/instagram-api-map.json");
    expect(inRepo("src/cmd/cli.ts")).toBe(join(REPO_ROOT, "src/cmd/cli.ts"));
  });

  it("runs tests in a throwaway home, never the operator's", () => {
    expect(DATA_HOME.startsWith(resolve(tmpdir())) || DATA_HOME.includes("patronum-test-home-")).toBe(true);
    expect(DATA_HOME).not.toBe(defaultDataHome());
  });
});
