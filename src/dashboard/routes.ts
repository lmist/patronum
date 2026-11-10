/**
 * Which URL does what.
 *
 * One function that looks at the request and calls the file that handles it.
 * The full list of URLs is documented at the top of server.ts.
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { redact } from "./redact";
import { logHealth, recentLogs } from "./log";
import {
  HOME, ROOT,
  DB_PATH,
  LOG_ROOT,
  PORT,
} from "./settings";
import {
  displayErrorText,
  openDb,
  listWorkflows,
  getWorkflow,
  getSteps,
  getEvents,
  getEventHistory,
  getStream,
  getQueues,
  getExecutorSummary,
  deriveStages,
} from "./job-store";
import {
  guardPath,
  tailFile,
  summarizeArtifact,
  allowedArtifact,
} from "./files";
import {
  json,
  notFound,
  serveStatic,
  readJson,
} from "./http";
import {
  HANDLE_RE,
  handleRunPost,
  handleMapNetworkPost,
  handleResumePost,
  handleCancelPost,
  handleGcPost,
} from "./job-actions";
import { launches, refreshLaunches, recentLaunches, summarizeLaunch } from "./launcher";
import { handleAction, listCaptchaCaptures } from "./account-actions";
import { results, readTrinketExport, refreshCoverage, startTrinketExport } from "./exports";

// ————————— request routing —————————
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const method = req.method.toUpperCase();

  if (method === "GET" && p === "/api/captcha/captures") {
    return listCaptchaCaptures();
  }
  if (method === "GET" && p === "/api/captcha/status") {
    try {
      const {captchaReadiness} = await import(join(import.meta.dir,"../sign-in/captcha/config.ts"));
      return json({ok:true,...await captchaReadiness(process.env)});
    } catch { return json({ok:false,mode:"recognition-only",automaticSubmission:false,error:"Recognition readiness is unavailable. Complete verification manually in Chrome."}); }
  }
  if (method === "POST" && p === "/api/action") return handleAction(req);
  if (method === "POST" && p === "/api/action/stop") {
    const body = await readJson(req); refreshLaunches();
    const launch = launches.get(Number(body.pid));
    if (!launch || !["warm-session","cold-login","recover-login","map-network"].includes(launch.kind)) return json({ok:false,error:"Active browser action required"},400);
    if (launch.exitCode == null) { try { process.kill(launch.pid,"SIGTERM"); } catch {} }
    return json({ok:true,pid:launch.pid});
  }
  if (method === "GET" && p === "/api/actions") return json({ok:true,launches:recentLaunches(32)});
  if (method === "GET" && p === "/api/coverage") {
    const handle = url.searchParams.get("handle") ?? "";
    if (!HANDLE_RE.test(handle)) return json({ok:false,error:"A valid handle is required"},400);
    const {readCoverage} = await import("./coverage");
    return json({ok:true,coverage:readCoverage(DB_PATH,handle)});
  }
  if (method === "POST" && p === "/api/coverage/refresh") {
    const body = await readJson(req);
    const handle = String(body.handle ?? "");
    if (!HANDLE_RE.test(handle)) return json({ok:false,error:"A valid handle is required"},400);
    try { return json({ok:true,coverage:await refreshCoverage(handle)}); }
    catch (error) { return json({ok:false,error:(error as Error).message},400); }
  }
  if (method === "GET" && p === "/api/trinket-export") {
    const handle = url.searchParams.get("handle") ?? "";
    if (!HANDLE_RE.test(handle)) return json({ok:false,error:"A valid handle is required"},400);
    return json({ok:true,export:readTrinketExport(handle)});
  }
  if (method === "POST" && p === "/api/trinket-export") {
    const body = await readJson(req);
    const handle = String(body.handle ?? "");
    if (!HANDLE_RE.test(handle)) return json({ok:false,error:"A valid handle is required"},400);
    return startTrinketExport(handle, body.targetDir);
  }
  if (method === "GET" && p === "/api/results") {
    const handle = url.searchParams.get("handle") ?? "";
    if (!HANDLE_RE.test(handle)) return json({ok:false,error:"A valid handle is required"},400);
    return json(await results(handle));
  }
  if (method === "GET" && p === "/api/file") {
    const path = allowedArtifact(url.searchParams.get("path") ?? "");
    if (!path) return json({ok:false,error:"Artifact path is not allowed"},400);
    const info = await stat(path).catch(()=>null);
    if (!info?.isFile()) return notFound();
    if (!/\.(?:json|md|txt|log|jpe?g|png|webp|gif|mp4|mov)$/i.test(path)) return json({ok:false,error:"File type is not allowed"},400);
    const file = Bun.file(path);
    return new Response(/\.(?:json|md|txt|log)$/i.test(path) ? redact(await file.text()) : file,{headers:{"content-type":file.type,"x-content-type-options":"nosniff","cache-control":"no-store"}});
  }
  const actionLog = /^\/api\/launch\/(\d+)\/log$/.exec(p);
  if (method === "GET" && actionLog) {
    refreshLaunches(); const launch = launches.get(Number(actionLog[1]));
    if (!launch) return notFound();
    const lines = await tailFile(launch.logPath, url.searchParams.get("download") === "1" ? 8*1024*1024 : 128*1024);
    if (url.searchParams.get("download") === "1") return new Response(lines.join("\n"),{headers:{"content-type":"text/plain; charset=utf-8","content-disposition":`attachment; filename="action-${launch.pid}.log"`}});
    return json({ok:true,path:relative(HOME,launch.logPath),lines});
  }

  if (method === "GET" && p === "/api/health") {
    return json({
      ok: true,
      db: { path: relative(HOME, DB_PATH), exists: existsSync(DB_PATH) },
      root: ROOT,
    home: HOME,
      port: PORT,
      launches: recentLaunches(4),
      log: logHealth(),
      ts: Date.now(),
    });
  }
  if (method === "GET" && p === "/api/debug/log") {
    const n = Number(url.searchParams.get("n") ?? 80);
    return json({ ok: true, lines: recentLogs(n) });
  }

  if (method === "POST" && p === "/api/run") return handleRunPost(req);
  if (method === "POST" && p === "/api/map-network") return handleMapNetworkPost(req);
  if (method === "POST" && p === "/api/resume") return handleResumePost(req);
  if (method === "POST" && p === "/api/cancel") return handleCancelPost(req);
  if (method === "POST" && p === "/api/gc") return handleGcPost(req);

  if (method !== "GET" && method !== "HEAD") {
    if (p.startsWith("/api/")) return json({ ok: false, error: "method not allowed" }, 405);
    return new Response("method not allowed", { status: 405 });
  }

  if (!p.startsWith("/api/")) return serveStatic(p);

  // GET /api/launch/:pid
  const launchMatch = /^\/api\/launch\/(\d+)$/.exec(p);
  if (launchMatch) {
    const pid = Number(launchMatch[1]);
    refreshLaunches();
    const l = launches.get(pid);
    if (!l) return json({ ok: false, error: "not found" }, 404);
    return json({ ok: true, ...summarizeLaunch(l) });
  }

  refreshLaunches();
  const db = openDb();
  try {
    if (p === "/api/now") {
      if (!db) return json({ empty: true, workflows: [], queues: [], executor: null, launches: recentLaunches(), ts: Date.now() });
      const workflows = listWorkflows(db, { limit: 25, parentsOnly: true });
      const running = workflows.filter((w) => w.status === "PENDING" || w.status === "ENQUEUED");
      const runningWithStages = running.map((w) => {
        const steps = getSteps(db, w.id);
        const events = getEvents(db, w.id);
        const childSteps = steps.flatMap((step:any) => step.childWorkflowId ? getSteps(db,step.childWorkflowId) : []);
        const derived = deriveStages([...steps,...childSteps], events as any, w.status);
        return { ...w, currentStage: derived.currentStage, stages: derived.stages, progress: events.progress ?? null };
      });
      return json({
        empty: false,
        ts: Date.now(),
        executor: getExecutorSummary(db),
        queues: getQueues(db),
        running: runningWithStages,
        recent: workflows,
        launches: recentLaunches(),
      });
    }

    if (p === "/api/workflows") {
      if (!db) return json([]);
      const status = url.searchParams.get("status") ?? undefined;
      const handle = url.searchParams.get("handle") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return json(listWorkflows(db, { status, handle, limit }));
    }

    const wfMatch = /^\/api\/workflow\/([^/]+)(?:\/(steps|stream|log|events))?$/.exec(p);
    if (wfMatch) {
      const id = decodeURIComponent(wfMatch[1]);
      const sub = wfMatch[2];
      if (!db) return notFound("db missing");
      const wf = getWorkflow(db, id);
      if (!wf) return notFound("workflow not found");
      if (!sub) {
        const steps = getSteps(db, id);
        const events = getEvents(db, id);
        const childSteps = steps.flatMap((step:any) => step.childWorkflowId ? getSteps(db,step.childWorkflowId) : []);
        const derived = deriveStages([...steps,...childSteps], events as any, wf.status);
        const errorText = displayErrorText(events as Record<string, unknown>, steps, wf);
        return json({
          workflow: wf,
          events,
          history: getEventHistory(db, id),
          stages: derived.stages,
          currentStage: derived.currentStage,
          steps,
          errorText,
          internalStepCount: steps.filter((s: any) => s.internal).length,
        });
      }
      if (sub === "steps") return json(getSteps(db, id));
      if (sub === "events") return json({ events: getEvents(db, id), history: getEventHistory(db, id) });
      if (sub === "stream") {
        const key = url.searchParams.get("key") ?? "log";
        const off = Number(url.searchParams.get("since") ?? 0);
        return json(getStream(db, id, key, off));
      }
      if (sub === "log") {
        const stage = url.searchParams.get("stage") ?? "";
        if (stage === "all") {
          const lines: string[] = [];
          const ids = [id, ...getSteps(db,id).map((step:any)=>step.childWorkflowId).filter(Boolean)];
          for (const logId of ids) for (const name of await readdir(join(LOG_ROOT,logId)).catch(()=>[])) {
            if (!name.endsWith(".log")) continue;
            const path = guardPath(relative(HOME,join(LOG_ROOT,logId,name)));
            if (path) { const entries = await tailFile(path, 256*1024); if(entries.length) lines.push(`--- ${name} ---`,...entries); }
          }
          if (url.searchParams.get("download") === "1") return new Response(lines.join("\n"),{headers:{"content-type":"text/plain; charset=utf-8","content-disposition":`attachment; filename="workflow.log"`}});
          return json({exists:lines.length>0,lines});
        }
        if (!/^[a-z][a-z-]*$/.test(stage)) return json({ exists: false, lines: [] });
        const ids = [id, ...getSteps(db,id).map((step:any)=>step.childWorkflowId).filter(Boolean)];
        const lines: string[] = []; const paths: string[] = [];
        for (const logId of ids) for (const name of await readdir(join(LOG_ROOT,logId)).catch(()=>[])) {
          if (name !== `${stage}.log` && !name.startsWith(stage + "-")) continue;
          const guarded = guardPath(relative(HOME,join(LOG_ROOT,logId,name))); if(!guarded) continue;
          paths.push(relative(HOME,guarded)); lines.push(...await tailFile(guarded));
        }
        return json({path:paths[0] ?? null,paths,exists:paths.length>0,lines:lines.slice(-400)});
      }
    }

    if (p === "/api/artifact") {
      const raw = url.searchParams.get("path");
      if (!raw) return json({ error: "path required" }, 400);
      const abs = allowedArtifact(raw);
      if (!abs) return json({error:"Artifact path is not allowed"},400);
      const rel = relative(HOME, abs);
      if (rel.startsWith("..") || rel === "") return json({ error: "outside root" }, 400);
      const summary = await summarizeArtifact(abs);
      return json({ path: rel, ...summary });
    }

    return notFound("no route");
  } finally {
    if (db) db.close();
  }
}
