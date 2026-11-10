import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Stagehand } from "@browserbasehq/stagehand";
import type { GridObservation } from "./recognition.js";
import { inHome, layout } from "../../paths.js";

type Page = ReturnType<Stagehand["context"]["pages"]>[number];
type FrameNode = { frame: { id: string; url: string }; childFrames?: FrameNode[] };
export interface CaptureResult {
  status: "captured" | "unavailable";
  reason: "image-grid" | "no-image-grid" | "capture-timeout" | "capture-failed" | "changing-grid";
  timestamp: string;
  observation?: GridObservation;
  fingerprints?: string[];
}

/** Read the currently visible grid; never opens the checkbox or invokes recognition. */
export async function observeCheckpoint(page: Page, options: { round?: number; previous?: { observation: GridObservation; fingerprints: string[] }; timeoutMs?: number } = {}): Promise<CaptureResult> {
  const timeoutMs = Math.min(10_000, Math.max(1, options.timeoutMs ?? 5000));
  const timestamp = new Date().toISOString();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unavailable = (reason: CaptureResult["reason"]): CaptureResult => ({ status: "unavailable", reason, timestamp });
  const capture = async (): Promise<CaptureResult> => {
    const frames: Array<{ id: string; url: string; parentId: string | null }> = [];
    const flatten = (node: FrameNode, parentId: string | null = null) => {
      frames.push({ id: node.frame.id, url: node.frame.url, parentId });
      for (const child of node.childFrames ?? []) flatten(child, node.frame.id);
    };
    flatten(page.getFullFrameTree() as FrameNode);
    for (const metadata of frames) {
      if (expired) return unavailable("capture-timeout");
      const frame = page.frameForId(metadata.id);
      try {
        const probe = () => frame.evaluate(() => {
          const grid = document.querySelector(".rc-imageselect-table-33, .rc-imageselect-table-44");
          if (!grid) return null;
          const bounds = grid.getBoundingClientRect();
          if (bounds.width < 90 || bounds.height < 90 || bounds.width > 1200 || bounds.height > 1200 || Math.abs(bounds.width - bounds.height) > 4 || getComputedStyle(grid).visibility === "hidden") return null;
          const cells = [...grid.querySelectorAll("td")];
          const gridSize = grid.classList.contains("rc-imageselect-table-44") ? 4 : 3;
          if (cells.length !== gridSize ** 2 || cells.some(cell => [...cell.querySelectorAll("img")].some(image => !image.complete || !image.naturalWidth))) return null;
          const target = document.querySelector(".rc-imageselect-desc-wrapper strong, .rc-imageselect-instructions strong")?.textContent?.trim();
          if (!target) return null;
          const signatures = cells.map(cell => [...cell.querySelectorAll("img")].map(image => [image.currentSrc, image.naturalWidth, image.naturalHeight, image.getAttribute("style")].join("|")).join(";"));
          if (signatures.some(value => !value)) return null;
          return { gridSize, target, signatures, rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
        });
        const before = await probe();
        if (!before) continue;
        let rect = { ...before.rect };
        let current = metadata;
        while (current.parentId) {
          const parent = frames.find(candidate => candidate.id === current.parentId);
          if (!parent) throw new Error("missing-parent");
          const session = page.frameForId(parent.id).session;
          const { backendNodeId } = await session.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: current.id });
          const { object } = await session.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId });
          let owner: { x: number; y: number; width: number; height: number } | null = null;
          try {
            const result = await session.send<{ result: { value: { x: number; y: number; width: number; height: number } | null } }>("Runtime.callFunctionOn", {
              objectId: object.objectId,
              functionDeclaration: `function() {
                const bounds = this.getBoundingClientRect();
                if (Math.abs(bounds.width - this.offsetWidth) > 2 || Math.abs(bounds.height - this.offsetHeight) > 2) return null;
                return { x: bounds.x + this.clientLeft, y: bounds.y + this.clientTop, width: this.clientWidth, height: this.clientHeight };
              }`,
              returnByValue: true,
            });
            owner = result.result.value;
          } finally { await session.send("Runtime.releaseObject", { objectId: object.objectId }); }
          if (!owner || rect.x < 0 || rect.y < 0 || rect.x + rect.width > owner.width + 2 || rect.y + rect.height > owner.height + 2) throw new Error("clip-outside-frame");
          rect.x += owner.x;
          rect.y += owner.y;
          current = parent;
        }
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollX, scrollY }));
        if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height) throw new Error("clip-outside-frame");
        if (expired) return unavailable("capture-timeout");
        const image = await page.screenshot({ type: "png", clip: { ...rect, x: rect.x + viewport.scrollX, y: rect.y + viewport.scrollY } });
        const after = await probe();
        if (!after || JSON.stringify(before) !== JSON.stringify(after)) return unavailable("changing-grid");
        const fingerprints = before.signatures.map(value => createHash("sha256").update(value).digest("hex"));
        const previous = options.previous;
        const sameChallenge = previous && previous.observation.gridSize === before.gridSize && previous.observation.target === before.target;
        const changedIndices = sameChallenge ? fingerprints.flatMap((value, index) => value !== previous.fingerprints[index] ? [index] : []) : [];
        const replacement = before.gridSize === 3 && sameChallenge && changedIndices.length > 0 && changedIndices.length < 9;
        return {
          status: "captured", reason: "image-grid", timestamp, fingerprints,
          observation: { id: randomUUID(), round: options.round ?? 0, capturedAt: timestamp, gridSize: before.gridSize as 3 | 4, kind: replacement ? "replacement" : before.gridSize === 4 ? "squares" : "selection", target: before.target, image: { mimeType: "image/png", dataBase64: image.toString("base64") }, ...(replacement ? { changedIndices } : {}) },
        };
      } catch { /* Detached, hidden, or clipped frames cannot supply a stable grid. */ }
    }
    return unavailable("no-image-grid");
  };
  try {
    return await Promise.race([capture(), new Promise<CaptureResult>(resolveResult => { timer = setTimeout(() => { expired = true; resolveResult(unavailable("capture-timeout")); }, timeoutMs); })]);
  } catch { return unavailable("capture-failed"); }
  finally { clearTimeout(timer); }
}

export async function saveCapture(result: CaptureResult, directory: string = inHome(layout.captchaCaptures)) {
  if (!result.observation || result.status !== "captured") return null;
  const folder = resolve(directory, `${result.timestamp.replace(/[:.]/g, "-")}-${result.observation.id}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, "observation.json"), JSON.stringify(result.observation), { mode: 0o600 });
  await writeFile(join(folder, "grid.png"), Buffer.from(result.observation.image.dataBase64, "base64"), { mode: 0o600 });
  const diagnostic = { timestamp: result.timestamp, status: result.status, reason: result.reason, observationId: result.observation.id, gridSize: result.observation.gridSize, round: result.observation.round, mode: "capture-only", recognitionRun: false, automaticSubmission: false };
  await writeFile(join(folder, "diagnostic.json"), JSON.stringify(diagnostic), { mode: 0o600 });
  return { ...diagnostic, artifactPath: folder };
}
