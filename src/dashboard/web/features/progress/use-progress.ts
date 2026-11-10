import { useState, type ChangeEvent } from "react";
import { useRead } from "../../api/queries";
import { useDashboard } from "../../state/app";
import { STAGES, STAGE_LABELS, duration, isRunning, type Log, type StageName } from "../../api/types";
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
  const stages=STAGES.map(name=>{const s=detail?.stages[name];const skipped=detail?.workflow.skipped?.includes(name);return {name,label:STAGE_LABELS[name],state:skipped?"skipped":s?.state??"idle",status:skipped?"Skipped":s?.state==="done"?"Complete":s?.state==="running"?"Running":s?.state==="error"?"Failed":"Waiting",props:{onClick:()=>{setLogStage(name);setFocus(s?.stepId??null);setFrozen(null);}}};});
  const setStage=(name:StageName)=>()=>{setLogStage(name);setFrozen(null);};
  const fsm=buildFsm(detail);
  const inspected=chosenStage??STAGES.find(s=>detail?.stages[s]?.state==="error")??(STAGES.includes(detail?.currentStage as StageName)?detail?.currentStage as StageName:[...STAGES].reverse().find(s=>detail?.stages[s]?.state==="done")??"preflight");
  const inspectedState=detail?.stages[inspected];
  const fsmNodes=fsm.nodes.map(node=>({...node,props:{
    onClick:()=>{if(node.stage){setChosenStage(node.stage);setLogStage(node.stage);setFocus(detail?.stages[node.stage]?.stepId??null);setFrozen(null);}},
    "aria-pressed":node.stage===inspected,
    "aria-label":node.name+": "+node.status,
  }}));
  return {app,detail,rows,selected,stages,log,logStage,selectLog,follow,toggleFollow,setStage,
    fsm,fsmNodes,inspected,inspectedLabel:STAGE_LABELS[inspected],
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
