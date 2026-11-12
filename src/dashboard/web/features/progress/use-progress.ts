import { useState, type ChangeEvent } from "react";
import { useRead } from "../../api/queries";
import { useDashboard } from "../../state/app";
import { STAGE_LABELS, countedStages, duration, isRunning, type Log, type StageName } from "../../api/types";
import { buildFsm } from "./fsm";
export function useProgress() {
  const app=useDashboard(),detail=app.detail.data;
  const [internals,setInternals]=useState(false),[focus,setFocus]=useState<number|null>(null);
  const [logStage,setLogStage]=useState("all"),[follow,setFollow]=useState(true);
  const [frozen,setFrozen]=useState<string|null>(null);
  const [chosenStage,setChosenStage]=useState<StageName|null>(null);
  const active=isRunning(detail?.workflow.status);
  const log=useRead<Log>("/api/workflow/"+encodeURIComponent(app.workflowId)+"/log?stage="+logStage,Boolean(app.workflowId),active?1800:false);
  const lines=log.data?.lines.slice(-1200).join("\n")||"No activity recorded for this stage yet.";
  const selected=detail?.steps.find(s=>s.stepId===focus)??detail?.steps.find(s=>s.error)??detail?.steps.find(s=>!s.internal);
  const selectLog=(e:ChangeEvent<HTMLSelectElement>)=>{setLogStage(e.target.value);setFrozen(null);};
  const toggleFollow=(e:ChangeEvent<HTMLInputElement>)=>{setFollow(e.target.checked);setFrozen(e.target.checked?null:lines);};
  const rows=(detail?.steps??[]).filter(s=>internals||!s.internal).map(s=>({...s,
    status:s.error?"error":s.childWorkflowId?(s.childStatus??"Unknown"):s.completedAt?"done":s.startedAt&&active?"running":"idle",
    duration:s.childWorkflowId?(s.childCompletedAt||isRunning(s.childStatus??undefined)?duration(s.childStartedAt,s.childCompletedAt):"—"):(s.completedAt||active?duration(s.startedAt,s.completedAt):"—"),
    props:{onClick:()=>setFocus(s.stepId),"aria-pressed":s.stepId===selected?.stepId},
    childProps:{onClick:()=>s.childWorkflowId&&app.selectWorkflow(s.childWorkflowId)},
  }));
  // Only the stages this job is measured against: the retired knowledge stage appears for a job that ran it.
  const counted=countedStages(detail?.stages);
  const stages=counted.map(name=>({name,title:name[0]!.toUpperCase()+name.slice(1)}));
  const fsm=buildFsm(detail);
  const inspected=chosenStage??counted.find(s=>detail?.stages[s]?.state==="error")??(counted.includes(detail?.currentStage as StageName)?detail?.currentStage as StageName:[...counted].reverse().find(s=>detail?.stages[s]?.state==="done")??"preflight");
  const inspectedState=detail?.stages[inspected];
  const fsmNodes=fsm.nodes.map(node=>({...node,props:{
    onClick:()=>{if(node.stage){setChosenStage(node.stage);setLogStage(node.stage);setFocus(detail?.stages[node.stage]?.stepId??null);setFrozen(null);}},
    "aria-pressed":node.stage===inspected,
    "aria-label":node.name+": "+node.status,
  }}));
  const stopHelp=fsm.failed
    ? (fsm.stoppedAt?"This job stopped at "+fsm.stoppedAt+". ":"This job stopped with an error. ")+"Fix the cause shown above, then choose Resume collection to continue from that stage. Finished stages are not repeated."
    : fsm.cancelled?"This job was cancelled. Resume collection continues from the stage it stopped at.":"";
  return {app,detail,rows,selected,stages,log,logStage,selectLog,follow,toggleFollow,active,
    fsm,fsmNodes,stopHelp,inspected,inspectedLabel:STAGE_LABELS[inspected],inspectedName:inspected[0]!.toUpperCase()+inspected.slice(1),
    inspectedText:inspectedState?.error||inspectedState?.output?JSON.stringify(inspectedState.error??inspectedState.output,null,2):"No output recorded for this state yet.",
    toggleInternals:()=>setInternals(v=>!v),internals,
    logText:(!follow&&frozen!==null)?frozen:lines,
    followRef:(node:HTMLPreElement|null)=>{if(node&&follow)node.scrollTop=node.scrollHeight;},
    download:"/api/workflow/"+encodeURIComponent(app.workflowId)+"/log?stage="+logStage+"&download=1",
    selectedText:selected?JSON.stringify(selected.error??selected.output,null,2):"Choose a step to inspect its output.",
    lineage:detail?.workflow.forkedFrom??detail?.workflow.parentId,
    openLineage:()=>{const id=detail?.workflow.forkedFrom??detail?.workflow.parentId;if(id)app.selectWorkflow(id);},
  };
}
