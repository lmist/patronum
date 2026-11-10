import { expect, test } from "bun:test";
import { solveChallenge, type ChallengeDriver } from "./solver.js";
import type { GridObservation } from "./recognition.js";

const observation = (round: number): GridObservation => ({ id: `grid-${round}`, round, capturedAt: new Date().toISOString(), gridSize: 3, kind: "selection", target: "buses", image: { mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUg==" } });

test("opens checkbox, recognizes replacements, verifies and observes completion", async () => {
  const actions: string[] = [];
  let state = 0;
  const driver: ChallengeDriver = {
    async inspect(round) {
      if (state === 0) return { kind: "checkbox" };
      if (state === 3) return { kind: "solved" };
      return { kind: "grid", observation: observation(round), fingerprint: `state-${state}`, dynamic: state === 1 };
    },
    async open() { actions.push("open"); state = 1; },
    async select(indices, fingerprint) { actions.push(`select:${indices}:${fingerprint}`); state = 2; return true; },
    async verify() { actions.push("verify"); state = 3; },
    async wait() {},
  };
  let calls = 0;
  const result = await solveChallenge(driver, { name: "fixture", async recognize() { return { selectedIndices: calls++ === 0 ? [0, 3] : [], confidence: 1 }; } });
  expect(result.status).toBe("solved");
  expect(actions).toEqual(["open", "select:0,3:state-1", "verify"]);
});

test("does not apply stale proposals or verify an uncertain selection", async () => {
  let reads = 0, clicks = 0;
  const driver: ChallengeDriver = {
    async inspect(round) { return { kind: "grid", observation: observation(round), fingerprint: `grid-${reads++}`, dynamic: false }; },
    async open() { clicks++; }, async select() { clicks++; return true; }, async verify() { clicks++; }, async wait() {},
  };
  const result = await solveChallenge(driver, { name: "fixture", async recognize() { return { selectedIndices: [0], confidence: 1 }; } }, { maxRounds: 2 });
  expect(result.status).toBe("failed");
  expect(clicks).toBe(0);
});

test("abstention terminates without clicking tiles or submitting", async () => {
  let clicks = 0;
  const driver: ChallengeDriver = {
    async inspect(round) { return { kind: "grid", observation: observation(round), fingerprint: "same", dynamic: false }; },
    async open() { clicks++; }, async select() { clicks++; return true; }, async verify() { clicks++; }, async wait() {},
  };
  const result = await solveChallenge(driver, { name: "fixture", async recognize() { return { selectedIndices: [0], confidence: 0.2 }; } });
  expect(result).toMatchObject({ status: "failed", reason: "low-confidence" });
  expect(clicks).toBe(0);
});
