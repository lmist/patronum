/**
 * Results, coverage and wiki export for one profile.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { log } from "./log";
import { json } from "./http";
import { collectResults } from "./results";
import { HOME, DB_PATH } from "./settings";
import { layout } from "../paths";
import { allowedArtifact } from "./files";

export async function results(handle: string) {
  return collectResults(HOME, handle, allowedArtifact);
}

export type TrinketExport = { status: "running" | "complete" | "failed"; targetDir: string; result?: unknown; error?: string };

export const trinketExports = new Map<string, TrinketExport>();

export function saveTrinketExport(handle:string,state:TrinketExport) {
  const folder=join(HOME,layout.trinketExports);
  mkdirSync(folder,{recursive:true});
  const file=join(folder,handle+".json");
  writeFileSync(file+".tmp",JSON.stringify(state));
  renameSync(file+".tmp",file);
}

export function readTrinketExport(handle:string):TrinketExport|null {
  const active=trinketExports.get(handle);
  if(active)return active;
  try {
    const state=JSON.parse(readFileSync(join(HOME,layout.trinketExport(handle)),"utf8")) as TrinketExport;
    if(state.status==="running")return {...state,status:"failed",error:"Export was interrupted. Export again to finish the snapshot."};
    return state;
  } catch {return null;}
}

export const coverageRefreshes = new Map<string, Promise<unknown>>();

export function refreshCoverage(handle: string) {
  const current = coverageRefreshes.get(handle);
  if (current) return current;
  const work = import("./coverage").then(m => m.reconcileCoverage(HOME, DB_PATH, handle))
    .finally(() => coverageRefreshes.delete(handle));
  coverageRefreshes.set(handle, work);
  return work;
}

/** Start copying a finished profile into an OpenKnowledge wiki folder. Replies at once; the copy runs in the background. */
export function startTrinketExport(handle: string, requestedDir: unknown): Response {
    if (trinketExports.get(handle)?.status === "running") return json({ok:false,error:"An export is already running for this profile."},409);
    const targetDir = resolve(String(requestedDir || join(homedir(),"Desktop",handle+"-Trinket-Box")));
    if (!existsSync(join(targetDir,".ok"))) return json({ok:false,error:"Choose an initialized OpenKnowledge folder."},400);
    const state: TrinketExport = {status:"running",targetDir};
    trinketExports.set(handle,state);
    saveTrinketExport(handle,state);
    void (async()=>{
      const {OpenKnowledgeMcpSink} = await import("../export/open-knowledge");
      const sink = new OpenKnowledgeMcpSink(targetDir);
      try {
        const {exportTrinket} = await import("../export/trinket");
        const coverage = await refreshCoverage(handle) as import("./coverage").CoverageSnapshot;
        const result = await exportTrinket({root:HOME,handle,targetDir},sink);
        const indexPath = resolve(targetDir,result.indexPath);
        const snapshotDir = resolve(indexPath,"..");
        writeFileSync(join(snapshotDir,"coverage.json"),JSON.stringify(coverage,null,2));
        const exportDb = new Database(join(snapshotDir,"coverage.sqlite"));
        try {
          exportDb.exec("CREATE TABLE IF NOT EXISTS post_coverage (shortcode TEXT PRIMARY KEY, analysis_status TEXT NOT NULL, in_current_scrape INTEGER NOT NULL, record_json TEXT NOT NULL)");
          const insert = exportDb.query("INSERT OR REPLACE INTO post_coverage VALUES (?, ?, ?, ?)");
          exportDb.transaction(()=>{
            for (const post of coverage.posts) insert.run(post.shortcode,post.analysisStatus,post.inCurrentScrape?1:0,JSON.stringify(post));
          })();
        } finally { exportDb.close(); }
        state.result = result;
        state.status = "complete";
      } catch(error) {
        state.status = "failed";
        state.error = (error as Error).message;
        log.error("trinket export failed",{err:state.error});
      } finally { await sink.close().catch(()=>{}); saveTrinketExport(handle,state); }
    })().catch(error=>{state.status="failed";state.error=String(error);saveTrinketExport(handle,state);});
    return json({ok:true,export:state},202);
}
