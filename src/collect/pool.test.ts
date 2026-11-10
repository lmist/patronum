import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { DEFAULT_DETAIL_WORKERS, mapPool } from "./pool.js";

const scratch =
  process.env.PATRONUM_SCRATCH ??
  "/var/folders/kp/qyf0y_kj4l103v0zhcn0g4440000gn/T/grok-goal-acafb74c8909/implementer";

describe("detail-pass bounded concurrency pool", () => {
  it("defaults to 10 workers", () => {
    assert.equal(DEFAULT_DETAIL_WORKERS, 10);
  });

  it("returns results in input-index order even when later jobs finish first", async () => {
    const items = [1, 2, 3, 4, 5];
    const started: number[] = [];
    const finished: number[] = [];
    const out = await mapPool(items, 3, async (item, index) => {
      started.push(index);
      // later indices finish sooner
      await new Promise((r) => setTimeout(r, (items.length - index) * 15));
      finished.push(index);
      return item * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
    assert.ok(finished[0] !== 0, "first-finished should not be index 0");
  });

  it("10 workers vs serial is ≥8x on delayed jobs (same results)", async () => {
    const delayMs = 80;
    const n = 20;
    const jobs = Array.from({ length: n }, (_, i) => i + 1);

    const work =
      (label: string) =>
      async (item: number, _index: number): Promise<number> => {
        void label;
        await new Promise((r) => setTimeout(r, delayMs));
        return item;
      };

    const t0 = performance.now();
    const serial = await mapPool(jobs, 1, work("serial"));
    const tSerial = performance.now() - t0;

    const t1 = performance.now();
    const parallel = await mapPool(jobs, 10, work("parallel"));
    const tParallel = performance.now() - t1;

    assert.deepEqual(serial, jobs);
    assert.deepEqual(parallel, jobs);

    const ratio = tSerial / tParallel;
    const line = `serial_ms=${tSerial.toFixed(1)} parallel_ms=${tParallel.toFixed(1)} ratio=${ratio.toFixed(2)} n=${n} delay_ms=${delayMs} workers=10\n`;
    mkdirSync(scratch, { recursive: true });
    writeFileSync(`${scratch}/pool-bench.txt`, line, "utf8");
    console.log(line.trim());
    assert.ok(
      ratio >= 8,
      `expected serial/parallel ≥ 8, got ${ratio.toFixed(2)} (serial=${tSerial.toFixed(0)}ms parallel=${tParallel.toFixed(0)}ms)`,
    );
  });
});
