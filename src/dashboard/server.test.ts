// HTTP contracts the UI cannot reach (path guard, health, bad handles).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const TMP = resolve(import.meta.dir, ".test-http");
const SERVER = resolve(import.meta.dir, "server.ts");
const PORT = 17990;

let serverProc: ChildProcess | null = null;
let baseUrl = "";

async function start() {
  mkdirSync(join(TMP, "data/dbos/logs/_dash"), { recursive: true });
  await new Promise<void>((res, rej) => {
    const proc = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        IGDASH_ROOT: TMP,
        IGDASH_PORT: String(PORT),
        IGDASH_IGFLOW_CMD: JSON.stringify([process.execPath, resolve(import.meta.dir,"control-fixture.ts")]),
        IGDASH_AUTH_CMD: JSON.stringify([process.execPath, resolve(import.meta.dir,"control-fixture.ts")]),
        IGDASH_MAP_NETWORK_CMD: JSON.stringify([process.execPath, resolve(import.meta.dir,"control-fixture.ts"),"run"]),
        IGDASH_CAPTCHA_CMD: JSON.stringify([process.execPath, resolve(import.meta.dir,"../sign-in/captcha/cli.ts")]),
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
    proc.on("exit", (code) => { if (!done) rej(new Error(`server exit ${code}`)); });
    setTimeout(() => { if (!done) rej(new Error("server never printed url")); }, 4000);
  });
}

async function post(path: string, body: unknown) { return fetch(baseUrl+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); }
async function finished(pid: number) {
  for (let i=0;i<100;i++) { const action = await (await fetch(baseUrl+`/api/launch/${pid}`)).json(); if(action.exitCode !== null) return action; await Bun.sleep(20); }
  throw new Error("Action did not finish");
}

