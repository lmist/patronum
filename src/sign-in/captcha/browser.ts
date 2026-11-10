import { createHash } from "node:crypto";
import type { Stagehand } from "@browserbasehq/stagehand";
import { observeCheckpoint, saveCapture } from "./capture.js";
import { refreshCheckpointFrames } from "./frames.js";
import { visionConfig } from "./config.js";
import { createTileAgentsBackend } from "./tile-agents.js";
import { CaptchaSolveError, solveChallenge, type ChallengeDriver, type ChallengeState } from "./solver.js";

type Page = ReturnType<Stagehand["context"]["pages"]>[number];
const gridSelector = ".rc-imageselect-table-33, .rc-imageselect-table-44";

export function createChallengeDriver(page: Page): ChallengeDriver {
  const beganOnInstagram = new URL(page.url()).hostname === "www.instagram.com";
  let gridFrame: string | null = null, checkboxFrame: string | null = null;
  const inspect = async (round: number): Promise<ChallengeState> => {
    const url = new URL(page.url());
    if (beganOnInstagram && url.hostname === "www.instagram.com" && (/^\/auth_platform\/codeentry\//.test(url.pathname) || /^\/accounts\/login\/two_factor/.test(url.pathname) || url.pathname === "/")) return { kind: "solved" };
    await refreshCheckpointFrames(page);
    let checkbox = false, checked = false;
    gridFrame = null;
    const frames: string[] = [];
    const flatten = (node: { frame: { id: string }; childFrames?: any[] }) => { frames.push(node.frame.id); for (const child of node.childFrames ?? []) flatten(child); };
    flatten(page.getFullFrameTree());
    for (const frameId of frames) {
      const frame = page.frameForId(frameId);
      try {
        const probe = await frame.evaluate(() => {
          const visible = (element: Element | null) => !!element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== "hidden";
          const anchor = document.querySelector("#recaptcha-anchor");
          const grid = document.querySelector(".rc-imageselect-table-33, .rc-imageselect-table-44");
          const blocked = document.querySelector(".rc-doscaptcha-header-text, .rc-doscaptcha-body-text");
          return {
            checkbox: visible(anchor), checked: anchor?.getAttribute("aria-checked") === "true",
            grid: visible(grid), blocked: visible(blocked),
            dynamic: /once there are none left|new images|keep selecting/i.test(document.querySelector(".rc-imageselect-desc-wrapper")?.textContent ?? ""),
          };
        });
        if (probe.blocked) return { kind: "blocked", reason: "provider-blocked" };
        if (probe.checkbox) { checkbox = true; checkboxFrame = frameId; checked ||= probe.checked; }
        if (checked) return { kind: "solved" };
        if (probe.grid) {
          gridFrame = frameId;
          const capture = await observeCheckpoint(page, { round });
          if (!capture.observation || !capture.fingerprints) continue;
          const fingerprint = createHash("sha256").update(JSON.stringify([capture.observation.target, capture.observation.gridSize, capture.fingerprints])).digest("hex");
          return { kind: "grid", observation: capture.observation, fingerprint, dynamic: probe.dynamic };
        }
      } catch { /* Navigation can detach challenge frames. */ }
    }
    if (checked) return { kind: "solved" };
    if (checkbox) return { kind: "checkbox" };
    return { kind: "waiting" };
  };
  return {
    inspect,
    async open() {
      if (!checkboxFrame) throw new Error("CAPTCHA checkbox is unavailable");
      await page.frameForId(checkboxFrame).locator("#recaptcha-anchor").click();
    },
    async select(indices, fingerprint) {
      const current = await inspect(0);
      if (current.kind !== "grid" || current.fingerprint !== fingerprint || !gridFrame) return false;
      const frame = page.frameForId(gridFrame);
      for (const index of indices) {
        const selected = await frame.evaluate((i: number) => document.querySelectorAll(".rc-imageselect-table-33 td, .rc-imageselect-table-44 td")[i]?.classList.contains("rc-imageselect-tileselected"), index);
        if (!selected) await frame.locator(`${gridSelector.split(", ").map(selector => `${selector} td`).join(", ")}`).nth(index).click();
      }
      return true;
    },
    async verify() {
      if (!gridFrame) throw new Error("CAPTCHA grid is unavailable");
      await page.frameForId(gridFrame).locator("#recaptcha-verify-button").click();
    },
    async wait() { await Bun.sleep(750); },
  };
}

export async function solveBrowserChallenge(page: Page) {
  const log = (event: Record<string, unknown>) => console.log(`[captcha] ${JSON.stringify(event)}`);
  log({ phase: "solve", status: "started", backend: "tile-agents" });
  const started = performance.now();
  const result = await solveChallenge(createChallengeDriver(page), createTileAgentsBackend(visionConfig(), { onTile: timing => log({ phase: "tile", ...timing }) }), { log });
  log({ phase: "solve", ...result, elapsedMs: Math.round(performance.now() - started) });
  if (result.status !== "solved") {
    const artifact = await saveCapture(await observeCheckpoint(page));
    if (artifact) log({ phase: "capture", artifactPath: artifact.artifactPath });
    throw new CaptchaSolveError(result);
  }
  return result;
}
