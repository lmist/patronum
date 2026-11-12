import { expect, test } from "bun:test";
import { buildFsm } from "./fsm";
import { STAGES, countedStages, type Detail, type StageName, type WorkflowStatus } from "../../api/types";
const CURRENT_STAGES = ["preflight","scrape","verify","download","unique","analyze"];
function fixture(status:WorkflowStatus, currentStage:string, done:StageName[]=[]):Detail {
  return {workflow:{status,skipped:[]} ,currentStage,stages:Object.fromEntries(STAGES.map(name=>[name,{state:name===currentStage?"running":done.includes(name)?"done":"idle"}]))} as Detail;
}
test("draws the six current stages between Queued and Complete, and marks the active one",()=>{
  const fsm=buildFsm(fixture("PENDING","verify"));
  expect(fsm.nodes.map(n=>n.id)).toEqual(["queued",...CURRENT_STAGES,"complete"]);
  expect(fsm.current).toBe("Verify posts");
  expect(fsm.nodes.find(n=>n.id==="verify")?.state).toBe("running");
});
test("draws the retired knowledge stage only for a job that ran it",()=>{
  const ran=buildFsm(fixture("SUCCESS","done",[...STAGES]));
  expect(ran.nodes.map(n=>n.id)).toEqual(["queued",...STAGES,"complete"]);
  expect(ran.nodes.find(n=>n.id==="knowledge")?.state).toBe("done");
  const skipped=fixture("SUCCESS","done",CURRENT_STAGES as StageName[]);skipped.workflow.skipped=["knowledge"];
  expect(buildFsm(skipped).nodes.some(n=>n.id==="knowledge")).toBe(false);
  expect(buildFsm(undefined).nodes).toHaveLength(8);
});
test("snakes through rows of three with six stages and with seven",()=>{
  const place=(detail:Detail)=>buildFsm(detail).nodes.map(n=>[n.row,n.column,n.direction]);
  const firstRows=[[1,1,"right"],[1,2,"right"],[1,3,"down"],[2,3,"left"],[2,2,"left"],[2,1,"down"]];
  expect(place(fixture("PENDING","verify"))).toEqual([...firstRows,[3,1,"right"],[3,2,"none"]]);
  expect(place(fixture("SUCCESS","done",[...STAGES]))).toEqual([...firstRows,[3,1,"right"],[3,2,"right"],[3,3,"none"]]);
});
test("represents error and cancellation without claiming work is still running",()=>{
  const failed=buildFsm(fixture("ERROR","analyze"));
  expect(failed.nodes.find(n=>n.id==="analyze")?.state).toBe("error");
  expect(failed.stoppedAt).toBe("Analyze");
  expect(buildFsm(fixture("CANCELLED","download")).nodes.find(n=>n.id==="download")?.state).toBe("cancelled");
});
test("distinguishes a skipped stage from a completed job",()=>{
  const detail=fixture("SUCCESS","done",["preflight","scrape","verify","download","unique"]);detail.workflow.skipped=["knowledge","analyze"];
  const fsm=buildFsm(detail);
  expect(fsm.nodes.find(n=>n.id==="analyze")?.state).toBe("skipped");
  expect(fsm.nodes.at(-1)?.id).toBe("complete");
  expect(fsm.nodes.at(-1)?.state).toBe("done");
});

test("the retired knowledge stage counts only for a job that ran it", () => {
  expect(countedStages({})).toEqual(["preflight","scrape","verify","download","unique","analyze"]);
  expect(countedStages({knowledge:{state:"idle"}})).toHaveLength(6);
  expect(countedStages({knowledge:{state:"done"}})).toHaveLength(7);
});
