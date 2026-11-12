import { mkdirSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { AISdkClient, Stagehand } from "@browserbasehq/stagehand";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { layout } from "../paths.js";
import { resolveQwenApiKey, resolveQwenBaseUrl, resolveQwenModelName } from "../llm/qwen.js";
// AI SDK system-in-messages: re-applied by scripts/patch-stagehand-aisdk.mjs (postinstall)

const LOCAL_CONNECT_TIMEOUT_MS = 60_000;

/** Bound browser inference requests, including their streaming response body. */
export function browserInferenceFetch(input: Parameters<typeof fetch>[0], init?: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal,deadline]) : deadline;
  return fetch(input,{...init,signal});
}

export type CreateStagehandOptions = {
  /**
   * Local Stagehand action cache directory (relative to the data home).
   * Defaults to workflow-scoped cache/instagram-auth.
   */
  cacheDir?: string;
  /**
   * Chrome user-data directory for cookie/session persistence.
   * Defaults to data/chrome-profile (local stand-in for Browserbase contexts).
   */
  userDataDir?: string;
  /** Keep browser alive after close (local Chrome process detaches). */
  keepAlive?: boolean;
  /** Override headless (default: hidden; HEADLESS=false shows the window). */
  headless?: boolean;
};

import { DATA_HOME } from "../paths.js";
const root = DATA_HOME;

/** Absolute path for the Instagram auth action cache. */
export function resolveAuthCacheDir(
  relative = process.env.PATRONUM_AUTH_CACHE_DIR || layout.authCache,
): string {
  return resolve(root, relative);
}

/** Default Chrome profile dir — cookies persist across runs. */
export function resolveChromeProfileDir(
  relative = process.env.PATRONUM_CHROME_PROFILE_DIR || layout.chromeProfile,
): string {
  return resolve(root, relative);
}

/**
 * Stagehand on a **local** Chrome/Chromium with Qwen (qwen3.8-max)
 * via Alibaba Token Plan (OpenAI-compatible) and local action caching.
 * Auth cookies live in the Chrome user-data dir.
 */
export function createStagehand(opts: CreateStagehandOptions = {}): Stagehand {
  const apiKey = resolveQwenApiKey(process.env);
  const modelName = resolveQwenModelName(process.env);
  const baseURL = resolveQwenBaseUrl(process.env);

  const cacheDir = resolveAuthCacheDir(
    opts.cacheDir,
  );
  const userDataDir = opts.userDataDir
    ? resolve(root, opts.userDataDir)
    : resolveChromeProfileDir();
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });

  // Hidden unless asked for: HEADLESS=false (or 0) shows the window.
  const headless =
    opts.headless ??
    !(process.env.HEADLESS === "false" || process.env.HEADLESS === "0");

  // disableAPI: Stagehand LLM calls run locally against Qwen
  // cacheDir: local filesystem action cache
  // userDataDir + preserveUserDataDir: persist IG cookies between runs
  const stagehand = new Stagehand({
    env: "LOCAL",
    model: {
      modelName,
      apiKey,
      baseURL,
    },
    // Qwen uses chat/completions and system roles. The OpenAI adapter assumes
    // Responses API and developer roles for unknown model IDs.
    llmClient: new AISdkClient({
      model: createOpenAICompatible({
        name: "qwen",
        apiKey,
        baseURL,
        supportsStructuredOutputs: true,
        fetch: Object.assign(browserInferenceFetch,{preconnect:fetch.preconnect}),
      }).chatModel(modelName.replace(/^openai\//, "")),
    }),
    disableAPI: true,
    verbose: 0,
    cacheDir,
    ...(opts.keepAlive !== undefined ? { keepAlive: opts.keepAlive } : {}),
    localBrowserLaunchOptions: {
      headless,
      viewport: { width: 1280, height: 800 },
      userDataDir,
      preserveUserDataDir: true,
      // Large persisted profiles can outlast the SDK's 15-second default.
      connectTimeoutMs: LOCAL_CONNECT_TIMEOUT_MS,
    },
  });
  if (!opts.keepAlive) preserveCookiesOnClose(stagehand);
  cleanupFailedInit(stagehand, userDataDir);
  return stagehand;
}

/** The SDK can launch Chrome before recording it in its state. In that window,
 * an init failure leaves the profile locked even if Stagehand.close() runs.
 * Only terminate a new lock owner that is still a child of this process.
 */
function cleanupFailedInit(stagehand: Stagehand, userDataDir: string): void {
  const init = stagehand.init.bind(stagehand);
  stagehand.init = async () => {
    const priorOwner = profileOwnerPid(userDataDir);
    try {
      return await init();
    } catch (error) {
      await stagehand.close().catch(() => {});
      const owner = profileOwnerPid(userDataDir);
      if (owner && owner !== priorOwner && isOwnChromeChild(owner, userDataDir)) {
        try { process.kill(owner, "SIGTERM"); } catch { /* already exited */ }
      }
      throw error;
    }
  };
}

function profileOwnerPid(userDataDir: string): number | null {
  try {
    const lock = readlinkSync(resolve(userDataDir, "SingletonLock"));
    const pid = Number(/-(\d+)$/.exec(lock)?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isOwnChromeChild(pid: number, userDataDir: string): boolean {
  try {
    const line = execFileSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "command="], { encoding: "utf8" }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    const command = match?.[2] ?? "";
    const profileArg = `--user-data-dir=${userDataDir}`;
    return Number(match?.[1]) === process.pid &&
      (command.includes(`${profileArg} `) || command.endsWith(profileArg)) &&
      command.includes("--remote-debugging-port=");
  } catch {
    return false;
  }
}

/** Chrome must flush its cookie store before chrome-launcher force-kills it. */
function preserveCookiesOnClose(stagehand: Stagehand): void {
  const close = stagehand.close.bind(stagehand);
  let closing: Promise<void> | undefined;
  stagehand.close = (options) => {
    if (closing) return closing;
    closing = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = Date.now() + 5000;
      try {
        const conn = stagehand.context.conn;
        // Stagehand 3.7 treats a transport close as a crash. Unhook only its
        // shutdown handler while this close owns cleanup and waits for Chrome.
        const onClosed = (stagehand as unknown as { _onCdpClosed?: (why: string) => void })._onCdpClosed;
        if (onClosed) conn.offTransportClosed(onClosed);
        const shutdown = async () => {
          const { processInfo } = await conn.send<{ processInfo: Array<{ type: string; id: number }> }>("SystemInfo.getProcessInfo");
          const pid = processInfo.find(info => info.type === "browser")?.id;
          if (Date.now() >= deadline) return;
          await conn.send("Browser.close").catch(() => {});
          // Transport closure can precede cookie flushing; wait for process exit.
          while (pid && Date.now() < deadline) {
            try { process.kill(pid, 0); } catch { return; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        };
        await Promise.race([
          shutdown(),
          new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); }),
        ]);
      } catch {
        // Initialization failure or a disconnected browser still needs SDK cleanup.
      } finally {
        clearTimeout(timeout);
        await close(options);
        closing = undefined;
      }
    })();
    return closing;
  };
}

/** Local runs have no Browserbase live URL — surface the Chrome profile path. */
export function sessionLiveUrl(_stagehand?: Stagehand): string {
  return `local://${resolveChromeProfileDir()}`;
}

export function sessionIdOf(stagehand: Stagehand): string {
  const any = stagehand as unknown as {
    sessionId?: string;
    browserbaseSessionID?: string;
    browserbaseSessionId?: string;
  };
  return (
    any.sessionId ??
    any.browserbaseSessionID ??
    any.browserbaseSessionId ??
    "local"
  );
}
