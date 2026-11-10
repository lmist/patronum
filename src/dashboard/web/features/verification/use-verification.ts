import { useState,type ChangeEvent,type SyntheticEvent } from "react";
import { useMutation,useQueryClient } from "@tanstack/react-query";
import { useRead,useAction } from "../../api/queries";
import { act } from "../../api/client";
import { useDashboard } from "../../state/app";
import { updateSelection } from "../../state/selection";
import { isActiveAction,type Capture,type CaptchaStatus,type Receipt } from "../../api/types";
export function useVerification() {
  const app=useDashboard(),client=useQueryClient();
  const [open,setOpen]=useState(false),[captureId,setCaptureId]=useState(""),[backend,setBackend]=useState("vision");
  const [recognized,setRecognized]=useState<{pid:number;capture:string}|null>(null);
  const captures=useRead<{captures:Capture[]}>("/api/captcha/captures",open);
  const readiness=useRead<CaptchaStatus>("/api/captcha/status",open);
  const {action}=useAction(recognized?.pid??null,open);
  const capture=captures.data?.captures.find(c=>c.id===captureId);
  const mutation=useMutation({mutationFn:()=>act<Receipt>("/api/action",{action:"recognize-captcha",captureId,backend,confirmed:true}),onSuccess:r=>{
    setRecognized({pid:r.pid,capture:captureId});updateSelection({actionPid:r.pid});client.invalidateQueries({queryKey:["/api/actions"]});
  }});
  const busy=mutation.isPending||isActiveAction(action.data);
  const result=action.data?.result?.recognition??action.data?.result?.result??action.data?.result;
  const sameCapture=recognized?.capture===captureId;
  const proposal=sameCapture&&busy?"Inspecting saved grid…":sameCapture&&action.data?(result?.status==="proposed"?"Proposed tiles: "+(result.selectedIndices?.map(i=>i+1).join(", ")||"none")+". Count left to right, top to bottom, starting at 1. Nothing was clicked or submitted. The live grid may have changed.":"No reliable selection: "+(result?.reason??action.data.status)+". Complete verification in Chrome."):"Choose a captured grid to inspect its proposed matches.";
  return {open,captures,readiness,capture,backend,mutation,action,busy,captureId,proposal,
    onToggle:(e:SyntheticEvent<HTMLDetailsElement>)=>setOpen(e.currentTarget.open),
    changeCapture:(e:ChangeEvent<HTMLSelectElement>)=>setCaptureId(e.target.value),changeBackend:(e:ChangeEvent<HTMLSelectElement>)=>setBackend(e.target.value),
    recognize:()=>{if(!busy&&capture?.capturePath)mutation.mutate();},
    refresh:()=>{captures.refetch();readiness.refetch();},
    disabled:busy||!capture?.capturePath,
    options:(captures.data?.captures??[]).map(c=>({value:c.id,label:(c.fixtureLabel??c.timestamp??c.id)+" · "+(c.gridSize??"?")+"×"+(c.gridSize??"?")})),
    status:readiness.data?"Local recognition: "+(readiness.data.local?.available?"Model installed · 3×3 grids":"Not installed")+". Vision recognition: "+(readiness.data.vision?.configured?"Configured · "+(readiness.data.vision.model??"vision")+" · 3×3 / 4×4":"Not configured")+". Availability does not confirm recognition accuracy.":"Open to check recognition availability.",
    diagnostic:sameCapture?action.data?.result?.diagnosticUrl:undefined,
    recover:app.account,
  };
}
