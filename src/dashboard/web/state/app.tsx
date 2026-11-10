import { createContext, useContext, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layers3, UserRound, SlidersHorizontal } from "lucide-react";
import { useCommand, useWorkspace } from "../api/queries";
import { updateSelection, selectWorkflow, type Section } from "./selection";
import { actionName, dateLabel, duration, isActiveAction, isRunning, STAGES } from "../api/types";
import { useJobSidebar } from "./sidebar";
import { collectionRecovery } from "./recovery";
export function useApp() {
  const workspace=useWorkspace();
  const client=useQueryClient();
  const command=useCommand();
  const sidebar=useJobSidebar();
  const {selection,detail,workflowId}=workspace;
  const workflow=detail.data?.workflow;
  const navigate=(section:Section)=>{updateSelection({section});document.getElementById("workspace")?.focus({preventScroll:true});};
  const refresh=()=>{client.invalidateQueries();};
  const nav=[{id:"collections" as const,label:"Jobs",icon:Layers3},{id:"account" as const,label:"Account",icon:UserRound},{id:"diagnostics" as const,label:"Diagnostics",icon:SlidersHorizontal}].map(item=>({...item,props:{id:"nav-"+item.id,"aria-current":selection.section===item.id?"page" as const:undefined,onClick:()=>navigate(item.id)}}));
  const home=()=>navigate("collections");
  const newCollection=()=>{navigate("collections");requestAnimationFrame(()=>{const disclosure=document.getElementById("new-collection-disclosure") as HTMLDetailsElement|null;if(disclosure)disclosure.open=true;document.getElementById("run-handle")?.focus();});};
  const resume=()=>command.mutate({path:"/api/resume",body:{workflowId}});
  const cancel=()=>command.mutate({path:"/api/cancel",body:{workflowId}});
  const account=()=>navigate("account");
  const viewProps=(view:"results"|"progress")=>({"aria-pressed":selection.view===view,onClick:()=>updateSelection({view,section:"collections"})});
  const keyDown=(e:KeyboardEvent)=>{
    if ((e.target as HTMLElement).closest("input,select,textarea,button,summary,a,[role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
    if(e.key==="/"){e.preventDefault();document.getElementById("filter")?.focus();}
    if(e.key==="r"){e.preventDefault();refresh();}
    if(e.key==="Escape"){selectWorkflow("");}
  };
  const activities=(workspace.history.data?.launches??[]).slice(0,4).map(action=>({pid:action.pid,name:actionName(action.kind),when:dateLabel(action.startedAt),status:isActiveAction(action)?"In progress":action.exitCode===0?"Finished":action.status==="lost"?"Interrupted":"Needs attention",props:{onClick:()=>{updateSelection({actionPid:action.pid,section:"account"});}}}));
  const chooseWorkflow=(id:string)=>{
    selectWorkflow(id);
    sidebar.close();
    requestAnimationFrame(()=>{
      const composer=document.getElementById("new-collection-disclosure") as HTMLDetailsElement|null;
      if(composer&&id)composer.open=false;
      document.getElementById("workspace")?.focus({preventScroll:true});
      window.scrollTo({top:0,left:0,behavior:"instant"});
    });
  };
  return {...workspace,nav,refresh,home,newCollection,resume,cancel,account,viewProps,keyDown,activities,command,sidebar,
    recovery:collectionRecovery(detail.data?.errorText),
    title:selection.section==="account"?"Account":selection.section==="diagnostics"?"Diagnostics":"Jobs",
    workflow,canResume:Boolean(workflow&&["ERROR","CANCELLED","MAX_RECOVERY_ATTEMPTS_EXCEEDED"].includes(workflow.status)),
    canCancel:isRunning(workflow?.status),created:dateLabel(workflow?.createdAt),elapsed:duration(workflow?.startedAt,workflow?.completedAt),
    completeStages:STAGES.filter(s=>detail.data?.stages[s]?.state==="done").length,
    connected:workspace.now.isSuccess&&!workspace.now.isError,
    updated:workspace.now.data?dateLabel(workspace.now.data.ts):"Connecting…",
    launchStatus:selection.receiptPid?(workspace.receipt.data?(isActiveAction(workspace.receipt.data)?"Collection command in progress":"Collection command "+workspace.receipt.data.status)+". Workflow status is shown above.":"Collection command accepted. Waiting for workflow status…"):"",
    selectWorkflow:chooseWorkflow,
  };
}
export type AppModel=ReturnType<typeof useApp>;
export const AppContext=createContext<AppModel|null>(null);
export function useDashboard(){const value=useContext(AppContext);if(!value)throw new Error("Dashboard context missing");return value;}
