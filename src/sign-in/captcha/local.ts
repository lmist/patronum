import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localConfig } from "./config.js";
import { RecognitionError, type RecognitionBackend } from "./recognition.js";

export function createLocalBackend(config = localConfig()): RecognitionBackend {
  return {
    name: "local-onnx",
    async recognize(observation, signal) {
      if (observation.gridSize !== 3) throw new RecognitionError("unsupported-grid");
      if (signal.aborted) throw new RecognitionError("timeout");
      return new Promise((resolve, reject) => {
        const child = spawn(config.python, [fileURLToPath(new URL("./local_inference.py", import.meta.url)), "--model", config.modelPath], {
          stdio: ["pipe", "pipe", "ignore"],
          env: { PATH: "/usr/bin:/bin", PYTHONNOUSERSITE: "1", OMP_NUM_THREADS: "2" },
        });
        let output = "";
        let settled = false;
        const finish = (error?: RecognitionError, value?: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          error ? reject(error) : resolve(value);
        };
        const abort = () => { child.kill("SIGKILL"); finish(new RecognitionError("timeout")); };
        signal.addEventListener("abort", abort, { once: true });
        child.on("error", () => finish(new RecognitionError("model-unavailable")));
        child.stdin.on("error", () => finish(new RecognitionError("backend-error")));
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.length > 64_000) { child.kill("SIGKILL"); finish(new RecognitionError("invalid-response")); }
        });
        child.on("close", (code) => {
          if (code !== 0) return finish(new RecognitionError("model-unavailable"));
          try { finish(undefined, JSON.parse(output)); } catch { finish(new RecognitionError("invalid-response")); }
        });
        child.stdin.end(JSON.stringify(observation));
      });
    },
  };
}
