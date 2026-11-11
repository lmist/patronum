import { expect, test } from "bun:test";
import { buildFsm } from "./fsm";
import { STAGES, countedStages, type Detail, type WorkflowStatus } from "../../api/types";
function fixture(status:WorkflowStatus, currentStage:string):Detail {
  return {workflow:{status,skipped:[]} ,currentStage,stages:Object.fromEntries(STAGES.map(name=>[name,{state:name===currentStage?"running":"idle"}]))} as Detail;
}
test("shows nine connected lifecycle states and the active stage",()=>{
  const fsm=buildFsm(fixture("PENDING","verify"));
  expect(fsm.nodes.map(n=>n.id)).toEqual(["queued",...STAGES,"complete"]);
  expect(fsm.current).toBe("Verify posts");
  expect(fsm.nodes.find(n=>n.id==="verify")?.state).toBe("running");
});
test("represents error and cancellation without claiming work is still running",()=>{
  expect(buildFsm(fixture("ERROR","analyze")).nodes.find(n=>n.id==="analyze")?.state).toBe("error");
  expect(buildFsm(fixture("CANCELLED","download")).nodes.find(n=>n.id==="download")?.state).toBe("cancelled");
});
test("distinguishes skipped publishing from a completed job",()=>{
  const detail=fixture("SUCCESS","done");detail.workflow.skipped=["knowledge"];
  const fsm=buildFsm(detail);
  expect(fsm.nodes.find(n=>n.id==="knowledge")?.state).toBe("skipped");
  expect(fsm.nodes.at(-1)?.state).toBe("done");
});

test("the retired knowledge stage counts only for a job that ran it", () => {
  expect(countedStages({})).toEqual(["preflight","scrape","verify","download","unique","analyze"]);
  expect(countedStages({knowledge:{state:"idle"}})).toHaveLength(6);
  expect(countedStages({knowledge:{state:"done"}})).toHaveLength(7);
});
