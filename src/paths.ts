/**
 * Where things live on disk.
 *
 * There are two places:
 *
 *   the repository  code, node_modules, .env             REPO_ROOT, inRepo()
 *   the home        everything the app collects or saves  DATA_HOME, inHome()
 *
 * The home is ~/Documents/patronum unless PATRONUM_HOME says otherwise; on a
 * server, point PATRONUM_HOME at the data volume. `layout` names every file
 * and folder inside the home, once, relative to it.
 *
 * The Go side resolves the same home in internal/home and keeps the same
 * layout in internal/flow/job.go (ProfileJSONPath, MediaDir, UniqueDir,
 * AnalysisDir, KnowledgeDir); change both together.
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root. This file must stay directly in src/. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The variable an operator sets to choose where data lives. */
export const HOME_ENV = "PATRONUM_HOME";

/** ~/Documents/patronum */
export function defaultDataHome(): string {
  return join(homedir(), "Documents", "patronum");
}

/** The home folder for this environment: PATRONUM_HOME (a leading ~ is expanded) or the default. */
export function resolveDataHome(env: Record<string, string | undefined> = process.env): string {
  const value = env[HOME_ENV]?.trim();
  if (!value) return defaultDataHome();
  if (value === "~" || value.startsWith("~/")) return join(homedir(), value.slice(1));
  return resolve(value);
}

/** Absolute path of the home folder, fixed when the process starts. */
export const DATA_HOME = resolveDataHome();

export const layout = {
  // Sign-in
  chromeProfile: "data/chrome-profile",
  authCache: "cache/instagram-auth",
  captchaCaptures: "data/captcha/captures",
  captchaDiagnostics: "data/captcha/diagnostics",

  // Collect
  profilesDir: "data/profiles",
  profileJson: (handle: string) => `data/profiles/${handle}-profile.json`,
  uiMap: "cache/instagram-ui-map.json",

  // API map
  apiMap: "cache/instagram-api-map.json",
  networkDir: (handle: string) => `data/network/${handle}`,

  // Saved
  bookmarksDir: "data/bookmarks",
  bookmarkProgress: (handle: string) => `data/bookmarks/recommendations-${handle}.json`,

  // Media stages (written by the Go tools)
  mediaDir: (handle: string) => `data/media/${handle}`,
  mediaManifest: (handle: string) => `data/media/${handle}/manifest.json`,
  uniqueDir: (handle: string) => `data/${handle}-unique`,
  uniqueManifest: (handle: string) => `data/${handle}-unique/manifest.json`,
  analysisDir: (handle: string) => `data/analysis/${handle}`,
  analysisJson: (handle: string) => `data/analysis/${handle}/analysis.json`,
  analysisItemsDir: (handle: string) => `data/analysis/${handle}/items`,
  knowledgeDir: (handle: string) => `knowledge/clients/${handle}`,

  // Jobs and dashboard
  jobsDb: "data/dbos/patronum.sqlite",
  jobLogs: "data/dbos/logs",
  trinketExports: "data/trinket-exports",
  trinketExport: (handle: string) => `data/trinket-exports/${handle}.json`,
  dashboardSessions: "data/dashboard-sessions",
} as const;

/** Absolute path of a file that ships with the code (source, node_modules, .env). */
export function inRepo(relativePath: string): string {
  return resolve(REPO_ROOT, relativePath);
}

/** Absolute path of something the app collects or saves. `home` defaults to DATA_HOME. */
export function inHome(relativePath: string, home: string = DATA_HOME): string {
  return resolve(home, relativePath);
}
