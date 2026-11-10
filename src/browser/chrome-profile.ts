import { existsSync, rmSync } from "node:fs";
import { resolveChromeProfileDir } from "./stagehand.js";

/**
 * Wipe the local Chrome user-data dir so the next run starts without
 * Instagram cookies (local equivalent of a fresh Browserbase context).
 */
export function clearChromeProfile(): void {
  const dir = resolveChromeProfileDir();
  if (!existsSync(dir)) {
    console.log(`[profile] no chrome profile at ${dir}`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`[profile] cleared ${dir}`);
}

export function chromeProfileExists(): boolean {
  return existsSync(resolveChromeProfileDir());
}
