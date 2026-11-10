import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "../..");
const TMP = join(import.meta.dir, `.test-durable-${process.pid}`);
const PORT = 18000 + process.pid % 10000;
const BASE = `http://127.0.0.1:${PORT}`;
const CALLS = join(TMP, "calls");
let WORKFLOW = "";
const SKIP_LLM = process.env.IGDASH_TEST_SKIP_LLM === "1";
const UI_PATH = process.env.IGDASH_UI_PATH ?? "/";
const BROWSER_SESSION = "durable-ui-" + process.pid;
function ab(args:string[]) {
  const result=spawnSync("agent-browser",["--session",BROWSER_SESSION,...args],{encoding:"utf8",timeout:args[0]==="open"?30000:12000,env:{...process.env,PATH:process.env.HOME+"/.local/bin:/opt/homebrew/bin:"+process.env.PATH}});
  if(result.status!==0)throw new Error(result.stderr+result.stdout);
  return result.stdout.trim();
}
let server: ReturnType<typeof Bun.spawn> | undefined;

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 40000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await read(); last = value; if (ready(value)) return value; } catch (error) { last = String(error); }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${JSON.stringify(last)}`);
}

async function get(path: string): Promise<any> {
  const response = await fetch(BASE + path);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

beforeAll(async () => {
  mkdirSync(join(TMP, "data/chrome-profile/Default"), { recursive: true });
  const cookies = new Database(join(TMP, "data/chrome-profile/Default/Cookies"));
  cookies.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER)");
  const expiry = (Date.now() + 86400000) * 1000 + 11644473600000000;
  for (const name of ["sessionid", "ds_user_id"]) cookies.query("INSERT INTO cookies VALUES (?, ?, ?)").run(".instagram.com", name, expiry);
  cookies.close();
  const build = Bun.spawn(["go", "build", "-o", join(TMP, "igflow"), "./cmd/igflow"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const buildErrors = await new Response(build.stderr).text();
  if (await build.exited !== 0) throw new Error(buildErrors);
  const fixture = (name: string) => `bash '${join(ROOT, "internal/flow/testdata", name)}'`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(IGFLOW_|DBOS_|IGDASH_|IG_|QWEN_|DASHSCOPE_|ALIBABA_)/.test(key)));
  server = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    cwd: ROOT,
    env: {
      ...env,
      IGDASH_ROOT: TMP, IGDASH_PORT: String(PORT), IGDASH_IGFLOW_CMD: JSON.stringify([join(TMP, "igflow")]),
      IGFLOW_TEST_HANDLE: "fixture", IGFLOW_TEST_CALLS: CALLS,
      IGFLOW_SCRAPE_CMD: fixture("scrape-ok.sh"), IGFLOW_VERIFY_CMD: fixture("verify-ok.sh"),
      IGFLOW_IGDL_CMD: fixture("igdl-ok.sh"), IGFLOW_IGUNIQUE_CMD: fixture("igunique-ok.sh"),
      IGFLOW_IGANALYZE_CMD: fixture("iganalyze-ok.sh"), IGFLOW_PREFLIGHT_CMD: fixture(SKIP_LLM ? "llm.sh" : "ok.sh"),
      IG_USER: "fixture-user", IG_PASS: "fixture-password", QWEN_API_KEY: "fixture-provider-key",
    },
    stdout: Bun.file(join(TMP, "server.stdout.log")), stderr: Bun.file(join(TMP, "server.stderr.log")),
  });
  await waitFor(() => get("/api/health"), (value) => value.ok);
  ab(["open",BASE+UI_PATH]);
}, 60000);

afterAll(async () => {
  try {ab(["close"]);} catch {}
  server?.kill();
  if (server) await server.exited;
  rmSync(TMP, { recursive: true, force: true });
});

it("completes a collection through the dashboard without publishing a wiki", async () => {
  expect(ab(["eval", "document.querySelector('#run-publish-wiki') === null"])).toBe("true");
  expect(ab(["eval", "document.querySelector('#run-max-posts').value"])).toBe('"30"');
  expect(ab(["eval", "document.querySelector('#collection-goal').value"])).toBe('"download"');
  expect(ab(["eval", "document.querySelector('#collection-media').value"])).toBe('"all"');
  ab(["fill","#run-handle","fixture"]);
  ab(["fill","#run-max-posts","0"]);
  ab(["scrollintoview", "#run-btn"]);
  ab(["click", "#run-btn"]);
  expect(ab(["get", "text", "#collection-max-error"])).toContain("at least 1");
  expect((await get<any>("/api/actions")).launches).toHaveLength(0);
  ab(["fill","#run-max-posts","3"]);
  if (!SKIP_LLM) ab(["select", "#collection-goal", "analyze"]);
  ab(["scrollintoview", "#run-btn"]);
  ab(["click","#run-btn"]);
  const launched = await waitFor(()=>get("/api/actions"),value=>value.launches.some((l:any)=>l.kind==="run"));
  const runAction=launched.launches.find((l:any)=>l.kind==="run");
  if (SKIP_LLM) {
    expect(runAction.argv).toContain("--skip-llm-preflight");
    expect(runAction.argv).toContain("--skip-analyze");
  }
  expect(runAction.argv).not.toContain("--skip-reels");

  WORKFLOW=runAction.workflowId;
  const finished = await waitFor(() => get(`/api/launch/${runAction.pid}`), (value) => value.exitCode !== null);
  expect(finished.exitCode).toBe(0);
  const detail = await get(`/api/workflow/${encodeURIComponent(WORKFLOW)}`);
  expect(detail.workflow.status).toBe("SUCCESS");
  for (const stage of ["preflight", "scrape", "verify", "download", "unique", ...(!SKIP_LLM ? ["analyze"] : [])]) {
    expect(detail.stages[stage].state).toBe("done");
  }
  expect(detail.workflow.skipped).toContain("knowledge");
  if (SKIP_LLM) expect(detail.workflow.skipped).toContain("analyze");
  expect(detail.steps.some((step: any) => step.name === "knowledge")).toBe(false);
  const calls = readFileSync(CALLS, "utf8").trim().split("\n");
  for (const stage of ["scrape", "igdl", "igunique", ...(!SKIP_LLM ? ["iganalyze"] : [])]) {
    expect(calls.filter((value) => value === stage)).toHaveLength(1);
  }
  expect(calls).not.toContain("knowledge");
  if (SKIP_LLM) expect(calls).not.toContain("iganalyze");
  ab(["wait","--fn","document.querySelector(\".detail-heading .status-label\")?.textContent.includes(\"Complete\")"]);
  expect(ab(["get","text","#wf-id"])).toContain("fixture");
  const evidence=join(ROOT,"data/qa/redesign");mkdirSync(evidence,{recursive:true});
  writeFileSync(join(evidence,"durable-scenario.json"), JSON.stringify({ workflow: WORKFLOW, calls, control:"dashboard UI"},null,2));
}, 90000);
