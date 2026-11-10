import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clickMappedProfileAction, clickProfileTab, InstagramUiMap } from "./ui-map.js";

test("profile controls persist as handle-neutral templates and reject a wrong visible target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "patronum-ui-map-"));
  try {
    const path = join(dir, "ui-map.json");
    const first = new InstagramUiMap(path);
    first.remember("reels", 'a[href="/alpha/reels/"]', "alpha");
    expect(new InstagramUiMap(path).get("reels", "beta")).toBe('a[href="/beta/reels/"]');
    expect(readFileSync(path, "utf8")).not.toContain("alpha");

    const map = new InstagramUiMap(path);
    let linkPath = "/beta/reels/";
    const clicks: string[] = [];
    const link = { get href() { return `https://www.instagram.com${linkPath}`; } };
    const target = {
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
      getAttribute: () => "Reels",
      textContent: "Reels",
      closest: () => link,
    };
    const page = {
      evaluate: async <R>(expression: string): Promise<R> => Function(
        "document", "getComputedStyle", "location", "XPathResult",
        `return ${expression}`,
      )(
        { querySelector: () => target, evaluate: () => ({ singleNodeValue: target }) },
        () => ({ display: "block", visibility: "visible" }),
        { href: "https://www.instagram.com/beta/" },
        { FIRST_ORDERED_NODE_TYPE: 9 },
      ) as R,
      locator: (selector: string) => ({ click: async () => { clicks.push(selector); } }),
    };

    expect(await clickMappedProfileAction(page, map, "reels", "beta")).toBe(true);
    expect(clicks).toEqual(['a[href="/beta/reels/"]']);
    linkPath = "/other/reels/";
    expect(await clickMappedProfileAction(page, map, "reels", "beta")).toBe(false);
    expect(map.get("reels", "beta")).toBeNull();

    map.remember("reels", 'xpath=//a[@href="/alpha/reels/"]', "alpha");
    linkPath = "/beta/reels/";
    expect(await clickMappedProfileAction(page, map, "reels", "beta")).toBe(true);
    expect(clicks.at(-1)).toBe('xpath=//a[@href="/beta/reels/"]');

    const empty = new InstagramUiMap(join(dir, "empty.json"));
    expect(await clickProfileTab(page, empty, "posts", "beta")).toBe(false);
    expect(empty.get("posts", "beta")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
