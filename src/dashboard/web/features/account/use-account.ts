import { useRef, type ChangeEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAction } from "../../api/queries";
import { act } from "../../api/client";
import { useDashboard } from "../../state/app";
import { updateSelection } from "../../state/selection";
import { actionName, dateLabel, isActiveAction, isSession, type Receipt } from "../../api/types";
export function useAccount() {
  const app=useDashboard(),client=useQueryClient(),lock=useRef(false);
  const {action,log}=useAction(app.selection.actionPid);
  const current=action.data;
  const mutation=useMutation({mutationFn:({path,body}:{path:string;body:unknown})=>act<Receipt & {message?:string}>(path,body),
    onSuccess:r=>{if(r.pid)updateSelection({actionPid:r.pid});client.invalidateQueries({queryKey:["/api/actions"]});client.invalidateQueries({queryKey:["/api/launch/"+app.selection.actionPid]});}});
  const run=async(kind:string,source=false)=>{
    if(lock.current)return;lock.current=true;
    const body:Record<string,unknown>={action:kind};
    if(source||(kind==="recover-login"&&current?.isolated))body.sourcePid=app.selection.actionPid;
    try {await mutation.mutateAsync({path:"/api/action",body});}catch {}finally{lock.current=false;}
  };
  const controls=[
    {id:"auth-warm",label:"Check saved login",description:"Reuse the account’s saved cookies.",kind:"warm-session"},
    {id:"auth-cold",label:"Sign in fresh",description:"Create a separate login profile.",kind:"cold-login"},
    {id:"auth-preflight",label:"Check readiness",description:"Verify the AI connection.",kind:"preflight"},
    {id:"auth-recover",label:"Complete verification",description:"Continue a checkpoint in Chrome.",kind:"recover-login"},
    {id:"auth-close-orphan",label:"Close inactive collection browser",description:"Release Chrome after an interrupted collection. Keep saved login files.",kind:"close-collection-browser"},
  ].map(control=>({...control,props:{onClick:()=>run(control.kind),disabled:mutation.isPending||(control.kind!=="preflight"&&isActiveAction(current)&&["warm-session","cold-login","recover-login"].includes(current?.kind??""))}}));
  const stop=()=>mutation.mutate({path:"/api/action/stop",body:{pid:app.selection.actionPid}});
  const checkCurrent=()=>run("warm-session",true);
  const chooseSession=()=>{if(current&&isSession(current))updateSelection({sessionPid:String(current.pid)});};
  const history=(app.history.data?.launches??[]).map(l=>({value:String(l.pid),label:actionName(l.kind)+" · "+l.status+" · "+dateLabel(l.startedAt)}));
  const changeHistory=(e:ChangeEvent<HTMLSelectElement>)=>updateSelection({actionPid:Number(e.target.value)||null});
  const active=isActiveAction(current);
  const successful=current?.exitCode===0&&current?.result?.ok===true;
  const status=current? actionName(current.kind)+": "+(active?"in progress":successful?"complete":current.status==="lost"?"interrupted; start again when ready":"needs attention"):"Choose a check to see your account readiness.";
  const error=current?.result?.error?typeof current.result.error==="string"?current.result.error:JSON.stringify(current.result.error):"";
  return {controls,current,action,log,mutation,history,changeHistory,stop,checkCurrent,chooseSession,status,error,
    selectedHistory:String(app.selection.actionPid??""),canStop:active&&["warm-session","cold-login","recover-login","map-network"].includes(current?.kind??""),
    stopLabel:current?.kind==="map-network"?"Stop API mapping":"Close login browser",
    canUseSession:current?isSession(current):false,usingSession:String(current?.pid)===app.selection.sessionPid,
    fullLog:app.selection.actionPid?"/api/launch/"+app.selection.actionPid+"/log?download=1":undefined,
    logText:log.data?.lines.join("\n")||current?.tail?.join("\n")||(app.selection.actionPid?"Waiting for activity…":"No action selected."),
    readyText:mutation.data?.message??(successful?(current?.kind==="preflight"?"AI connection verified.":current?.kind==="warm-session"?"Saved login verified.":current?.kind==="cold-login"?"Fresh login completed. Check this session to verify cookie reuse.":"Action completed."):""),
  };
}
