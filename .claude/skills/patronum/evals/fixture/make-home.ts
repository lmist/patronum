/**
 * Build the fixture home folder the eval cases run against.
 *
 *   bun make-home.ts <home-dir>
 *
 * It holds one failed job, one finished job and one half-finished profile
 * for the made-up handle `alpha_studio`, plus a finished `beta_prints`. No
 * real Instagram data, no credentials.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[2];
if (!home) throw new Error("usage: bun make-home.ts <home-dir>");

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const write = (path: string, value: unknown) => {
  mkdirSync(join(home, path, ".."), { recursive: true });
  writeFileSync(join(home, path), JSON.stringify(value, null, 2));
};

// ——— job database ———
mkdirSync(join(home, "data/dbos/logs"), { recursive: true });
const db = new Database(join(home, "data/dbos/patronum.sqlite"));
db.exec(`
  CREATE TABLE workflow_status (
    workflow_uuid TEXT PRIMARY KEY, status TEXT, name TEXT, request TEXT, output TEXT, error TEXT,
    executor_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, application_version TEXT,
    recovery_attempts INTEGER DEFAULT 0, queue_name TEXT, workflow_timeout_ms INTEGER,
    workflow_deadline_epoch_ms INTEGER, inputs TEXT, started_at_epoch_ms INTEGER, deduplication_id TEXT,
    forked_from TEXT, parent_workflow_id TEXT, completed_at INTEGER, application_name TEXT
  );
  CREATE TABLE operation_outputs (
    workflow_uuid TEXT NOT NULL, function_id INTEGER NOT NULL, function_name TEXT NOT NULL DEFAULT '',
    output TEXT, error TEXT, child_workflow_id TEXT, started_at_epoch_ms INTEGER, completed_at_epoch_ms INTEGER,
    PRIMARY KEY (workflow_uuid, function_id)
  );
  CREATE TABLE workflow_events (
    workflow_uuid TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (workflow_uuid, key)
  );
`);
const now = 1_794_000_000_000;
const FAILED = "ig:alpha_studio:1794000000";
const DONE = "ig:beta_prints:1793990000";
const job = db.query(`INSERT INTO workflow_status
  (workflow_uuid, status, name, queue_name, executor_id, application_version, application_name,
   created_at, updated_at, completed_at, started_at_epoch_ms, recovery_attempts, deduplication_id)
  VALUES (?, ?, 'ScrapeJob', 'ig-jobs', 'local', '0.1.0', 'patronum-igflow', ?, ?, ?, ?, 0, ?)`);
job.run(FAILED, "ERROR", now, now + 240_000, now + 240_000, now + 1_000, "alpha_studio");
job.run(DONE, "SUCCESS", now - 10_000_000, now - 9_400_000, now - 9_400_000, now - 9_999_000, "beta_prints");

const step = db.query(`INSERT INTO operation_outputs
  (workflow_uuid, function_id, function_name, output, error, started_at_epoch_ms, completed_at_epoch_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const VERIFY_ERROR = "verify: profile JSON has partial=true (checkpoint, not a finished scrape): 2 posts still need their media";
step.run(FAILED, 0, "preflight", b64({ ok: true }), null, now + 1_000, now + 4_000);
step.run(FAILED, 1, "scrape", b64({ ok: true, partial: true, counts: { posts: 5 } }), null, now + 4_000, now + 230_000);
step.run(FAILED, 2, "verify", null, b64(VERIFY_ERROR), now + 230_000, now + 240_000);
["preflight", "scrape", "verify", "download", "unique", "analyze"].forEach((name, index) =>
  step.run(DONE, index, name, b64({ ok: true }), null, now - 9_999_000 + index * 100_000, now - 9_900_000 + index * 100_000));

const event = db.query("INSERT INTO workflow_events (workflow_uuid, key, value) VALUES (?, ?, ?)");
event.run(FAILED, "stage", b64("verify"));
event.run(FAILED, "error", b64(VERIFY_ERROR));
event.run(DONE, "stage", b64("analyze"));
db.close();

mkdirSync(join(home, "data/dbos/logs", FAILED), { recursive: true });
writeFileSync(join(home, "data/dbos/logs", FAILED, "verify.log"),
  `[igflow:verify] [lifecycle] event=start\n[igflow:verify] [stderr] ${VERIFY_ERROR}\n[igflow:verify] [lifecycle] event=exit code=1\n`);

// ——— profiles ———
const post = (shortcode: string, finished: boolean) => ({
  shortcode, id: shortcode, type: "image", permalink: `https://www.instagram.com/p/${shortcode}/`,
  fromProfileGrid: true,
  mediaUrls: finished ? [`https://cdn.example.test/${shortcode}.jpg`] : [],
  thumbnailUrl: `https://cdn.example.test/${shortcode}_thumb.jpg`,
  caption: finished ? `Caption for ${shortcode}` : null,
  captionComplete: finished, mediaOwnershipVersion: finished ? 1 : undefined, metricsVersion: finished ? 1 : undefined,
  detailStatus: finished ? "complete" : "incomplete", detailSource: finished ? "embedded-json" : undefined,
});
write("data/profiles/alpha_studio-profile.json", {
  ok: true, partial: true, scrapedAt: "2026-11-08T10:04:00.000Z",
  sourceUrl: "https://www.instagram.com/alpha_studio", username: "alpha_studio",
  counts: { posts: 48, followers: 1200, following: 310 },
  posts: [post("AAA111", true), post("BBB222", true), post("CCC333", true), post("DDD444", false), post("EEE555", false)],
  reels: [], notes: ["2 detail item(s) remain incomplete; retry from saved checkpoint"],
  session: { authenticated: true, didLogin: false },
});
write("data/media/alpha_studio/manifest.json", { ok: true, files: [{ shortcode: "AAA111", localPath: "data/media/alpha_studio/AAA111/AAA111.jpg" }] });
write("data/profiles/beta_prints-profile.json", {
  ok: true, partial: false, scrapedAt: "2026-11-08T07:20:00.000Z",
  sourceUrl: "https://www.instagram.com/beta_prints", username: "beta_prints",
  counts: { posts: 2, followers: 90, following: 12 },
  posts: [post("FFF666", true), post("GGG777", true)], reels: [], notes: [],
  session: { authenticated: true, didLogin: false },
});
write("data/media/beta_prints/manifest.json", { ok: true, files: [] });
write("data/beta_prints-unique/manifest.json", { ok: true, stills: [], videos: [] });
write("data/analysis/beta_prints/analysis.json", { ok: true, items: [] });
mkdirSync(join(home, "data/chrome-profile"), { recursive: true });
console.log(home);
