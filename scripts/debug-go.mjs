import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "v1.27.1";
const dlv = join(root, "bin", process.platform === "win32" ? "dlv.exe" : "dlv");
const mode = process.argv[2] ?? "check";
const pkg = process.argv[3] ?? "./cmd/igunique";
const test = process.argv[4] ?? "^TestSelectPostMedia$";
const symbol = "github.com/gts/patronum/cmd/igunique.selectPostMedia";
const outputRoot = join(root, "data", "debug", "go");
const timeoutMs = Number(process.env.DEBUG_TIMEOUT_MS ?? 45000);

// Each unattended debugger owns a process group so a stalled debugserver and
// its test process are stopped together. Interactive sessions retain the TTY.
async function run(command, args, { timeout = timeoutMs, interactive = false, env = process.env } = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root, env, detached: !interactive && process.platform !== "win32",
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const stop = (signal) => {
      try {
        if (!interactive && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    // The foreground terminal delivers Ctrl-C directly to an interactive
    // debugger, where it means pause the target rather than quit Delve.
    const interrupt = () => { if (!interactive) stop("SIGTERM"); };
    const terminate = () => stop("SIGTERM");
    process.on("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    let hardStop;
    const timer = !interactive && setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      hardStop = setTimeout(() => stop("SIGKILL"), 1500);
    }, timeout);
    const append = chunk => { output += chunk.toString(); process.stdout.write(chunk); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(hardStop);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    };
    child.on("error", err => { cleanup(); reject(err); });
    child.on("close", code => {
      // A debugger can exit before its helper responds to SIGTERM.
      if (timedOut) stop("SIGKILL");
      cleanup();
      resolveRun({ code, output, timedOut });
    });
  });
}

async function requireSuccess(command, args, options) {
  const result = await run(command, args, options);
  if (result.timedOut || result.code !== 0) throw new Error(`${command} ${result.timedOut ? "timed out" : `exited ${result.code}`}`);
  return result.output;
}

async function main() {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 500) throw new Error("DEBUG_TIMEOUT_MS must be at least 500");
  if (!["setup", "check", "test", "lldb"].includes(mode)) throw new Error("Usage: bun scripts/debug-go.mjs setup|check|test|lldb [package] [test regexp]");
  if (mode === "setup") {
    mkdirSync(join(root, "bin"), { recursive: true });
    await requireSuccess("go", ["install", `github.com/go-delve/delve/cmd/dlv@${version}`], {
      timeout: 120000, env: { ...process.env, GOBIN: join(root, "bin"), GOWORK: "off" },
    });
    if (process.platform === "darwin") {
      const enabled = await run("/usr/sbin/DevToolsSecurity", ["-enable"]);
      if (enabled.code !== 0 || enabled.timedOut) throw new Error("macOS requires local administrator authentication: run sudo /usr/sbin/DevToolsSecurity -enable in your terminal, then make debug-check. Do not put a password in this repo.");
    }
    await requireSuccess(dlv, ["version"]);
    console.log("Debugger installed. Run make debug-check to verify a breakpoint.");
    return;
  }
  if (!existsSync(dlv)) throw new Error("Repo-local Delve is missing. Run make debug-setup.");
  if (process.platform === "darwin") {
    const status = spawnSync("/usr/sbin/DevToolsSecurity", ["-status"], { encoding: "utf8" });
    if (!/currently enabled/.test(status.stdout ?? "")) throw new Error("macOS Developer Tools access is disabled. Run make debug-setup.");
  }
  mkdirSync(outputRoot, { recursive: true });
  const dir = mkdtempSync(join(outputRoot, "session-"));
  console.log(`Debug artifacts: ${dir}`);
  const binary = join(dir, "package.test");
  if (mode === "test") {
    await requireSuccess(dlv, ["test", pkg, "--output", binary, "--", "-test.run", test, "-test.v"], { interactive: true });
    return;
  }
  if (mode === "lldb") {
    await requireSuccess("go", ["test", "-c", "-gcflags=all=-N -l", "-o", binary, pkg], { timeout: 120000 });
    await requireSuccess("lldb", ["--", binary, "-test.run", test, "-test.v"], { interactive: true });
    return;
  }
  // Smoke checks use only the isolated ownership fixture, never a live job.
  const result = await run(dlv, ["test", "./cmd/igunique", "--output", binary,
    "--init", join(root, "scripts", "debug-go-smoke.dlv"), "--allow-non-terminal-interactive",
    "--", "-test.run", "^TestSelectPostMedia$", "-test.v"]);
  writeFileSync(join(dir, "delve.log"), result.output);
  if (result.timedOut || result.code !== 0 || !/\[Breakpoint 1\]/.test(result.output) || !/"POST"/.test(result.output) || !/--- PASS: TestSelectPostMedia/.test(result.output)) {
    throw new Error(`Delve did not complete the breakpoint/local-variable check${result.timedOut ? " before the timeout" : ""}. See ${join(dir, "delve.log")}`);
  }
  if (process.platform === "darwin") {
    // Delve removes its test binary on exit; build another for LLDB.
    await requireSuccess("go", ["test", "-c", "-gcflags=all=-N -l", "-o", binary, "./cmd/igunique"], { timeout: 120000 });
    const lldb = await run("lldb", ["--batch", "-o", `breakpoint set --name ${symbol}`, "-o", "run",
      "-o", "thread backtrace -c 3", "-o", "breakpoint delete 1", "-o", "continue",
      "--", binary, "-test.run", "^TestSelectPostMedia$", "-test.v"]);
    writeFileSync(join(dir, "lldb.log"), lldb.output);
    if (lldb.timedOut || lldb.code !== 0 || !/stop reason = breakpoint/.test(lldb.output) || !/--- PASS: TestSelectPostMedia/.test(lldb.output)) {
      throw new Error(`LLDB did not complete its breakpoint check. See ${join(dir, "lldb.log")}`);
    }
  }
  console.log('PASS: real breakpoint reached, Delve read Shortcode="POST", and the test completed.');
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });
