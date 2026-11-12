/**
 * Account actions: check the model, check or renew the Instagram login,
 * recognise a saved image-verification capture, close an idle Chrome.
 */
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { redact } from "./redact";
import { join, resolve } from "node:path";
import { HOME, ROOT } from "./settings";
import { layout } from "../paths";
import { openDb, listWorkflows } from "./job-store";
import { json, readJson } from "./http";
import {
  type Launch,
  launches,
  refreshLaunches,
  browserBusy,
  spawnDetached,
  summarizeLaunch,
} from "./launcher";
import { allowedArtifact } from "./files";

export async function handleAction(req: Request) {
  let body: Record<string, unknown>;
  try { body = await readJson(req); } catch { return json({ok:false,error:"body must be a JSON object"},400); }
  const action = String(body.action ?? "");
  if (action === "close-collection-browser") {
    refreshLaunches();
    if (browserBusy() || [...launches.values()].some(l=>l.exitCode==null&&["run","resume"].includes(l.kind))) return json({ok:false,error:"Wait for active collection and login actions to finish before closing Chrome."},409);
    const db = openDb();
    try {
      if (db && listWorkflows(db,{limit:500,parentsOnly:true}).some(w=>["PENDING","ENQUEUED"].includes(w.status))) return json({ok:false,error:"An active workflow still owns the collection browser."},409);
    } finally { db?.close(); }
    const profile = resolve(process.env.PATRONUM_CHROME_PROFILE_DIR ?? join(HOME,layout.chromeProfile));
    const processList = Bun.spawn(["ps","-axo","pid=,command="],{stdout:"pipe",stderr:"pipe"});
    const output = await new Response(processList.stdout).text();
    if (await processList.exited!==0) return json({ok:false,error:"Could not inspect browser ownership."},500);
    const pids = output.split("\n").flatMap(line=>{
      const match = line.trim().match(/^(\d+) (.*)$/);
      if (!match || !match[2]!.includes("/Google Chrome --") || match[2]!.includes("--type=")) return [];
      const owned = /--user-data-dir=(.*?)(?: --|$)/.exec(match[2]!);
      return owned?.[1]===profile ? [Number(match[1])] : [];
    });
    for (const pid of pids) { try {process.kill(pid,"SIGTERM");} catch(error) {if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;} }
    return json({ok:true,status:"completed",message:pids.length?"Closed the inactive collection browser. Saved login files are preserved.":"No inactive collection browser was found."});
  }
  if (action === "recognize-captcha") {
    if (body.confirmed !== true) return json({ok:false,error:"Confirm recognition of this capture before running it."},400);
    const backend = String(body.backend ?? "local");
    if (!["local","vision"].includes(backend)) return json({ok:false,error:"Backend must be local or vision"},400);
    const captureId = String(body.captureId ?? "");
    if (!/^[A-Za-z0-9_-]+$/.test(captureId)) return json({ok:false,error:"Select a checkpoint capture"},400);
    const path = allowedArtifact(`${layout.captchaCaptures}/${captureId}/observation.json`);
    const captureRoot = join(HOME,layout.captchaCaptures) + "/";
    if (!path || !path.startsWith(captureRoot) || !path.endsWith("/observation.json") || !existsSync(path) || !realpathSync(path).startsWith(captureRoot)) return json({ok:false,error:"Select an existing checkpoint observation"},400);
    const command = process.env.IGDASH_CAPTCHA_CMD ? JSON.parse(process.env.IGDASH_CAPTCHA_CMD) : [process.execPath,join(ROOT,"src/sign-in/captcha/cli.ts")];
    const launch = spawnDetached({kind:"recognize-captcha",handle:null,workflowId:null,tailArgs:["recognize","--observation",path,"--backend",backend],command,logStem:"recognize-captcha",detached:true});
    return json({ok:true,...summarizeLaunch(launch)});
  }
  if (!["preflight", "warm-session", "cold-login", "recover-login"].includes(action)) return json({ok:false,error:"Unknown action"},400);
  const busy = browserBusy();
  if (action !== "preflight" && busy) return json({ok:false,error:"A browser action is already running.",pid:busy.pid},409);
  // Hidden like everything else, unless .env asks for the window. Completing a
  // verification is the exception: a person has to see the page to do it.
  const visible = action === "recover-login" || process.env.HEADLESS === "false" || process.env.HEADLESS === "0";
  const env: Record<string,string> = {HEADLESS: visible ? "false" : "true"};
  let source: Launch | undefined;
  if (body.sourcePid != null) {
    refreshLaunches(); source = launches.get(Number(body.sourcePid));
    if (!source || !["cold-login","warm-session","recover-login"].includes(source.kind)) return json({ok:false,error:"Unknown source login action"},400);
    if (source.profileDir) env.PATRONUM_CHROME_PROFILE_DIR = source.profileDir;
    if (source.cacheDir) env.PATRONUM_AUTH_CACHE_DIR = source.cacheDir;
  }
  if (action === "cold-login") {
    const id = crypto.randomUUID();
    env.PATRONUM_CHROME_PROFILE_DIR = join(HOME,layout.dashboardSessions,id,"profile");
    env.PATRONUM_AUTH_CACHE_DIR = join(HOME,layout.dashboardSessions,id,"cache");
  }
  const command = process.env.IGDASH_AUTH_CMD ? JSON.parse(process.env.IGDASH_AUTH_CMD) : [process.execPath, join(ROOT,"src/cmd/cli.ts")];
  const args = action === "preflight" ? ["preflight"] : action === "warm-session" ? ["session", "--check-only"] : action === "recover-login" ? ["login", "--keep-open"] : ["login"];
  const launch = spawnDetached({kind:action as Launch["kind"],handle:null,workflowId:null,tailArgs:args,logStem:action,detached:true,command,env,sourcePid:source?.pid});
  return json({ok:true,...summarizeLaunch(launch)});
}

/** The most recent saved image-verification captures, newest first. */
export async function listCaptchaCaptures(): Promise<Response> {
    const root = join(HOME,layout.captchaCaptures);
    const names = (await readdir(root,{withFileTypes:true}).catch(()=>[])).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort().reverse().slice(0,30);
    const captures = [];
    for (const name of names) {
      const path = `${layout.captchaCaptures}/${name}`;
      const diagnosticPath = allowedArtifact(`${path}/diagnostic.json`);
      if (!diagnosticPath || !existsSync(diagnosticPath)) continue;
      try {
        const diagnostic = JSON.parse(redact(await readFile(diagnosticPath,"utf8")));
        const observationPath = `${path}/observation.json`;
        captures.push({...diagnostic,id:name,path,capturePath:existsSync(join(HOME,observationPath))?observationPath:null,imageUrl:existsSync(join(HOME,path,"grid.png"))?`/api/file?path=${encodeURIComponent(path+"/grid.png")}`:null,diagnosticUrl:`/api/file?path=${encodeURIComponent(path+"/diagnostic.json")}`});
      } catch {}
    }
    return json({ok:true,captures,automaticSubmission:false});
}
