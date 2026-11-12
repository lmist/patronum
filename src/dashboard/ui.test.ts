// Real UI tests: boot igdash, drive it with agent-browser, assert what a human sees.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync, cpSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const TMP = resolve(import.meta.dir, ".test-ui");
const DBDIR = join(TMP, "data/dbos");
const DB_PATH = join(DBDIR, "patronum.sqlite");
const LAUNCH_DIR = join(DBDIR, "logs/_launch");
const SERVER = resolve(import.meta.dir, "server.ts");
const FIXTURE = join(TMP, "igflow-fixture.ts");
const CAPTCHA_FIXTURE = join(TMP,"captcha-fixture.ts");
const PORT = 17991;
const UI_PATH = process.env.IGDASH_UI_PATH ?? "/";
const MODERN_UI = process.env.IGDASH_LEGACY_UI !== "1";
const EVIDENCE = resolve(import.meta.dir, process.env.IGDASH_QA_DIR ?? "../../data/qa/dashboard");
mkdirSync(EVIDENCE, { recursive: true });
const SESSION = `igdash-ui-${process.pid}`;
const AB = "agent-browser";
const PATH_WITH_AB = `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`;

function b64(s: string) {
  return Buffer.from(s, "utf8").toString("base64");
}

function seedDb(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE workflow_status (
      workflow_uuid TEXT PRIMARY KEY, status TEXT, name TEXT,
      authenticated_user TEXT, assumed_role TEXT, authenticated_roles TEXT,
      request TEXT, output TEXT, error TEXT, executor_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      application_version TEXT, application_id TEXT,
      class_name TEXT, config_name TEXT, recovery_attempts INTEGER DEFAULT 0,
      queue_name TEXT, workflow_timeout_ms INTEGER, workflow_deadline_epoch_ms INTEGER,
      inputs TEXT, started_at_epoch_ms INTEGER, deduplication_id TEXT,
      priority INTEGER NOT NULL DEFAULT 0, queue_partition_key TEXT,
      forked_from TEXT, owner_xid TEXT, parent_workflow_id TEXT,
      serialization TEXT, delay_until_epoch_ms INTEGER,
      was_forked_from INTEGER NOT NULL DEFAULT 0, rate_limited INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER, attributes TEXT, schedule_name TEXT,
      debounce_deadline_epoch_ms INTEGER, is_debounced INTEGER NOT NULL DEFAULT 0,
      application_name TEXT
    );
    CREATE TABLE operation_outputs (
      workflow_uuid TEXT NOT NULL, function_id INTEGER NOT NULL,
      function_name TEXT NOT NULL DEFAULT '', output TEXT, error TEXT,
      child_workflow_id TEXT, started_at_epoch_ms INTEGER, completed_at_epoch_ms INTEGER,
      serialization TEXT, application_name TEXT,
      PRIMARY KEY (workflow_uuid, function_id)
    );
    CREATE TABLE workflow_events (
      workflow_uuid TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      serialization TEXT, PRIMARY KEY (workflow_uuid, key)
    );
    CREATE TABLE workflow_events_history (
      workflow_uuid TEXT NOT NULL, function_id INTEGER NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL, serialization TEXT,
      PRIMARY KEY (workflow_uuid, function_id, key)
    );
    CREATE TABLE streams (
      workflow_uuid TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      "offset" INTEGER NOT NULL, function_id INTEGER NOT NULL DEFAULT 0,
      serialization TEXT,
      PRIMARY KEY (workflow_uuid, key, "offset")
    );
    CREATE TABLE queues (
      queue_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      concurrency INTEGER, worker_concurrency INTEGER,
      rate_limit_max INTEGER, rate_limit_period_sec REAL,
      priority_enabled INTEGER NOT NULL DEFAULT 0,
      partition_queue INTEGER NOT NULL DEFAULT 0,
      polling_interval_sec REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      application_name TEXT
    );
    CREATE TABLE application_versions (
      version_id TEXT PRIMARY KEY, version_name TEXT NOT NULL,
      version_timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL,
      application_name TEXT
    );
  `);
  const now = 1_757_100_000_000;
  db.query(`INSERT INTO queues (queue_id, name, concurrency, worker_concurrency, polling_interval_sec, created_at, updated_at)
            VALUES ('q1','ig-jobs',NULL,NULL,1.0,?,?),('q2','ig-scrape',1,NULL,1.0,?,?),
                   ('q3','ig-download',NULL,8,1.0,?,?),('q4','ig-analyze',NULL,4,1.0,?,?)`).run(
    now, now, now, now, now, now, now, now,
  );
  db.query(`INSERT INTO workflow_status
    (workflow_uuid, status, name, queue_name, executor_id, application_version, application_name,
     created_at, updated_at, completed_at, started_at_epoch_ms, recovery_attempts, deduplication_id)
    VALUES (?, 'ERROR','ScrapeJob','ig-jobs','local','0.1.0','patronum-igflow',
            ?, ?, ?, ?, 1, 'tbrushlb')`).run(
    "ig:tbrushlb:1788644068", now, now + 3000, now + 3000, now,
  );
  db.query(`INSERT INTO workflow_status
    (workflow_uuid, status, name, queue_name, executor_id, application_version, application_name,
     created_at, updated_at, completed_at, started_at_epoch_ms, recovery_attempts, deduplication_id)
    VALUES (?, 'SUCCESS','ScrapeJob','ig-jobs','local','0.1.0','patronum-igflow',
            ?, ?, ?, ?, 0, 'prettydios')`).run(
    "ig:prettydios:1788600000", now - 60_000, now - 10_000, now - 10_000, now - 55_000,
  );

  const gob = Buffer.from("flow.CLIError\x00preflight-llm\x00quota-exhausted").toString("base64");
  const insOp = db.query(`INSERT INTO operation_outputs
    (workflow_uuid, function_id, function_name, output, error, started_at_epoch_ms, completed_at_epoch_ms)
    VALUES (?,?,?,?,?,?,?)`);
  insOp.run("ig:tbrushlb:1788644068", 0, "resolveRepoRoot", JSON.stringify("/tmp/x"), null, now, now + 1);
  insOp.run("ig:tbrushlb:1788644068", 1, "DBOS.setEvent", JSON.stringify(null), null, now + 1, now + 2);
  insOp.run("ig:tbrushlb:1788644068", 2, "DBOS.writeStream", null, null, now + 2, now + 3);
  insOp.run("ig:tbrushlb:1788644068", 3, "preflight", null, gob, now + 10, now + 3000);
  insOp.run("ig:tbrushlb:1788644068", 4, "DBOS.closeStream", null, null, now + 3000, now + 3001);
  insOp.run("ig:prettydios:1788600000", 0, "scrape", JSON.stringify({ ok: true, counts: { posts: 3 } }), null, now - 50_000, now - 20_000);
  insOp.run("ig:prettydios:1788600000", 1, "verify", JSON.stringify({ real: true }), null, now - 20_000, now - 10_000);
  insOp.run("ig:prettydios:1788600000", 2, "knowledge", JSON.stringify({
    ok: true,
    handle: "prettydios",
    dir: "knowledge/clients/prettydios",
    indexPath: "knowledge/clients/prettydios/INDEX.md",
    docs: ["knowledge/clients/prettydios/INDEX.md"],
    inputHash: "a".repeat(64),
  }), null, now - 10_000, now - 9_000);

  db.query(`INSERT INTO workflow_events (workflow_uuid, key, value) VALUES (?,?,?),(?,?,?),(?,?,?)`).run(
    "ig:tbrushlb:1788644068", "stage", b64(JSON.stringify("preflight")),
    "ig:tbrushlb:1788644068", "progress", b64(JSON.stringify({ stage: "preflight", done: 0, total: 7 })),
    "ig:tbrushlb:1788644068", "error", b64(JSON.stringify("llm: preflight failed — fix QWEN_API_KEY")),
  );
  db.query(`INSERT INTO streams (workflow_uuid, key, value, "offset", function_id) VALUES (?,?,?,0,3),(?,?,?,1,3)`).run(
    "ig:tbrushlb:1788644068", "log", b64(JSON.stringify("stage=preflight done=0 total=7")),
    "ig:tbrushlb:1788644068", "log", b64(JSON.stringify("error llm: preflight failed")),
  );
  db.close();
}

function writeFixture() {
  const script = `#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
const db = new Database(${JSON.stringify(DB_PATH)});
db.exec("PRAGMA busy_timeout=5000");
const args = process.argv.slice(2);
const verb = args.shift();
const option = (name) => args[args.indexOf(name) + 1];
const id = verb === "run" ? option("--workflow-id") : args[0];
const handle = verb === "run" ? option("--handle") : id?.split(":")[1];
const stages = ["preflight","scrape","verify","download","unique","analyze","knowledge"];
const now = Date.now();
console.log(JSON.stringify({event:"fixture.start",verb,args}));
if (verb === "gc") { console.log(JSON.stringify({ok:true,dryRun:args.includes("--dry-run"),workflowIds:["fixture-old-history"]})); process.exit(0); }
function event(stage, i, error) {
  const message = error || "STEP_PASS " + stage + " done=" + (i+1) + " total=7";
  db.query("INSERT OR REPLACE INTO workflow_events(workflow_uuid,key,value) VALUES(?,?,?)").run(id,"stage",Buffer.from(JSON.stringify(stage)).toString("base64"));
  db.query("INSERT OR REPLACE INTO workflow_events(workflow_uuid,key,value) VALUES(?,?,?)").run(id,"progress",Buffer.from(JSON.stringify({stage,done:i+1,total:7})).toString("base64"));
  db.query('INSERT OR REPLACE INTO streams(workflow_uuid,key,value,"offset",function_id) VALUES(?,?,?,?,?)').run(id,"log",Buffer.from(JSON.stringify(message)).toString("base64"),i,i);
  const dir = ${JSON.stringify(join(DBDIR, "logs"))} + "/" + id;
  mkdirSync(dir,{recursive:true});
  appendFileSync(dir + "/" + stage + ".log", message + "\\n");
  console.log(message);
}
function stage(i, error) {
  const name = stages[i];
  db.query("INSERT OR REPLACE INTO operation_outputs(workflow_uuid,function_id,function_name,output,error,started_at_epoch_ms,completed_at_epoch_ms) VALUES(?,?,?,?,?,?,?)").run(id,i,name,error?null:JSON.stringify({ok:true,counts:{posts:3}}),error?Buffer.from(error).toString("base64"):null,now+i*10,now+i*10+5);
  event(name,i,error);
}
if (verb === "cancel") {
  db.query("UPDATE workflow_status SET status='CANCELLED',updated_at=? WHERE workflow_uuid=?").run(now,id);
} else if (verb === "run" || verb === "resume") {
  if (verb === "run") db.query("INSERT INTO workflow_status(workflow_uuid,status,name,queue_name,created_at,updated_at,started_at_epoch_ms,deduplication_id) VALUES(?,'PENDING','ScrapeJob','ig-jobs',?,?,?,?)").run(id,now,now,now,handle);
  if (handle === "qa_missing" && verb === "run") {
    stage(0,"Missing QWEN_API_KEY. Configure the API key, then resume this run.");
    db.query("INSERT OR REPLACE INTO workflow_events(workflow_uuid,key,value) VALUES(?,?,?)").run(id,"error",Buffer.from(JSON.stringify("Missing QWEN_API_KEY. Configure the API key, then resume this run.")).toString("base64"));
    db.query("UPDATE workflow_status SET status='ERROR',updated_at=? WHERE workflow_uuid=?").run(Date.now(),id);
    process.exit(5);
  }
  if (verb === "resume") {
    db.query("DELETE FROM workflow_events WHERE workflow_uuid=? AND key='error'").run(id);
    db.query("UPDATE workflow_status SET status='PENDING',updated_at=? WHERE workflow_uuid=?").run(now,id);
  }
  stage(0);
  if (handle === "qa_run" || handle === "qa_cancel") {
    event("scrape",0);
    while (!existsSync(${JSON.stringify(TMP)} + "/continue-" + handle)) {
      if (db.query("SELECT status FROM workflow_status WHERE workflow_uuid=?").get(id)?.status === "CANCELLED") process.exit(0);
      await Bun.sleep(100);
    }
  }
  for (let i=1; i<7; i++) stage(i);
  db.query("UPDATE workflow_status SET status='SUCCESS',updated_at=?,completed_at=? WHERE workflow_uuid=?").run(Date.now(),Date.now(),id);
}
console.log(JSON.stringify({ok:true,workflowId:id}));
db.close();
`;
  writeFileSync(FIXTURE, script, { mode: 0o755 });
}

let serverProc: ChildProcess | null = null;
let baseUrl = "";

function reveal(target: string) {
  if (!MODERN_UI) return;
  const account = /#(?:auth-|captcha-|action-)/.test(target);
  const collection = /#(?:run-|filter|wf-list)|data-view/.test(target);
  const section = account ? "account" : collection ? "collections" : null;
  if (section && ab(["eval", `document.querySelector('#nav-${section}')?.getAttribute('aria-current')`]) !== '"page"') ab(["click", "#nav-" + section]);
  const open = (selector: string) => { if (ab(["eval", `document.querySelector('${selector}')?.open === false`]) === "true") ab(["click", selector + " > summary"]); };
  if (/#run-/.test(target) && ab(["eval", "document.querySelector('#new-collection-disclosure')?.open === false"]) === "true") { open("#job-sidebar-list"); ab(["click", "#new-job"]); }
  if (/#run-(session|skip-reels|publish-wiki)/.test(target)) open("#collection-settings");
  if (/#filter|#wf-list/.test(target)) open("#job-sidebar-list");
}

function ab(args: string[], opts?: { input?: string }): string {
  if (["click", "dblclick", "check", "select", "focus", "fill"].includes(args[0]!)) reveal(args[1]!);
  if (["click", "dblclick", "check", "select", "focus"].includes(args[0]!)) ab(["scrollintoview", args[1]!]);
  const r = spawnSync(AB, ["--session", SESSION, ...args], {
    encoding: "utf8",
    input: opts?.input,
    env: { ...process.env, PATH: PATH_WITH_AB },
    timeout: args[0] === "open" ? 30000 : 8000,
  });
  appendFileSync(join(EVIDENCE, "steps.jsonl"), JSON.stringify({ts: new Date().toISOString(), status:r.status === 0 ? "STEP_PASS":"STEP_FAIL", command:args[0], args:args[0] === "eval" ? ["DOM assertion"] : args.slice(1), output: (r.stdout ?? "").slice(0,2000), error:r.stderr}) + "\n");
  if (r.status !== 0) {
    throw new Error(`agent-browser ${args.join(" ")} → ${r.status}\n${r.stderr}\n${r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

function page() {
  const out = ab(["eval", "--stdin"], {
    input: `({
      title: document.title,
      runPlaceholder: document.querySelector("#run-handle")?.getAttribute("placeholder"),
      runBtn: document.querySelector("#run-btn")?.textContent,
      skipReels: document.querySelector("#collection-media")?.value === "images",
      publishWiki: document.querySelector("#run-publish-wiki")?.checked,
      cmdbar: document.querySelector("#cmdbar"),
      list: Array.from(document.querySelectorAll("#wf-list li")).map(li => li.innerText.replace(/\\s+/g," ").trim()),
      emptyList: document.querySelector("#list-empty")?.hidden,
      emptyDetail: document.querySelector("#detail-empty")?.hidden,
      bodyHidden: !document.querySelector("#detail-body") || document.querySelector("#detail-body")?.hidden,
      wfId: document.querySelector("#wf-id")?.innerText,
      banner: document.querySelector("#error-banner")?.innerText,
      bannerHidden: document.querySelector("#error-banner")?.hidden,
      rail: document.querySelector("#pipeline-rail")?.innerText.replace(/\\s+/g," ").trim(),
      stageNames: Array.from(document.querySelectorAll("#pipeline-rail .sname")).map(el => el.textContent?.trim().toLowerCase()),
      steps: Array.from(document.querySelectorAll("#timeline li")).map(li => li.textContent.replace(/\\s+/g," ").trim()),
      resumeHidden: document.querySelector("#btn-resume")?.hidden,
      cancelHidden: document.querySelector("#btn-cancel")?.hidden,
      runStatus: document.querySelector("#run-status")?.innerText || document.querySelector("#launch-status")?.innerText,
      queues: document.querySelector("#strip-queues")?.textContent.replace(/\\s+/g," ").trim(),
    })`,
  });
  try { return JSON.parse(out); } catch {
    // agent-browser may wrap as a JS object dump
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(out.slice(start, end + 1));
    throw new Error(`eval not JSON: ${out.slice(0, 400)}`);
  }
}

async function waitFor<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < ms) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor timed out: ${JSON.stringify(last)?.slice(0, 400)}`);
}

function uiTest(name: string, run: () => void | Promise<void>, timeout = 20_000) {
  it(name, async () => {
    appendFileSync(join(EVIDENCE,"steps.jsonl"), JSON.stringify({ts:new Date().toISOString(),status:"STEP_START",scenario:name}) + "\n");
    try {
      await run();
      appendFileSync(join(EVIDENCE,"steps.jsonl"), JSON.stringify({ts:new Date().toISOString(),status:"STEP_PASS",scenario:name}) + "\n");
    } catch (error) {
      const screenshot = join(EVIDENCE, name.toLowerCase().replace(/[^a-z0-9]+/g,"-") + "-failure.png");
      try { ab(["screenshot", screenshot, "--full"]); } catch {}
      appendFileSync(join(EVIDENCE,"steps.jsonl"), JSON.stringify({ts:new Date().toISOString(),status:"STEP_FAIL",scenario:name,error:String(error),screenshot}) + "\n");
      throw error;
    }
  }, timeout);
}

describe("igdash UI — agent-browser", () => {
  beforeAll(async () => {
    const which = spawnSync("which", [AB], { encoding: "utf8", env: { ...process.env, PATH: PATH_WITH_AB } });
    if (which.status !== 0) {
      throw new Error("agent-browser not on PATH; install it to run real UI tests");
    }
    mkdirSync(EVIDENCE, { recursive: true });
    appendFileSync(join(EVIDENCE, "steps.jsonl"), JSON.stringify({event:"suite.start",ts:new Date().toISOString()}) + "\n");
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(DBDIR, { recursive: true });
    mkdirSync(LAUNCH_DIR, { recursive: true });
    mkdirSync(join(DBDIR, "logs/_dash"), { recursive: true });
    seedDb(DB_PATH);
    for (const path of ["data/media/qa_run/POST1", "data/analysis/qa_run/items", "knowledge/clients/qa_run"]) mkdirSync(join(TMP,path),{recursive:true});
    writeFileSync(join(TMP,"data/media/qa_run/POST1/image.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAAJElEQVR4nGM4uziLpohh1IJRC0YtGLVg1IJRC0YtGLVgaFgAAFUUjkxThne+AAAAAElFTkSuQmCC","base64"));
    writeFileSync(join(TMP,"data/analysis/qa_run/items/POST1.json"),JSON.stringify({shortcode:"POST1",summary:"Warm colors and clear typography"}));
    writeFileSync(join(TMP,"knowledge/clients/qa_run/INDEX.md"),"# QA client\n\n[Post 1](POSTS.md)\n");
    writeFileSync(join(TMP,"knowledge/clients/qa_run/POSTS.md"),"# Posts\n\n## POST1\n\nWarm colors and clear typography.\n");
    const fixtureDb = new Database(DB_PATH);
    for(const handle of ["qa_large","qa_empty","qa_thirteen"]) fixtureDb.query("INSERT INTO workflow_status(workflow_uuid,status,name,queue_name,created_at,updated_at,completed_at,deduplication_id) VALUES(?,'SUCCESS','ScrapeJob','ig-jobs',1,2,2,?)").run("ig:"+handle+":100",handle);
    fixtureDb.close();
    const image = readFileSync(join(TMP,"data/media/qa_run/POST1/image.png"));
    for(const [handle,count] of [["qa_large",100],["qa_thirteen",13]] as const){
      for(let i=0;i<count;i++){
        const id=i===0?"DIMO0SkIKK_":"POST"+String(i).padStart(3,"0");
        const dir=join(TMP,"data/media",handle,id);mkdirSync(dir,{recursive:true});
        for(let j=0;j<(handle==="qa_large"?20:1);j++)writeFileSync(join(dir,j+".png"),image);
        const analysis=join(TMP,"data/analysis",handle,"items");mkdirSync(analysis,{recursive:true});
        writeFileSync(join(analysis,id+"__still.json"),JSON.stringify({shortcode:id,summary:"Fixture analysis " + i}));
      }
      writeFileSync(join(TMP,"data/media",handle,"manifest.json"),"{}");
    }
    writeFixture();
    writeFileSync(CAPTCHA_FIXTURE, `console.log(JSON.stringify({ok:true,recognition:{status:"proposed",selectedIndices:[0,4,7]},diagnosticUrl:"/api/file?path=data%2Fcaptcha%2Fdiagnostics%2Fui-proposal.json"}));`);
    const fixtureEnv = { ...process.env };
    for (const key of ["CAPTCHA_VISION_BASE_URL","CAPTCHA_VISION_API_KEY","CAPTCHA_VISION_MODEL"]) delete fixtureEnv[key];

    await new Promise<void>((res, rej) => {
      const proc = spawn(process.execPath, [SERVER], {
        env: {
          ...fixtureEnv,
          QWEN_API_KEY: "fixture-not-a-real-key",
          IGDASH_CAPTCHA_CMD: JSON.stringify([process.execPath,CAPTCHA_FIXTURE]),
          IGDASH_AUTH_CMD: JSON.stringify([process.execPath,resolve(import.meta.dir,"control-fixture.ts")]),
          IGDASH_ROOT: TMP,
          IGDASH_PORT: String(PORT),
          IGDASH_IGFLOW_CMD: JSON.stringify([process.execPath, FIXTURE]),
          IGDASH_LAUNCH_DIR: LAUNCH_DIR,
          IGDASH_LOG_LEVEL: "info",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      serverProc = proc;
      let done = false;
      proc.stdout!.on("data", (b) => {
        const s = String(b);
        const m = s.match(/^https?:\/\/[0-9A-Za-z.:]+\/?$/m);
        if (m && !done) { done = true; baseUrl = m[0].trim().replace(/\/$/, ""); res(); }
      });
      proc.stderr!.on("data", (b) => appendFileSync(join(EVIDENCE,"server.jsonl"),b));
      proc.on("exit", (code) => { if (!done) rej(new Error(`server exit ${code}`)); });
      setTimeout(() => { if (!done) rej(new Error("server never printed url")); }, 5000);
    });
    spawnSync(AB, ["--session", SESSION, "close"], { env: { ...process.env, PATH: PATH_WITH_AB } });
    ab(["open", baseUrl + UI_PATH]);
    ab(["wait", "--load", "networkidle"]);
    ab(["wait", "--text", "tbrushlb"]);
    ab(["set", "viewport", "1280", "800"]);
  }, 60_000);

  afterAll(async () => {
    try {
      const now = await (await fetch(baseUrl + "/api/now")).json();
      for (const launch of now.launches ?? []) {
        if (launch.exitCode == null) { try { process.kill(launch.pid,"SIGTERM"); } catch {} }
      }
    } catch {}
    spawnSync(AB, ["--session", SESSION, "close"], { env: { ...process.env, PATH: PATH_WITH_AB } });
    if (serverProc) serverProc.kill("SIGTERM");
    if (existsSync(join(DBDIR,"logs"))) cpSync(join(DBDIR,"logs"),join(EVIDENCE,"fixture-logs"),{recursive:true});
    rmSync(TMP, { recursive: true, force: true });
  });

  uiTest("shows a run form a human can use, not a vim command bar", () => {
    const p = page();
    expect(p.title).toBe(MODERN_UI ? "Patronum — Content workspace" : "igdash");
    expect(p.runPlaceholder).toBe("e.g. remy.engineering");
    expect(p.runBtn).toContain("Start");
    expect(p.skipReels).toBe(false);
    expect(p.publishWiki).toBeUndefined();
    expect(p.cmdbar).toBeNull();
    expect(p.list.some((t: string) => t.includes("tbrushlb"))).toBe(true);
    expect(p.list.some((t: string) => t.includes("prettydios"))).toBe(true);
    if (MODERN_UI) { ab(["click", "#nav-diagnostics"]); expect(ab(["eval", "document.querySelector('#strip-queues').textContent"])).toContain("jobs"); ab(["click", "#nav-collections"]); } else expect(ab(["eval", "document.querySelector('#strip-queues').textContent"])).toContain("jobs");
  });

  uiTest("shows recognition readiness and keeps manual verification reachable", () => {
    if (MODERN_UI) { ab(["click", "#nav-account"]); ab(["click", "#captcha-details > summary"]); ab(["wait", "--text", "Local recognition"]); }
    const status = ab(["eval", "document.querySelector('#captcha-status').textContent"]);
    expect(status).toMatch(/Local recognition|status unavailable/);
    expect(ab(["eval", "document.querySelector('#auth-recover').textContent"])).toContain("Complete verification");
    expect(ab(["eval", "document.querySelector('#captcha-status').parentElement.textContent"])).toContain("Login attempts image verification automatically");
    if (MODERN_UI) { ab(["click", "#captcha-details > summary"]); ab(["click", "#nav-collections"]); }
    expect(JSON.parse(ab(["eval", "document.querySelector('#run-session').value"]))).toBe("");
  });

  uiTest("recognizes a saved grid through a fixture and presents a reviewable proposal", async () => {
    const readiness = await (await fetch(baseUrl + "/api/captcha/status")).json();
    expect(readiness.vision.configured).toBe(true);
    expect(readiness.vision.source).toBe("qwen");
    expect(readiness.automaticSubmission).toBe(false);
    const { captchaReadiness } = await import("../sign-in/captcha/config");
    const custom = await captchaReadiness({CAPTCHA_VISION_BASE_URL:"http://127.0.0.1:1/v1",CAPTCHA_VISION_API_KEY:"fixture",CAPTCHA_VISION_MODEL:"fixture-vision"});
    expect(custom.vision.source).toBe("custom");
    expect(custom.vision.configured).toBe(true);
    ab(["click", "#captcha-details > summary"]);
    expect(ab(["eval", "document.querySelector('#captcha-recognize').disabled"])).toBe("true");
    expect((await (await fetch(baseUrl + "/api/captcha/captures")).json()).captures).toEqual([]);
    const capture = "data/captcha/captures/qa_grid";
    mkdirSync(join(TMP,capture),{recursive:true});
    mkdirSync(join(TMP,"data/captcha/diagnostics"),{recursive:true});
    writeFileSync(join(TMP,capture,"grid.png"),readFileSync(join(TMP,"data/media/qa_run/POST1/image.png")));
    writeFileSync(join(TMP,capture,"diagnostic.json"),JSON.stringify({gridSize:3,timestamp:Date.now(),prompt:"Select buses"}));
    writeFileSync(join(TMP,capture,"observation.json"),JSON.stringify({gridSize:3,prompt:"Select buses",imagePath:join(TMP,capture,"grid.png")}));
    writeFileSync(join(TMP,"data/captcha/diagnostics/ui-proposal.json"),JSON.stringify({status:"proposed",selectedIndices:[0,4,7],automaticSubmission:false}));
    ab(["click", "#captcha-refresh"]);
    ab(["select", "#captcha-capture", "qa_grid"]);
    ab(["select", "#captcha-backend", "vision"]);
    expect(ab(["eval", "document.querySelector('#captcha-recognize').disabled"])).toBe("false");
    ab(["wait", "--fn", "document.querySelector('#captcha-preview').naturalWidth > 0"]);
    ab(["click", "#captcha-recognize"]);
    ab(["wait", "--text", "Proposed tiles: 1, 5, 8"]);
    const proposal = ab(["get", "text", "#captcha-proposal"]);
    expect(proposal).toContain("Nothing was clicked or submitted");
    expect(proposal).toContain("left to right, top to bottom");
    const href = JSON.parse(ab(["eval", "document.querySelector('#captcha-proposal a[download]').getAttribute('href')"]));
    const diagnostic = await (await fetch(baseUrl + href)).json();
    expect(diagnostic.selectedIndices).toEqual([0,4,7]);
    expect(diagnostic.automaticSubmission).toBe(false);
    const actions = await (await fetch(baseUrl + "/api/actions")).json();
    const action = actions.launches.find((entry: any) => entry.kind === "recognize-captcha");
    expect(action.argv).toContain("vision");
    expect(action.argv).toContain("--observation");
    ab(["screenshot", join(EVIDENCE,"recognition-proposal.png"), "--full"]);
    ab(["click", "#captcha-details > summary"]);
  }, 60_000);

  uiTest("opens a failed job and shows a readable error, not a gob blob", async () => {
    ab(["click", "#wf-list li:first-child"]);
    if (MODERN_UI) ab(["click", "[data-view=progress]"]);
    const p = await waitFor(page, (v) => v.bodyHidden === false && Boolean(v.banner));
    expect(p.wfId).toContain("tbrushlb");
    expect(p.banner).toContain("llm: preflight failed");
    expect(p.banner).not.toMatch(/flow\.CLIError/);
    expect(p.banner).not.toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(p.rail.toLowerCase()).toContain("preflight");
    expect(p.rail.toLowerCase()).toMatch(/failed|needs attention/);
    expect(p.stageNames).toEqual(["preflight", "scrape", "verify", "download", "unique", "analyze"]);
    expect(p.steps.some((s: string) => s.includes("preflight"))).toBe(true);
    expect(p.steps.some((s: string) => s.includes("DBOS.setEvent"))).toBe(false);
    expect(p.resumeHidden).toBe(false);
  });

  uiTest("reports a completed Knowledge stage from DBOS steps", async () => {
    const response = await fetch(baseUrl + "/api/workflow/ig%3Aprettydios%3A1788600000");
    expect(response.status).toBe(200);
    const detail = await response.json();
    expect(detail.stages.knowledge.state).toBe("done");
    expect(detail.stages.knowledge.output.indexPath).toBe("knowledge/clients/prettydios/INDEX.md");
  });

  uiTest("filters the job list from the search box", () => {
    ab(["fill", "#filter", "pretty"]);
    const p = page();
    expect(p.list.some((t: string) => t.includes("prettydios"))).toBe(true);
    expect(p.list.some((t: string) => t.includes("tbrushlb"))).toBe(false);
    ab(["fill", "#filter", ""]);
  });

  uiTest("Run starts a collection without wiki publishing", async () => {
    ab(["fill", "#run-handle", "alpha_ui"]);
    ab(["click", "#run-btn"]);
    ab(["wait", "--text", "alpha_ui"]);
    if (MODERN_UI) { reveal("#filter"); ab(["fill","#filter",""]); }
    const p = await waitFor(page, p => p.list.some((t: string) => t.includes("alpha_ui")));
    expect(p.list.some((t: string) => t.includes("alpha_ui"))).toBe(true);
    expect(p.runStatus.length).toBeGreaterThan(0);
    const now = await (await fetch(baseUrl + "/api/now")).json();
    const launch = now.launches.find((item: any) => item.handle === "alpha_ui");
    expect(launch.argv).toContain("--skip-kb");
  }, 20_000);

  uiTest("keeps wiki export separate from collection controls", async () => {
    expect(ab(["eval", "document.querySelector('#run-publish-wiki') === null"])).toBe("true");
    ab(["fill", "#run-handle", "beta_ui"]);
    ab(["click", "#run-btn"]);
    ab(["wait", "--text", "beta_ui"]);
    const now = await (await fetch(baseUrl + "/api/now")).json();
    const launch = now.launches.find((item: any) => item.handle === "beta_ui");
    expect(launch.argv).toContain("--skip-kb");
  }, 20_000);

  uiTest("keeps a selected failed run visible after reload", () => {
    ab(["fill", "#filter", "tbrush"]);
    ab(["wait", "#wf-list li"]);
    ab(["click", "#wf-list li"]);
    ab(["reload"]);
    ab(["wait", "--load", "networkidle"]);
    const p = page();
    if (p.bodyHidden) ab(["screenshot", join(EVIDENCE, "reload-failure.png")]);
    expect(p.bodyHidden).toBe(false);
    expect(p.wfId).toContain("tbrushlb");
    ab(["fill", "#filter", ""]);
  });

  uiTest("supports a collection run, prevents duplicate submissions, and exposes progress", async () => {
    ab(["fill", "#run-handle", "qa_run"]);
    const max = ab(["eval", "Boolean(document.querySelector('#run-max-posts'))"]);
    expect(max).toBe("true");
    ab(["fill", "#run-max-posts", "3"]);
    ab(["dblclick", "#run-btn"]);
    const now = await waitFor(async () => (await fetch(baseUrl + "/api/now")).json(), n => n.recent.some((w: any) => w.handle === "qa_run"));
    const runs = now.recent.filter((w: any) => w.handle === "qa_run");
    expect(runs).toHaveLength(1);
    expect(now.launches.filter((l: any) => l.handle === "qa_run")).toHaveLength(1);
    expect(now.launches.find((l: any) => l.handle === "qa_run").argv).toContain("--max");
    ab(["fill", "#filter", "qa_run"]);
    ab(["wait", "#wf-list li"]);
    ab(["click", "#wf-list li"]);
    expect(page().rail.toLowerCase()).toContain("scrape");
    writeFileSync(join(TMP, "continue-qa_run"), "go");
    const result = await waitFor(async () => (await fetch(baseUrl + "/api/workflow/" + encodeURIComponent(runs[0].id))).json(), d => d.workflow.status === "SUCCESS");
    expect(Object.values(result.stages).every((stage: any) => stage.state === "done")).toBe(true);
    ab(["reload"]);
    ab(["wait", "--load", "networkidle"]);
    expect(page().wfId).toContain("qa_run");
  }, 20_000);

  uiTest("browses post media, analysis, wiki, and each stage log", () => {
    ab(["click", "[data-view=results]"]);
    ab(["click", "#results-refresh"]);
    ab(["wait", "--text", "POST1"]);
    ab(["click", ".post-card button[data-file='data/media/qa_run/POST1/image.png']"]);
    ab(["wait", "--fn", "document.querySelector('#preview-content img')?.naturalWidth > 0"]);
    expect(ab(["eval", "document.querySelector('#file-preview').hidden"])).toBe("false");
    ab(["click", "#preview-close"]);
    ab(["click", ".post-card button[data-file='data/analysis/qa_run/items/POST1.json']"]);
    ab(["wait", "--text", "Warm colors and clear typography"]);
    expect(ab(["get", "text", "#preview-content"])).toContain("Warm colors and clear typography");
    ab(["click", "#preview-close"]);
    ab(["click", "#results-content > .file-list button[data-file='knowledge/clients/qa_run/INDEX.md']"]);
    ab(["wait", "--text", "QA client"]);
    expect(ab(["get", "text", "#preview-content"])).toContain("QA client");
    if (MODERN_UI) ab(["click", "#preview-close"]);
    ab(["click", "[data-view=progress]"]);
    for (const stage of ["preflight", "scrape", "verify", "download", "unique", "analyze", "knowledge"]) {
      ab(["select", "#log-stage", stage]);
      ab(["wait", "--fn", `document.querySelector('#stream-tail').textContent.includes(${JSON.stringify("[" + stage + "]")}) || document.querySelector('#stream-tail').textContent.includes(${JSON.stringify("STEP_PASS " + stage)})`]);
      expect(ab(["get", "text", "#stream-tail"])).toContain(stage);
    }
  }, 60_000);

  uiTest("shows a missing-key failure and resumes after recovery", async () => {
    ab(["fill", "#filter", ""]);
    ab(["fill", "#run-handle", "qa_missing"]);
    ab(["click", "#run-btn"]);
    const now = await waitFor(async () => (await fetch(baseUrl + "/api/now")).json(), n => n.recent.some((w: any) => w.handle === "qa_missing" && w.status === "ERROR"));
    const id = now.recent.find((w: any) => w.handle === "qa_missing").id;
    ab(["fill", "#filter", "qa_missing"]);
    ab(["wait", "#wf-list li"]);
    ab(["click", "#wf-list li"]);
    const p = page();
    expect(p.banner).toContain("QWEN_API_KEY");
    expect(p.banner.toLowerCase()).toContain("resume");
    expect(p.resumeHidden).toBe(false);
    ab(["click", "#btn-resume"]);
    const detail = await waitFor(async () => (await fetch(baseUrl + "/api/workflow/" + encodeURIComponent(id))).json(), d => d.workflow.status === "SUCCESS");
    expect(detail.stages.preflight.state).toBe("done");
  }, 20_000);

  uiTest("cancels an active run through the dashboard", async () => {
    ab(["fill", "#filter", ""]);
    ab(["fill", "#run-handle", "qa_cancel"]);
    ab(["click", "#run-btn"]);
    const now = await waitFor(async () => (await fetch(baseUrl + "/api/now")).json(), n => n.recent.some((w: any) => w.handle === "qa_cancel"));
    const id = now.recent.find((w: any) => w.handle === "qa_cancel").id;
    ab(["fill", "#filter", "qa_cancel"]);
    ab(["wait", "#wf-list li"]);
    ab(["click", "#wf-list li"]);
    expect(page().cancelHidden).toBe(false);
    ab(["click", "#btn-cancel"]);
    const detail = await waitFor(async () => (await fetch(baseUrl + "/api/workflow/" + encodeURIComponent(id))).json(), d => d.workflow.status === "CANCELLED");
    expect(detail.workflow.status).toBe("CANCELLED");
  }, 20_000);

  uiTest("has keyboard-operable job selection, clear empty search, and no mobile overflow", () => {
    ab(["fill", "#filter", "tbrush"]);
    const operable = ab(["eval", `Boolean(document.querySelector('#wf-list button, #wf-list a, #wf-list [tabindex="0"]'))`]);
    if (operable !== "true") ab(["screenshot", join(EVIDENCE, "keyboard-failure.png")]);
    expect(operable).toBe("true");
    ab(["focus", "#wf-list li"]);
    ab(["press", "Enter"]);
    expect(page().wfId).toContain("tbrushlb");
    ab(["fill", "#filter", "no_matching_job"]);
    expect(page().emptyList).toBe(false);
    ab(["fill", "#filter", ""]);
    ab(["set", "viewport", "390", "844"]);
    const dimensions = JSON.parse(ab(["eval", `({width:innerWidth,scroll:document.documentElement.scrollWidth})`]));
    ab(["screenshot", join(EVIDENCE, "mobile.png"), "--full"]);
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    ab(["set", "viewport", "1440", "1000"]);
    ab(["screenshot", join(EVIDENCE, "desktop.png"), "--full"]);
    const errors = ab(["errors"]);
    expect(errors).not.toMatch(/TypeError|ReferenceError|SyntaxError/);
  }, 20_000);

  uiTest("checks saved and isolated sessions through account controls", async () => {
    if(!MODERN_UI)return;
    ab(["click","#nav-account"]);
    ab(["click","#auth-preflight"]);
    ab(["wait","--text","AI connection verified"]);
    ab(["click","#auth-cold"]);
    ab(["wait","--text","Fresh login completed"]);
    const first = await waitFor(()=>fetch(baseUrl+"/api/actions").then(r=>r.json()),r=>r.launches.some((l:any)=>l.kind==="cold-login"&&l.exitCode===0));
    const cold=first.launches.find((l:any)=>l.kind==="cold-login");
    expect(cold.isolated).toBe(true);
    ab(["click","#auth-check-current"]);
    ab(["wait","--text","Saved login verified"]);
    const actions=await (await fetch(baseUrl+"/api/actions")).json();
    const warm=actions.launches.find((l:any)=>l.kind==="warm-session");
    expect(warm.profileDir).toBe(cold.profileDir);
    ab(["click","#auth-use-session"]);
    ab(["click","#nav-collections"]);
    reveal("#run-session");
    expect(JSON.parse(ab(["eval","document.querySelector('#run-session').value"]))).toBe(String(warm.pid));
    ab(["reload"]);ab(["wait","--load","networkidle"]);
    reveal("#run-session");
    expect(JSON.parse(ab(["eval","document.querySelector('#run-session').value"]))).toBe(String(warm.pid));
    ab(["select","#run-session",""]);
  },30000);

  uiTest("requires a matching cleanup preview and invalidates it when retention changes", () => {
    if(!MODERN_UI)return;
    ab(["click","#nav-diagnostics"]);
    expect(ab(["eval","document.querySelector('#gc-run').hidden"])).toBe("true");
    ab(["click","#gc-preview"]);ab(["wait","--text","fixture-old-history"]);
    ab(["wait","--fn","document.querySelector('#gc-run').hidden === false"]);
    ab(["fill","#gc-age","240h"]);
    expect(ab(["eval","document.querySelector('#gc-run').hidden"])).toBe("true");
    ab(["click","#gc-preview"]);ab(["wait","--fn","document.querySelector('#gc-run').hidden === false"]);
    ab(["click","#gc-run"]);ab(["wait","--fn","document.querySelector('#gc-run').hidden === true"]);
    ab(["click","#diagnostics-btn"]);ab(["wait","--text","boot"]);
  },20000);

  uiTest("renders zero, thirteen, and one hundred posts with bounded initial media and file lists", async () => {
    if(!MODERN_UI)return;
    for(const [handle,count] of [["qa_empty",0],["qa_thirteen",13],["qa_large",100]] as const){
      ab(["fill","#filter",handle]);ab(["click","#wf-list li"]);ab(["click","[data-view=results]"]);
      ab(["wait","--text",count+" posts"]);
      const dom=JSON.parse(ab(["eval","({posts:document.querySelectorAll('[data-post]').length,media:document.querySelectorAll('.post-media img').length,files:document.querySelectorAll('#results-content details .file-list li').length})"]));
      expect(dom.posts).toBe(Math.min(count,8));expect(dom.media).toBeLessThanOrEqual(8);expect(dom.files).toBeLessThanOrEqual(100);
      if(count===13)expect(ab(["eval","Array.from(document.querySelectorAll('[data-post]')).map(n=>n.getAttribute('data-post'))"])).toContain("DIMO0SkIKK_");
      if(count===100){
        expect(ab(["get","text","#results-content"])).toContain("first 2,000 files");
        ab(["click","#results-more"]);
        expect(JSON.parse(ab(["eval","document.querySelectorAll('[data-post]').length"]))).toBe(20);
        const report={fixture:handle,posts:count,initialDom:dom,afterExpand:20,userAgent:JSON.parse(ab(["eval","navigator.userAgent"]))};
        writeFileSync(join(EVIDENCE,"large-results.json"),JSON.stringify(report,null,2));
      }
    }
  },30000);

  uiTest("keeps focus and polling bounded across view switches and returns reader focus", async () => {
    if(!MODERN_UI)return;
    ab(["fill","#filter","qa_thirteen"]);ab(["click","#wf-list li"]);ab(["click","[data-view=results]"]);ab(["wait","--text","13 posts"]);
    const selector=".post-card button[data-file='data/media/qa_thirteen/DIMO0SkIKK_/0.png']";
    ab(["click",selector]);ab(["wait","--fn","document.querySelector('[role=dialog]') !== null"]);
    ab(["press","Escape"]);ab(["wait","--fn","document.querySelector('[role=dialog]') === null"]);
    expect(JSON.parse(ab(["eval","document.activeElement?.getAttribute('data-file')"]))).toBe("data/media/qa_thirteen/DIMO0SkIKK_/0.png");
    ab(["eval",`window.__requests=[];window.__originalFetch=window.fetch;window.fetch=async(...args)=>{window.__requests.push({path:String(args[0]),at:performance.now(),method:args[1]?.method??'GET'});return window.__originalFetch(...args)}`]);
    for(let i=0;i<20;i++)ab(["click",i%2?"[data-view=results]":"[data-view=progress]"]);
    const current=page().wfId;expect(current).toContain("qa_thirteen");
    ab(["eval","window.__requests=[]"]);
    await Bun.sleep(6500);
    const requests=JSON.parse(ab(["eval","window.__requests"]));
    expect(requests.filter((r:any)=>r.method==='POST')).toHaveLength(0);
    expect(requests.filter((r:any)=>r.path.includes('/log?'))).toHaveLength(0);
    expect(requests.filter((r:any)=>r.path==='/api/now').length).toBeLessThanOrEqual(3);
    expect(requests.filter((r:any)=>r.path==='/api/actions').length).toBeLessThanOrEqual(3);
    const stable = page().wfId;expect(stable).toBe(current);
    writeFileSync(join(EVIDENCE,"polling.json"),JSON.stringify({switches:20,observationMs:6500,requests},null,2));
    ab(["eval","window.fetch=window.__originalFetch"]);
  },40000);

  uiTest("retains selected content through disconnect and rejects late results from a previous selection", async () => {
    if(!MODERN_UI)return;
    ab(["fill","#filter","qa_thirteen"]);ab(["click","#wf-list li"]);ab(["click","[data-view=results]"]);ab(["wait","--text","13 posts"]);
    ab(["eval",`window.__savedFetch=window.fetch;window.__offline=true;window.fetch=async(...args)=>{if(window.__offline&&String(args[0])==='/api/now')throw new Error('Fixture disconnected');return window.__savedFetch(...args)}`]);
    ab(["click","[aria-label='Refresh workspace']"]);ab(["wait","--text","Reconnecting"]);
    expect(page().wfId).toContain("qa_thirteen");expect(ab(["get","text",".result-summary"])).toContain("13 posts");
    ab(["eval","window.__offline=false"]);ab(["click","[aria-label='Refresh workspace']"]);ab(["wait","--text","Connected"]);
    ab(["eval",`window.fetch=async(...args)=>{const response=await window.__savedFetch(...args);if(String(args[0]).includes('/api/results?handle=qa_thirteen'))await new Promise(r=>setTimeout(r,1500));return response;}`]);
    ab(["click","#results-refresh"]);ab(["fill","#filter","qa_empty"]);ab(["click","#wf-list li"]);ab(["click","[data-view=results]"]);ab(["wait","--text","0 posts"]);
    await Bun.sleep(1700);
    expect(page().wfId).toContain("qa_empty");expect(ab(["get","text",".result-summary"])).toContain("0 posts");
    ab(["eval","window.fetch=window.__savedFetch"]);
  },25000);

  uiTest("maps grouped collection choices into coherent workflow flags",async()=>{
    if(!MODERN_UI)return;
    ab(["fill","#run-handle","qa_flags"]);
    ab(["select","#collection-goal","analyze"]);
    ab(["check","[data-flag='all-frames']"]);
    ab(["click","#collection-settings > summary"]);
    ab(["select","#collection-source","saved"]);
    for(const [name,value] of [["dl-workers","2"],["analyze-workers","3"],["detail-workers","2"]])ab(["fill",`[data-flag='${name}']`,value]);
    ab(["fill","#collection-timeoutMinutes","1"]);
    ab(["click","#collection-troubleshooting > summary"]);
    ab(["check","[data-flag='force-login']"]);
    ab(["check","[data-flag='skip-llm-preflight']"]);
    ab(["click","#run-btn"]);
    const actions=await waitFor(()=>fetch(baseUrl+"/api/actions").then(r=>r.json()),r=>r.launches.some((l:any)=>l.handle==="qa_flags"));
    const argv=actions.launches.find((l:any)=>l.handle==="qa_flags").argv;
    for(const flag of ["--dl-workers","--analyze-workers","--timeout","--force-login","--all-frames","--skip-llm-preflight"])expect(argv).toContain(flag);
    for(const flag of ["--fresh","--no-detail","--skip-download","--skip-unique","--skip-analyze"])expect(argv).not.toContain(flag);
  },30000);

  uiTest("keeps jobs in the sidebar and opens each selected state machine",async()=>{
    if(!MODERN_UI)return;
    ab(["set","viewport","1440","1000"]);
    ab(["fill","#filter","tbrush"]);ab(["click","#wf-list li"]);
    ab(["wait","--fn","document.querySelectorAll('.fsm-node').length === 8"]);
    expect(ab(["eval","document.querySelector('[data-view=progress]').getAttribute('aria-pressed')"])).toBe('"true"');
    expect(ab(["eval","document.querySelector('.jobs-sidebar').getBoundingClientRect().right < document.querySelector('#workspace').getBoundingClientRect().left"])).toBe("true");
    ab(["click","#new-job"]);ab(["wait","--fn","document.querySelector('#new-collection-disclosure').open === true"]);
    ab(["click","#wf-list li"]);ab(["wait","--fn","document.querySelector('#new-collection-disclosure').open === false"]);
    ab(["click","[data-node=verify] button"]);
    expect(ab(["eval","document.querySelector('#log-stage').value"])).toBe('"verify"');
    expect(ab(["get","text",".state-inspector h2"])).toBe("Verify posts");
    ab(["click","[data-view=results]"]);ab(["fill","#filter","pretty"]);
    ab(["eval","window.scrollTo(0,document.body.scrollHeight)"]);ab(["click","#wf-list li"]);
    ab(["wait","--fn","scrollY === 0 && document.activeElement?.id === 'workspace'"]);
    ab(["wait","--text","Progress"]);expect(page().wfId).toContain("prettydios");
    expect(ab(["eval","document.querySelector('[data-node=complete]').getAttribute('data-state')"])).toBe('"done"');
    ab(["set","viewport","390","844"]);
    ab(["wait","--fn","document.querySelector('#job-sidebar-list').open === false"]);
    ab(["click","#job-sidebar-list > summary"]);
    ab(["fill","#filter","tbrush"]);ab(["click","#wf-list li"]);
    ab(["wait","--fn","document.querySelector('#job-sidebar-list').open === false"]);
    expect(page().wfId).toContain("tbrushlb");
    const size=JSON.parse(ab(["eval","({width:innerWidth,scroll:document.documentElement.scrollWidth})"]));expect(size.scroll).toBeLessThanOrEqual(size.width);
    ab(["set","viewport","1440","1000"]);
  },25000);

  uiTest("keeps primary navigation visible while long results scroll",async()=>{
    if(!MODERN_UI)return;
    ab(["set","viewport","1440","844"]);
    ab(["fill","#filter","qa_large"]);ab(["click","#wf-list li"]);ab(["click","[data-view=results]"]);
    ab(["wait","--text","100 posts"]);
    const observations=[];
    for(const width of [1440,900,390]){
      ab(["set","viewport",String(width),"844"]);
      ab(["eval","window.scrollTo(0,document.documentElement.scrollHeight)"]);
      observations.push(JSON.parse(ab(["eval",`({
        width:innerWidth,
        scrollY,
        documentHeight:document.documentElement.scrollHeight,
        headerTop:document.querySelector('.app-header').getBoundingClientRect().top,
        headerBottom:document.querySelector('.app-header').getBoundingClientRect().bottom,
        navigationTop:document.querySelector('.sidebar-nav').getBoundingClientRect().top,
        navigationBottom:document.querySelector('.sidebar-nav').getBoundingClientRect().bottom,
        sidebarPosition:getComputedStyle(document.querySelector('.jobs-sidebar')).position,
        sidebarOverflow:getComputedStyle(document.querySelector('.jobs-sidebar')).overflow,
        appOverflow:getComputedStyle(document.querySelector('.app')).overflow,
        bodyOverflow:getComputedStyle(document.body).overflow,
        htmlOverflow:getComputedStyle(document.documentElement).overflow
      })`])));
    }
    const collapsedSummary=JSON.parse(ab(["eval",`(()=>{const rect=document.querySelector('#job-sidebar-list > summary').getBoundingClientRect();return {top:rect.top,bottom:rect.bottom}})()`]));
    ab(["eval","document.querySelector('#job-sidebar-list > summary').click()"]);
    ab(["wait","--fn","document.querySelector('#job-sidebar-list').open === true"]);
    const expandedMobile=JSON.parse(ab(["eval",`(()=>{const nav=document.querySelector('.sidebar-nav').getBoundingClientRect();const summary=document.querySelector('#job-sidebar-list > summary').getBoundingClientRect();return {navigationTop:nav.top,navigationBottom:nav.bottom,summaryTop:summary.top,summaryBottom:summary.bottom}})()`]));
    writeFileSync(join(EVIDENCE,"sticky-navigation.json"),JSON.stringify(observations,null,2));
    writeFileSync(join(EVIDENCE,"sticky-navigation-expanded.json"),JSON.stringify({collapsedSummary,expandedMobile},null,2));
    ab(["screenshot",join(EVIDENCE,"sticky-navigation-after.png")]);
    for(const item of observations){
      expect(item.scrollY).toBeGreaterThan(500);
      expect(item.headerTop).toBe(0);
      expect(item.navigationTop).toBeGreaterThanOrEqual(item.headerBottom);
      expect(item.navigationBottom).toBeLessThanOrEqual(844);
    }
    expect(collapsedSummary.top).toBeGreaterThanOrEqual(observations.at(-1).navigationBottom);
    expect(collapsedSummary.bottom).toBeLessThanOrEqual(844);
    expect(expandedMobile.navigationTop).toBeGreaterThanOrEqual(68);
    expect(expandedMobile.summaryBottom).toBeLessThanOrEqual(844);
    ab(["set","viewport","1440","1000"]);
    ab(["eval","window.scrollTo(0,0)"]);
  },25000);

});
