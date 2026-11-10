/**
 * Dashboard settings.
 *
 * Where the code (ROOT), the collected data (HOME), the job database, the
 * logs and the built web UI are,
 * and which command starts the job engine. Each can be overridden with an
 * IGDASH_* environment variable (tests do this).
 */
import { join, resolve } from "node:path";
import { layout, resolveDataHome } from "../paths";

export const ROOT = resolve(process.env.IGDASH_ROOT ?? resolve(import.meta.dir, "../.."));

/**
 * Where collected data, the job database and logs live. An explicit
 * IGDASH_ROOT keeps code and data together (tests run this way); otherwise
 * it is PATRONUM_HOME, defaulting to ~/Documents/patronum.
 */
export const HOME = resolve(process.env.IGDASH_HOME ?? (process.env.IGDASH_ROOT ? ROOT : resolveDataHome()));

export const DB_PATH = process.env.IGDASH_DB ?? join(HOME, layout.jobsDb);

export const LOG_ROOT = join(HOME, layout.jobLogs);

export const FRONTEND_DIR = resolve(process.env.IGDASH_FRONTEND_DIR ?? join(import.meta.dir, "dist"));

export const PORT = Number(process.env.IGDASH_PORT ?? 7799);

export const LAUNCH_DIR = process.env.IGDASH_LAUNCH_DIR ?? join(LOG_ROOT, "_launch");

export function parseIgflowCmd(): string[] {
  const raw = process.env.IGDASH_IGFLOW_CMD;
  if (!raw) return ["go", "run", "./cmd/igflow"];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string") || arr.length === 0) {
      throw new Error("IGDASH_IGFLOW_CMD must be a non-empty JSON string array");
    }
    return arr as string[];
  } catch (e) {
    throw new Error(`IGDASH_IGFLOW_CMD invalid: ${(e as Error).message}`);
  }
}

export const IGFLOW_CMD = parseIgflowCmd();
