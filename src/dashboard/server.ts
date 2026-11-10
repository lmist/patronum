// Dashboard for the DBOS igflow host and local authentication.
// Bun.serve. Port 7799. Read-only DB access with durable command launches.
// One printed line: the URL.
//
// Route map:
//   GET  /                              → public/index.html
//   GET  /app.js, /styles.css, /*       → public/*
//   GET  /api/now                       → live snapshot (workflows + queues + host + recent launches)
//   GET  /api/workflows?status=&handle= → filtered list
//   GET  /api/workflow/:id              → status + stages + events + step summary
//   GET  /api/workflow/:id/steps        → ordered steps (operation_outputs)
//   GET  /api/workflow/:id/stream?key=  → decoded stream tail
//   GET  /api/workflow/:id/log?stage=   → tail of data/dbos/logs/<wf>/<stage>.log
//   GET  /api/health                    → process, db presence, log ring
//   GET  /api/debug/log?n=              → recent structured log events
//   GET  /api/artifact?path=            → guarded compact summary of a path under root
//   GET  /api/launch/:pid               → one launch's current status
//   GET  /api/actions                   → persisted command history
//   POST /api/action                    → provider check, session/login, confirmed recognition
//   POST /api/action/stop               → stop an owned authentication command
//   GET  /api/launch/:pid/log            → timestamped command log; download=1 exports
//   GET  /api/results?handle=            → post media, analysis, and knowledge artifacts
//   GET  /api/file?path=                 → allowlisted artifact content
//   GET  /api/captcha/status             → local/vision recognition readiness
//   GET  /api/captcha/captures           → saved checkpoint previews and diagnostics
//   POST /api/run                       → detached `igflow run …`
//   POST /api/map-network               → detached Instagram API mapping action
//   POST /api/resume                    → detached `igflow resume <wfid>`
//   POST /api/cancel                    → attached `igflow cancel <wfid>` (fast)
//   POST /api/gc                        → attached `igflow gc [flags]` (fast)
//
// Env:
//   IGDASH_ROOT         override repo root (default: two levels above src/dashboard/);
//                       when set, data lives there too (tests)
//   IGDASH_HOME         override the data home (default: PATRONUM_HOME, else ~/Documents/patronum)
//   IGDASH_PORT         override port (default 7799)
//   IGDASH_DB           override system db path
//   IGDASH_IGFLOW_CMD   JSON array argv prefix; default ["go","run","./cmd/igflow"]
//   IGDASH_AUTH_CMD     auth CLI argv prefix override for isolated tests
//   IGDASH_CAPTCHA_CMD  recognition CLI argv prefix override for isolated tests
//   IGDASH_LAUNCH_DIR   override launch-log dir (default data/dbos/logs/_launch)
//   IGDASH_LOG_FILE     structured JSONL log (default data/dbos/logs/_dash/igdash.log)
//   IGDASH_LOG_LEVEL    debug|info|warn|error (default info; /api/now is quiet)
//   IGFLOW_*            passed through to spawned processes (test seams)

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { log, newReqId, setLogFile, shouldLogRequest } from "./log";
import { json } from "./http";
import { useHandleFallback } from "./job-store";
import { workflowLaunch } from "./launcher";
import { handle } from "./routes";
import { DB_PATH, IGFLOW_CMD, LOG_ROOT, PORT, HOME, ROOT } from "./settings";

useHandleFallback((workflowId) => workflowLaunch(workflowId)?.handle);
setLogFile(process.env.IGDASH_LOG_FILE ?? join(LOG_ROOT, "_dash", "igdash.log"));

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const url = new URL(req.url);
    const reqId = newReqId();
    const t0 = Date.now();
    try {
      const res = await handle(req);
      const headers = new Headers(res.headers);
      headers.set("x-igdash-req", reqId);
      const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      const ms = Date.now() - t0;
      if (shouldLogRequest(url.pathname, out.status, req.method)) {
        const level = out.status >= 500 ? "error" : out.status >= 400 ? "warn" : "info";
        log[level]("http", {
          req: reqId,
          method: req.method,
          path: url.pathname,
          status: out.status,
          ms,
        });
      }
      return out;
    } catch (e) {
      const ms = Date.now() - t0;
      log.error("http crash", {
        req: reqId,
        method: req.method,
        path: url.pathname,
        status: 500,
        ms,
        err: (e as Error).stack ?? (e as Error).message,
      });
      return json({ ok: false, error: "internal" }, 500);
    }
  },
});

log.info("boot", {
  extra: {
    url: `http://${server.hostname}:${server.port}`,
    root: ROOT,
    home: HOME,
    db: relative(HOME, DB_PATH),
    dbExists: existsSync(DB_PATH),
    igflowCmd: IGFLOW_CMD,
  },
});
console.log(`http://${server.hostname}:${server.port}`);
