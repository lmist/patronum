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
    {id:"auth-warm",group:"check",label:"Check saved login",description:"Confirms the saved Instagram login still works. Start here: if it passes, you are ready to collect.",kind:"warm-session"},
    {id:"auth-cold",group:"check",label:"Sign in fresh",description:"Signs in again in a separate Chrome profile. Use it when the saved login has expired; the saved login is left untouched.",kind:"cold-login"},
    {id:"auth-preflight",group:"check",label:"Check readiness",description:"Confirms the vision model answers. Run it before a collection that analyzes media, or when a job fails at Preflight.",kind:"preflight"},
    {id:"auth-recover",group:"repair",label:"Complete verification",description:"Instagram stopped a sign-in to ask for a code or a challenge. This reopens Chrome so you can finish it.",kind:"recover-login"},
    {id:"auth-close-orphan",group:"repair",label:"Close inactive collection browser",description:"A collection was interrupted and left its Chrome window open. This closes it. Saved logins are kept.",kind:"close-collection-browser"},
  ].map(control=>({...control,props:{onClick:()=>run(control.kind),disabled:mutation.isPending||(control.kind!=="preflight"&&isActiveAction(current)&&["warm-session","cold-login","recover-login"].includes(current?.kind??""))}}));
  const stop=()=>mutation.mutate({path:"/api/action/stop",body:{pid:app.selection.actionPid}});
  const checkCurrent=()=>run("warm-session",true);
  const chooseSession=()=>{if(current&&isSession(current))updateSelection({sessionPid:String(current.pid)});};
  const history=(app.history.data?.launches??[]).map(l=>({value:String(l.pid),label:actionName(l.kind)+" · "+l.status+" · "+dateLabel(l.startedAt)}));
  const changeHistory=(e:ChangeEvent<HTMLSelectElement>)=>updateSelection({actionPid:Number(e.target.value)||null});
  const active=isActiveAction(current);
  const successful=current?.exitCode===0&&current?.result?.ok===true;
  const status=current? actionName(current.kind)+": "+(active?"in progress":successful?"complete":current.status==="lost"?"interrupted; start again when ready":"needs attention"):"Nothing checked yet. Run a check above and its result appears here.";
  const error=current?.result?.error?typeof current.result.error==="string"?current.result.error:JSON.stringify(current.result.error):"";
  return {controls,checks:controls.filter(c=>c.group==="check"),repairs:controls.filter(c=>c.group==="repair"),current,action,log,mutation,history,changeHistory,stop,checkCurrent,chooseSession,status,error,
    selectedHistory:String(app.selection.actionPid??""),canStop:active&&["warm-session","cold-login","recover-login","map-network"].includes(current?.kind??""),
    stopLabel:current?.kind==="map-network"?"Stop API mapping":"Close login browser",
    canUseSession:current?isSession(current):false,usingSession:String(current?.pid)===app.selection.sessionPid,
    fullLog:app.selection.actionPid?"/api/launch/"+app.selection.actionPid+"/log?download=1":undefined,
    logText:log.data?.lines.join("\n")||current?.tail?.join("\n")||(app.selection.actionPid?"Waiting for activity…":"No action selected."),
    readyText:mutation.data?.message??(successful?(current?.kind==="preflight"?"AI connection verified.":current?.kind==="warm-session"?"Saved login verified.":current?.kind==="cold-login"?"Fresh login completed. Check this session to verify cookie reuse.":"Action completed."):""),
  };
}
