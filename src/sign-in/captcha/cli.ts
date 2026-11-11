import "dotenv/config";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { captchaReadiness, visionConfig } from "./config.js";
import { createLocalBackend } from "./local.js";
import { createVisionBackend } from "./vision.js";
import { RecognitionSession } from "./recognition.js";
import { inHome, layout } from "../../paths.js";

export async function runCaptchaCLI(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "status") { console.log(JSON.stringify(await captchaReadiness())); return 0; }
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(`CAPTCHA image recognition

  patronum captcha status
  patronum captcha recognize --observation <observation.json> --backend local|vision

Recognition prints a proposal only. Complete verification in the login browser.
Local: CAPTCHA_LOCAL_PYTHON / CAPTCHA_LOCAL_MODEL (defaults under data/captcha).
Vision uses the configured Qwen endpoint, model and key by default.
Custom vision: set all of CAPTCHA_VISION_BASE_URL, CAPTCHA_VISION_API_KEY and CAPTCHA_VISION_MODEL.
The vision backend sends the supplied grid image to that endpoint.
Local supports 3x3 and replacement tiles; vision also accepts 4x4 grids.
`);
    return 0;
  }
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !["--observation", "--backend"].includes(key) || !value || options[key]) { console.log(JSON.stringify({ status: "error", reason: "invalid-arguments" })); return 2; }
    options[key] = value;
  }
  if (command !== "recognize" || !options["--observation"] || !["local", "vision"].includes(options["--backend"] || "")) { console.log(JSON.stringify({ status: "error", reason: "invalid-arguments" })); return 2; }
  try {
    const file = Bun.file(options["--observation"]);
    if (file.size > 12_100_000) throw new Error();
    const observation = JSON.parse(await readFile(options["--observation"], "utf8"));
    const backend = options["--backend"] === "local" ? createLocalBackend() : createVisionBackend(visionConfig());
    const result = await new RecognitionSession(backend, { maxRounds: 1 }).recognize(observation);
    const diagnosticPath = resolve(inHome(layout.captchaDiagnostics), `${result.timestamp.replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`);
    await mkdir(dirname(diagnosticPath), { recursive: true, mode: 0o700 });
    await writeFile(diagnosticPath, JSON.stringify(result), { mode: 0o600 });
    console.log(JSON.stringify({ ...result, diagnosticPath }));
    return result.status === "proposed" ? 0 : 3;
  } catch { console.log(JSON.stringify({ status: "error", reason: "recognition-unavailable", manualFallback: true })); return 3; }
}

if (import.meta.main) process.exit(await runCaptchaCLI(process.argv.slice(2)));
