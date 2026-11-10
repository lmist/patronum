import { useRef,useState,type ChangeEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAction,useRead } from "../../api/queries";
import { act } from "../../api/client";
import { isActiveAction,type Receipt } from "../../api/types";
import { useDashboard } from "../../state/app";
export function useDiagnostics() {
  const app=useDashboard(),lock=useRef(false);
  const [age,setAge]=useState("720h"),[keepErrors,setKeepErrors]=useState(true);
  const [request,setRequest]=useState<{pid:number;dry:boolean;key:string}|null>(null);
  const [showLog,setShowLog]=useState(false);
  const {action,log}=useAction(request?.pid??null);
  const key=age+":"+keepErrors;
  const canDelete=Boolean(request?.dry&&request.key===key&&action.data?.exitCode===0);
  const mutation=useMutation({mutationFn:async(dry:boolean)=>{
    const result=await act<Receipt>("/api/gc",{"older-than":age,"keep-errors":keepErrors,"dry-run":dry});
    setRequest({pid:result.pid,dry,key});return result;
  }});
  const busy=mutation.isPending||isActiveAction(action.data);
  const perform=async(dry:boolean)=>{if(lock.current||busy||(!dry&&!canDelete))return;lock.current=true;try{await mutation.mutateAsync(dry);}catch{}finally{lock.current=false;}};
  const debug=useRead<{lines:unknown[]}>("/api/debug/log?n=200",showLog,false);
  return {app,age,keepErrors,canDelete,busy,mutation,action,log,debug,showLog,
    ageChange:(e:ChangeEvent<HTMLInputElement>)=>{setAge(e.target.value);setRequest(r=>r?{...r,dry:false}:r);},
    keepChange:(e:ChangeEvent<HTMLInputElement>)=>{setKeepErrors(e.target.checked);setRequest(r=>r?{...r,dry:false}:r);},
    preview:()=>perform(true),remove:()=>perform(false),openLog:()=>setShowLog(true),refreshLog:()=>debug.refetch(),
    output:log.data?.lines.join("\n")||action.data?.tail.join("\n")||(busy?"Cleanup preview in progress…":"Preview cleanup before removing old job history."),
    debugText:JSON.stringify(debug.data?.lines??[],null,2),
    system:JSON.stringify({host:app.now.data?.executor,queues:app.now.data?.queues},null,2),
  };
}
