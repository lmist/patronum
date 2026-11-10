import { appendFileSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact";
import { layout } from "../paths";
const file = process.argv[2]!;
let launch = JSON.parse(readFileSync(file, "utf8"));
while (!launch.pid) { await Bun.sleep(10); launch = JSON.parse(readFileSync(file, "utf8")); }
function save() { const tmp = file + ".worker.tmp"; writeFileSync(tmp, JSON.stringify(launch)); renameSync(tmp, file); }
function line(tag: string, text: string) {
  const safe = redact(text);
  appendFileSync(launch.logPath, `${new Date().toISOString()} [${tag}] ${safe}\n`);
}
line("action", `${launch.kind} started`);
try {
  const child = Bun.spawn(launch.argv, { cwd: launch.cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); });
  let output = "";
  async function drain(stream: ReadableStream<Uint8Array>, tag: string) {
    let pending = "";
    for await (const chunk of stream) {
      pending += new TextDecoder().decode(chunk);
      const lines = pending.split(/\r?\n/); pending = lines.pop()!;
      for (const entry of lines) { line(tag, entry); if (tag === "stdout") output = (output + entry + "\n").slice(-262144); }
    }
    if (pending) { line(tag, pending); if (tag === "stdout") output += pending; }
  }
  const drains = Promise.all([drain(child.stdout, "stdout"), drain(child.stderr, "stderr")]);
  const code = await child.exited;
  await drains;
  launch.exitCode = code; launch.exitAt = Date.now();
  launch.status = stopping ? "stopped" : code === 0 ? "completed" : `failed (exit ${code})`;
  for (let index = output.lastIndexOf("{"); index >= 0; index = output.lastIndexOf("{", index - 1)) {
    try { launch.result = JSON.parse(redact(output.slice(index).trim())); break; } catch {}
    if (index === 0) break;
  }
  // The dashboard passes the data home in PATRONUM_HOME; older launch files only knew the working directory.
  const home = process.env.PATRONUM_HOME ?? launch.cwd;
  if (typeof launch.result?.workflowId === "string") { launch.originalWorkflowId = launch.workflowId; launch.workflowId = launch.result.workflowId; }
  if (launch.result?.ok === false && code === 0) launch.status = "failed";
  if (["run","resume"].includes(launch.kind) && launch.handle && existsSync(join(home,layout.profileJson(launch.handle)))) {
    try {
      const {reconcileCoverage} = await import("./coverage");
      const coverage = await reconcileCoverage(home,process.env.IGDASH_DB??join(home,layout.jobsDb),launch.handle);
      line("coverage",JSON.stringify(coverage.summary));
    } catch(error) { line("coverage",`Coverage update failed: ${String(error)}`); }
  }
  line("action", `${launch.kind} ${launch.status}`);
  save();
} catch (error) {
  launch.exitCode = 1; launch.exitAt = Date.now(); launch.status = "failed";
  line("error", String(error)); save();
}
