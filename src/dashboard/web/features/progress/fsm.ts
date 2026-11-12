import { STAGES, STAGE_HINTS, STAGE_LABELS, countedStages, isRunning, statusLabel, type Detail, type StageName } from "../../api/types";
export type NodeState = "idle" | "running" | "done" | "error" | "skipped" | "cancelled";
export type Direction = "right" | "left" | "down" | "none";
export interface FsmNode {
  id: string; name: string; label: string; hint: string; state: NodeState; status: string;
  stage: StageName | null; direction: Direction; column: number; row: number;
}
const COLUMNS = 3;
/** The diagram snakes through rows of three: left to right, down, right to left, down. Works for any node count. */
export function snake(index: number, count: number): {column: number; row: number; direction: Direction} {
  const row = Math.floor(index / COLUMNS), position = index % COLUMNS, forward = row % 2 === 0;
  return {
    row: row + 1,
    column: forward ? position + 1 : COLUMNS - position,
    direction: index === count - 1 ? "none" : position === COLUMNS - 1 ? "down" : forward ? "right" : "left",
  };
}
export function buildFsm(detail: Detail | undefined) {
  const workflow = detail?.workflow;
  const status = workflow?.status;
  const failed = status === "ERROR" || status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED";
  // The retired knowledge stage is drawn only for an old job that ran it.
  const stages = countedStages(detail?.stages).map(name => {
    let state: NodeState = detail?.stages[name]?.state ?? "idle";
    if (workflow?.skipped?.includes(name)) state = "skipped";
    else if (failed && detail?.currentStage === name) state = "error";
    else if (state === "running" && status === "CANCELLED") state = "cancelled";
    else if (state === "running" && !isRunning(status)) state = "idle";
    return {id:name,name,label:STAGE_LABELS[name],hint:STAGE_HINTS[name],state,stage:name,
      status:({idle:"Waiting",running:"Running",done:"Complete",error:"Failed",skipped:"Skipped",cancelled:"Interrupted"} as const)[state]};
  });
  const steps: Omit<FsmNode, "direction" | "column" | "row">[] = [
    {id:"queued",name:"Queued",label:"Queued",hint:"Waiting for a worker",state:status==="ENQUEUED"?"running":workflow?"done":"idle",status:status==="ENQUEUED"?"Current":"Accepted",stage:null},
    ...stages,
    {id:"complete",name:"Complete",label:"Complete",hint:"Job finished",state:status==="SUCCESS"?"done":"idle",status:status==="SUCCESS"?"Final state":"Waiting",stage:null},
  ];
  const nodes: FsmNode[] = steps.map((step,index)=>({...step,...snake(index,steps.length)}));
  const stopped = nodes.find(node=>node.state==="error"||node.state==="cancelled");
  return {
    nodes,
    current: status==="PENDING" && detail?.currentStage && STAGES.includes(detail.currentStage as StageName)
      ? STAGE_LABELS[detail.currentStage as StageName] : statusLabel(status),
    failed,
    cancelled: status==="CANCELLED",
    /** The stage a failed or cancelled job stopped at, named as its card in the diagram is, when the job records one. */
    stoppedAt: stopped ? stopped.name[0]!.toUpperCase() + stopped.name.slice(1) : null,
  };
}
