import { useRef, useState, type FormEvent, type ChangeEvent, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCommand } from "../../api/queries";
import { act } from "../../api/client";
import { useDashboard } from "../../state/app";
import { updateSelection } from "../../state/selection";
import { dateLabel, duration, isSession, statusLabel, type Receipt } from "../../api/types";

import { collectionDefaults, collectionRequest, handleError, normalizeHandle, type CollectionDraft, type CollectionErrors } from "./collection-form";

export function useComposer() {
  const app=useDashboard(), command=useCommand(), client=useQueryClient(), lock=useRef(false);
  const [draft,setDraft]=useState<CollectionDraft>({...collectionDefaults});
  const [errors,setErrors]=useState<CollectionErrors>({});
  const form=useRef<HTMLFormElement>(null);
  const mapCommand=useMutation({
    mutationFn:(body:Record<string,unknown>)=>act<Receipt>("/api/map-network",body),
    onSuccess:receipt=>{
      updateSelection({actionPid:receipt.pid,section:"account"});
      client.invalidateQueries({queryKey:["/api/actions"]});
    },
  });
  const sessions=(app.history.data?.launches??[]).filter(isSession);
  const sessionMissing=Boolean(app.selection.sessionPid&&!sessions.some(l=>String(l.pid)===app.selection.sessionPid));
  const sessionChange=(e:ChangeEvent<HTMLSelectElement>)=>{
    updateSelection({sessionPid:e.currentTarget.value});
    setErrors(previous=>({...previous,session:undefined}));
  };
  const busy=command.isPending||mapCommand.isPending;
  const revealError=(next:CollectionErrors)=>{
    setErrors(next);
    const key=Object.keys(next)[0];
    const field=form.current?.querySelector<HTMLElement>(`[name="${key}"]`);
    let parent=field?.parentElement;
    while(parent){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}
    field?.focus();
  };
  const validateSession=(next:CollectionErrors)=>{
    if(sessionMissing)next.session="Select an available login session.";
    return next;
  };
  const submit=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    if(lock.current)return;
    const result=collectionRequest(draft);
    validateSession(result.errors);
    if(Object.keys(result.errors).length){revealError(result.errors);return;}
    setErrors({});
    const body={...result.body};
    if(app.selection.sessionPid)body.sourcePid=Number(app.selection.sessionPid);
    lock.current=true;
    try {await command.mutateAsync({path:"/api/run",body});} catch { /* Error is rendered beside the launch control. */ }
    finally {lock.current=false;}
  };
  const mapNetwork=async()=>{
    if(lock.current)return;
    const next:CollectionErrors={};
    const error=handleError(draft.handle);
    if(error)next.handle=error;
    validateSession(next);
    if(Object.keys(next).length){revealError(next);return;}
    setErrors({});
    const body:Record<string,unknown>={handle:normalizeHandle(draft.handle),"show-browser":draft.showBrowser,surface:draft.mapSurface};
    if(app.selection.sessionPid)body.sourcePid=Number(app.selection.sessionPid);
    lock.current=true;
    try {await mapCommand.mutateAsync(body);}catch { /* Error is rendered beside the mapping control. */ }
    finally {lock.current=false;}
  };
  const input=(name: keyof CollectionDraft)=>({
    name,id:`collection-${name}`,value:String(draft[name]),disabled:busy,
    "aria-invalid":errors[name]?true:undefined,
    "aria-describedby":errors[name]?`collection-${name}-error`:undefined,
    onChange:(e:ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>{
      const value=e.currentTarget.value;
      setDraft(previous=>({...previous,[name]:value}));
      setErrors(previous=>({...previous,[name]:undefined}));
    },
  });
  const check=(name:"showBrowser"|"forceLogin"|"skipLlmCheck"|"allFrames")=>({
    name,checked:draft[name],disabled:busy,
    onChange:(e:ChangeEvent<HTMLInputElement>)=>{const checked=e.currentTarget.checked;setDraft(previous=>({...previous,[name]:checked}));},
  });
  const analyzing=draft.goal==="analyze";
  return {form,submit,mapNetwork,errors,command,mapCommand,busy,analyzing,
    fields:{handle:input("handle"),max:input("max"),media:input("media"),goal:input("goal"),source:input("source"),mapSurface:input("mapSurface"),
      browserWorkers:input("browserWorkers"),downloadWorkers:input("downloadWorkers"),analysisWorkers:input("analysisWorkers"),timeoutMinutes:input("timeoutMinutes")},
    checks:{showBrowser:check("showBrowser"),forceLogin:check("forceLogin"),skipLlmCheck:check("skipLlmCheck"),allFrames:check("allFrames")},
    sessionProps:{name:"session",value:app.selection.sessionPid,onChange:sessionChange,disabled:busy,"aria-invalid":errors.session?true:undefined,"aria-describedby":errors.session?"collection-session-error":undefined},
    sessionMissing,sessionOptions:sessions.map(l=>({value:String(l.pid),label:"Checked session · "+dateLabel(l.startedAt)})),
    sourceHelp:draft.source==="saved"?"Retry unfinished posts from the last saved list for this handle. No new posts are discovered.":"Find posts on the profile and keep any completed work already saved.",
    goalHelp:analyzing?"Download and deduplicate media, then describe each image and video with the video model. Requires a model that passes the readiness check.":"Download and deduplicate media. AI analysis and its readiness check are skipped.",
    summary:`${draft.browserWorkers || "—"} browser tabs · ${draft.downloadWorkers || "—"} parallel downloads`,
    launchLabel:busy?"Starting…":"Start collection",
    message:mapCommand.isPending?"Starting API mapping…":command.isPending?"Starting collection…":command.isSuccess?"Collection accepted. Follow its workflow below.":"",
  };
}
export function useCollections() {
  const app=useDashboard();
  const [filter,setFilter]=useState(""),[limit,setLimit]=useState(12);
  const workflows=(app.workflows.data??[]).filter(workflow=>!workflow.parentId);
  const filtered=workflows.filter(w=>(w.handle+" "+w.id+" "+statusLabel(w.status)).toLowerCase().includes(filter.toLowerCase()));
  const choose=(id:string)=>{app.selectWorkflow(id);};
  const rows=filtered.slice(0,limit).map(w=>({
    ...w,when:dateLabel(w.createdAt),elapsed:duration(w.startedAt,w.completedAt),label:statusLabel(w.status),
    props:{role:"button",tabIndex:0,"aria-pressed":w.id===app.workflowId,"aria-label":(w.handle||"Unknown profile")+" · "+statusLabel(w.status),
      onClick:()=>choose(w.id),onKeyDown:(e:KeyboardEvent<HTMLLIElement>)=>{
        if(e.key==="Enter"||e.key===" "){e.preventDefault();choose(w.id);}
        if(["ArrowDown","j","ArrowUp","k"].includes(e.key)){e.preventDefault();const direction=["ArrowDown","j"].includes(e.key)?1:-1;const siblings=Array.from(e.currentTarget.parentElement?.children??[]) as HTMLElement[];siblings[(siblings.indexOf(e.currentTarget)+direction+siblings.length)%siblings.length]?.focus();}
      }},
  }));
  return {rows,total:workflows.length,count:filtered.length,more:filtered.length>limit,
    filterProps:{value:filter,onChange:(e:ChangeEvent<HTMLInputElement>)=>{setFilter(e.currentTarget.value);setLimit(12);},
      onInput:(e:FormEvent<HTMLInputElement>)=>{setFilter(e.currentTarget.value);setLimit(12);}},
    showMore:()=>setLimit(n=>n+12),error:app.workflows.error,loading:app.workflows.isPending,
    emptyTitle:filter?"No matching collections":"Your library starts here",
    emptyText:filter?"Try another handle or status.":"Enter an Instagram handle above to collect your first profile.",
  };
}