describe("igdash HTTP contracts", () => {
  it("lists verified unique masters through the real artifact guard",async()=>{
    const handle="owned_fixture";
    const folder=join(TMP,"data",handle+"-unique");mkdirSync(folder,{recursive:true});mkdirSync(join(TMP,"data/profiles"),{recursive:true});
    writeFileSync(join(folder,"own.png"),"image");
    writeFileSync(join(folder,"manifest.json"),JSON.stringify({files:[{shortcode:"OWN",dest:`data/${handle}-unique/own.png`}]}));
    writeFileSync(join(TMP,"data/profiles",handle+"-profile.json"),JSON.stringify({posts:[{shortcode:"OWN",mediaOwnershipVersion:1}]}));
    const result=await(await fetch(baseUrl+"/api/results?handle="+handle)).json();
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].preview.path).toBe(`data/${handle}-unique/own.png`);
  });
  beforeAll(async () => {
    rmSync(TMP, { recursive: true, force: true });
    await start();
  });
  afterAll(() => {
    serverProc?.kill("SIGTERM");
    rmSync(TMP, { recursive: true, force: true });
  });

  it("GET /api/health reports missing db and a log ring", async () => {
    const r = await fetch(baseUrl + "/api/health");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-igdash-req")).toBeTruthy();
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.db.exists).toBe(false);
    expect(j.log).toBeTruthy();
  });

  it("GET /api/debug/log returns structured events including boot", async () => {
    const r = await fetch(baseUrl + "/api/debug/log");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.lines.some((e: any) => e.msg === "boot")).toBe(true);
  });

  it("serves the root dashboard and preview alias with guarded hashed assets", async () => {
    const root = await (await fetch(baseUrl + "/")).text();
    expect(root).toContain("Patronum");
    expect(root).not.toContain("/app.js");
    expect((await fetch(baseUrl+"/app.js")).status).toBe(404);
    expect((await fetch(baseUrl+"/styles.css")).status).toBe(404);
    const page = await fetch(baseUrl + "/redesign/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Patronum");
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(asset).toStartWith("/assets/");
    const script = await fetch(baseUrl + asset);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await fetch(baseUrl + "/redesign/account")).status).toBe(200);
    expect((await fetch(baseUrl + "/redesign/assets/missing.js")).status).toBe(404);
    expect((await fetch(baseUrl + "/redesign/%2e%2e%2fserver.ts")).status).toBe(404);
  });

  it("reports recognition readiness without exposing credentials or submitting challenges", async () => {
    const response=await fetch(baseUrl+"/api/captcha/status");expect(response.status).toBe(200);
    const status=await response.json();expect(status.ok).toBe(true);expect(status.mode).toBe("recognition-only");expect(status.automaticSubmission).toBe(false);
    expect(status.local.checked).toBe("files-only");expect(status.vision.reason).toBeTruthy();
  });

  it("lists checkpoint captures and requires explicit recognition confirmation", async () => {
    const directory=join(TMP,"data/captcha/captures/fixture");mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,"diagnostic.json"),JSON.stringify({status:"captured",timestamp:new Date().toISOString(),automaticSubmission:false}));
    writeFileSync(join(directory,"observation.json"),'{}');writeFileSync(join(directory,"grid.png"),"fixture");
    const listed=await (await fetch(baseUrl+"/api/captcha/captures")).json();expect(listed.captures).toHaveLength(1);
    const input={action:"recognize-captcha",captureId:listed.captures[0].id,backend:"local"};
    expect((await post("/api/action",input)).status).toBe(400);
    expect((await post("/api/action",{...input,confirmed:true,captureId:"../../.env"})).status).toBe(400);
    const action=await (await post("/api/action",{...input,confirmed:true})).json();const done=await finished(action.pid);
    expect(done.exitCode).toBe(3);expect(done.result.reason).toBe("invalid-observation");expect(done.result.manualFallback).toBe(true);
    expect((await fetch(baseUrl+done.result.diagnosticUrl)).status).toBe(200);
  });

  it("rejects a shell-metachar handle and a path escape", async () => {
    const bad = await fetch(baseUrl + "/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "a;rm" }),
    });
    expect(bad.status).toBe(400);
    const esc = await fetch(baseUrl + "/api/artifact?path=../../etc/passwd");
    expect(esc.status).toBe(400);
  });

  it("runs provider checks as inspectable actions and downloads their logs", async () => {
    const r = await fetch(baseUrl + "/api/action", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({action:"preflight"}) });
    expect(r.status).toBe(200);
    const action = await r.json();
    expect(action.pid).toBeGreaterThan(0);
    const log = await fetch(baseUrl + `/api/launch/${action.pid}/log?download=1`);
    expect(log.status).toBe(200);
    expect(log.headers.get("content-disposition")).toContain("attachment");
  });

  it("does not expose credentials through artifact or file endpoints", async () => {
    const artifact = await fetch(baseUrl + "/api/artifact?path=.env");
    expect(artifact.status).toBe(400);
    const file = await fetch(baseUrl + "/api/file?path=.env");
    expect(file.status).toBe(400);
  });

  it("retains completed action results through a dashboard restart and redacts subprocess output", async () => {
    const action = await (await post("/api/action",{action:"preflight"})).json();
    const done = await finished(action.pid); expect(done.result.ok).toBe(true);
    const text = await (await fetch(baseUrl+`/api/launch/${action.pid}/log?download=1`)).text();
    expect(text).toContain("[stdout]"); expect(text).not.toContain("test-fixture-secret"); expect(text).not.toContain("654321");
    await new Promise<void>(resolve=>{serverProc!.once("exit",()=>resolve());serverProc!.kill("SIGTERM");});
    await start();
    const restored = await (await fetch(baseUrl+`/api/launch/${action.pid}`)).json();
    expect(restored.result.ok).toBe(true); expect(restored.status).toBe("completed");
  });

  it("preserves max=3 and prevents duplicate browser launches", async () => {
    const first = await post("/api/run",{handle:"qa_http",max:3,"skip-reels":true});
    expect(first.status).toBe(200); const action = await first.json();
    const duplicate = await post("/api/run",{handle:"qa_http",max:3}); expect(duplicate.status).toBe(409);
    const done = await finished(action.pid); expect(done.result.argv).toContain("3"); expect(done.result.argv).toContain("--skip-reels");
  });

  it("reuses the exact isolated cold profile for recovery and checks", async () => {
    const cold = await (await post("/api/action",{action:"cold-login"})).json();
    await finished(cold.pid); expect(cold.profileDir).toContain("data/dashboard-sessions/");
    const recovery = await (await post("/api/action",{action:"recover-login",sourcePid:cold.pid})).json();
    expect(recovery.profileDir).toBe(cold.profileDir);
    const done = await finished(recovery.pid); expect(done.result.profileDir).toBe(cold.profileDir);
    const warm = await (await post("/api/action",{action:"warm-session",sourcePid:cold.pid})).json();
    const check = await finished(warm.pid); expect(check.result.argv).toContain("--check-only"); expect(check.result.profileDir).toBe(cold.profileDir);
  });

  it("collects and resumes using the selected successful isolated login", async () => {
    const cold=await (await post("/api/action",{action:"cold-login"})).json();await finished(cold.pid);
    const run=await (await post("/api/run",{handle:"qa_isolated",max:3,sourcePid:cold.pid})).json();
    const done=await finished(run.pid);expect(done.result.profileDir).toBe(cold.profileDir);
    const resume=await (await post("/api/resume",{workflowId:run.workflowId})).json();
    expect((await finished(resume.pid)).result.profileDir).toBe(cold.profileDir);
    expect((await post("/api/run",{handle:"qa_isolated",sourcePid:999999999})).status).toBe(400);
  });

  it("maps with the selected session as an inspectable browser action, not a collection", async () => {
    for (const handle of ["", "bad;handle", "a".repeat(31)]) {
      expect((await post("/api/map-network",{handle})).status).toBe(400);
    }
    expect((await post("/api/map-network",{handle:"valid", "show-browser":"yes"})).status).toBe(400);
    expect((await post("/api/map-network",{handle:"valid",max:3})).status).toBe(400);
    expect((await post("/api/map-network",{handle:"valid",surface:"collections"})).status).toBe(400);
    expect((await post("/api/map-network",{handle:"valid",surface:true})).status).toBe(400);
    expect((await post("/api/map-network",{handle:"valid",sourcePid:999999999})).status).toBe(400);
    const cold=await (await post("/api/action",{action:"cold-login"})).json();
    await finished(cold.pid);
    const response=await post("/api/map-network",{handle:"@qa_map",sourcePid:cold.pid,"show-browser":true});
    expect(response.status).toBe(200);
    const action=await response.json();
    expect(action.workflowId).toBeUndefined();
    expect((await post("/api/run",{handle:"qa_map",max:3})).status).toBe(409);
    const done=await finished(action.pid);
    expect(done.kind).toBe("map-network");expect(done.workflowId).toBeNull();
    expect(done.handle).toBe("qa_map");expect(done.sourcePid).toBe(cold.pid);
    expect(done.result.argv).toEqual(["run","--handle","qa_map"]);
    expect(done.result.profileDir).toBe(cold.profileDir);
    const state=JSON.parse(readFileSync(join(TMP,done.logPath.replace(/\.log$/, ".json")),"utf8"));
    expect(state.headless).toBe(false);
    const coldState=JSON.parse(readFileSync(join(TMP,cold.logPath.replace(/\.log$/, ".json")),"utf8"));
    expect(state.cacheDir).toBe(coldState.cacheDir);
    expect((await fetch(baseUrl+`/api/launch/${action.pid}/log`)).status).toBe(200);
    const headless=await (await post("/api/map-network",{handle:"qa_map"})).json();
    await finished(headless.pid);
    const headlessState=JSON.parse(readFileSync(join(TMP,headless.logPath.replace(/\.log$/, ".json")),"utf8"));
    expect(headlessState.headless).toBe(true);
    expect(headlessState.profileDir).toBeUndefined();
    const saved=await (await post("/api/map-network",{handle:"qa_map",surface:"saved"})).json();
    const savedDone=await finished(saved.pid);
    expect(savedDone.result.argv).toEqual(["run","--handle","qa_map","--surface","saved"]);
    const stoppable=await (await post("/api/map-network",{handle:"qa_map"})).json();
    await Bun.sleep(70);
    expect((await post("/api/action/stop",{pid:stoppable.pid})).status).toBe(200);
    expect((await finished(stoppable.pid)).status).toBe("stopped");
  });

  it("reports provider failures and allows retry after configuration is repaired", async () => {
    writeFileSync(join(TMP,"preflight-fail"),"");
    const action=await (await post("/api/action",{action:"preflight"})).json();
    const failed=await finished(action.pid); expect(failed.exitCode).toBe(4);expect(failed.result.kind).toBe("missing-key");
    rmSync(join(TMP,"preflight-fail"));
    const retry=await (await post("/api/action",{action:"preflight"})).json();expect((await finished(retry.pid)).result.ok).toBe(true);
  });

  it("keeps active actions alive and logging while the dashboard restarts", async () => {
    const action=await (await post("/api/action",{action:"warm-session"})).json();
    await new Promise<void>(resolve=>{serverProc!.once("exit",()=>resolve());serverProc!.kill("SIGTERM");});
    await start();
    const done=await finished(action.pid);expect(done.exitCode).toBe(0);expect(done.result.command).toBe("session");
    expect(done.tail.some((line:string)=>line.includes("completed"))).toBe(true);
  });

  it("stops an owned authentication action without stopping the dashboard", async () => {
    const action=await (await post("/api/action",{action:"warm-session"})).json();
    await Bun.sleep(70);
    expect((await post("/api/action/stop",{pid:action.pid})).status).toBe(200);
    const done=await finished(action.pid);expect(done.status).toBe("stopped");expect((await fetch(baseUrl+"/api/health")).status).toBe(200);
  });

  it("accepts fork UUIDs for cancel and resume", async () => {
    const id = "926d37ca-1fe9-4826-b827-339e88e228a4";
    for (const path of ["cancel","resume"]) { const r=await post(`/api/${path}`,{workflowId:id});expect(r.status).toBe(200);await finished((await r.json()).pid); }
  });

  it("serves post media and analysis while rejecting symlink escapes", async () => {
    mkdirSync(join(TMP,"data/media/qa_http/PostA"),{recursive:true});
    mkdirSync(join(TMP,"data/analysis/qa_http/items"),{recursive:true});
    writeFileSync(join(TMP,"data/media/qa_http/PostA/image.jpg"),"image fixture");
    writeFileSync(join(TMP,"data/analysis/qa_http/items/PostA.json"),'{"summary":"A post"}');
    writeFileSync(join(TMP,"private.txt"),"private");
    symlinkSync(join(TMP,"private.txt"),join(TMP,"data/media/qa_http/PostA/escape.txt"));
    const results=await (await fetch(baseUrl+"/api/results?handle=qa_http")).json();
    expect(results.posts[0].media.length).toBe(1);expect(results.posts[0].analysis.length).toBe(1);
    expect((await fetch(baseUrl+results.posts[0].media[0].url)).status).toBe(200);
    expect((await fetch(baseUrl+"/api/file?path=data/media/qa_http/PostA/escape.txt")).status).toBe(400);
  });

  it("passes durable launch detachment through to Bun.spawn", () => {
    const source = readFileSync(resolve(import.meta.dir, "launcher.ts"), "utf8");
    expect(source).toContain("detached: opts.detached");
  });
  it("persists every discovered shortcode through coverage refresh and keeps GET read-only",async()=>{
    const before=await(await fetch(baseUrl+"/api/coverage?handle=coverage_fixture")).json();
    expect(before.coverage.posts).toEqual([]);
    mkdirSync(join(TMP,"data/profiles"),{recursive:true});
    writeFileSync(join(TMP,"data/profiles/coverage_fixture-profile.json"),JSON.stringify({username:"coverage_fixture",posts:[{shortcode:"MISSING_POST"}],reels:[{shortcode:"MISSING_REEL"}]}));
    const response=await post("/api/coverage/refresh",{handle:"coverage_fixture"});
    expect(response.status).toBe(200);
    const updated=await response.json();
    expect(updated.coverage.posts.map((p:any)=>p.shortcode).sort()).toEqual(["MISSING_POST","MISSING_REEL"]);
    expect(updated.coverage.posts.every((p:any)=>p.analysisStatus==="pending"&&p.reasons.length>0)).toBe(true);
    const persisted=await(await fetch(baseUrl+"/api/coverage?handle=coverage_fixture")).json();
    expect(persisted.coverage).toEqual(updated.coverage);
    expect((await post("/api/coverage/refresh",{handle:"../escape"})).status).toBe(400);
    expect((await post("/api/trinket-export",{handle:"coverage_fixture",targetDir:TMP})).status).toBe(400);
  });
});
