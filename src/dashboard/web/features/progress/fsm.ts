import { STAGES, STAGE_LABELS, isRunning, statusLabel, type Detail, type StageName } from "../../api/types";
export type NodeState = "idle" | "running" | "done" | "error" | "skipped" | "cancelled";
export interface FsmNode {
  id: string; name: string; label: string; state: NodeState; status: string;
  stage: StageName | null; direction: "right" | "left" | "down" | "none";
}
export function buildFsm(detail: Detail | undefined) {
  const workflow = detail?.workflow;
  const status = workflow?.status;
  const stages = STAGES.map(name => {
    let state: NodeState = detail?.stages[name]?.state ?? "idle";
    if (workflow?.skipped?.includes(name)) state = "skipped";
    else if ((status === "ERROR"||status==="MAX_RECOVERY_ATTEMPTS_EXCEEDED") && detail?.currentStage === name) state = "error";
    else if (state === "running" && status === "CANCELLED") state = "cancelled";
    else if (state === "running" && !isRunning(status)) state = "idle";
    return {id:name,name,label:STAGE_LABELS[name],state,stage:name,
      status:({idle:"Waiting",running:"Running",done:"Complete",error:"Failed",skipped:"Skipped",cancelled:"Interrupted"} as const)[state]};
  });
  const nodes: FsmNode[] = [
    {id:"queued",name:"Queued",label:"Waiting for a worker",state:status==="ENQUEUED"?"running":workflow?"done":"idle",status:status==="ENQUEUED"?"Current":"Accepted",stage:null,direction:"right"},
    ...stages.map(s=>({...s,direction:"right" as const})),
    {id:"complete",name:"Complete",label:"Job finished",state:status==="SUCCESS"?"done":"idle",status:status==="SUCCESS"?"Final state":"Waiting",stage:null,direction:"none"},
  ];
  nodes.forEach((node,index)=>{node.direction=[2,5].includes(index)?"down":index>=3&&index<=4?"left":index===8?"none":"right";});
  return {
    nodes,
    current: status==="PENDING" && detail?.currentStage && STAGES.includes(detail.currentStage as StageName)
      ? STAGE_LABELS[detail.currentStage as StageName] : statusLabel(status),
    failed: status==="ERROR"||status==="MAX_RECOVERY_ATTEMPTS_EXCEEDED",
    cancelled: status==="CANCELLED",
  };
}
