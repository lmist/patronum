import { CheckCircle2, Circle, CircleAlert, Clock3, LoaderCircle, Ban } from "lucide-react";
import { statusLabel } from "../api/types";
import type { ReactNode } from "react";
function useStatus(status?: string) {
  const good = status === "SUCCESS" || status === "done";
  const bad = status === "ERROR" || status === "error" || status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED";
  const active = status === "PENDING" || status === "running";
  const queued = status === "ENQUEUED";
  return {label:statusLabel(status),Icon:good?CheckCircle2:bad?CircleAlert:active?LoaderCircle:queued?Clock3:status==="CANCELLED"?Ban:Circle,className:good?"status-success":bad?"status-error":active?"status-running":queued?"status-waiting":"muted"};
}
export function Status({status}: {status?:string}) {
  const s=useStatus(status);
  return <span className={"status-label "+s.className}><s.Icon size={15} aria-hidden="true"/>{s.label}</span>;
}
export function ErrorNotice({error,children}: {error?:Error|null;children?:ReactNode}) {
  return error ? <div role="alert" className="notice notice-error">{error.message}{children}</div> : null;
}
export function Loading({label="Loading…"}: {label?:string}) {
  return <div role="status" className="loading-state"><LoaderCircle size={18} aria-hidden="true"/>{label}</div>;
}
export function Empty({title,children}: {title:string;children:ReactNode}) {
  return <div className="empty"><h3>{title}</h3><div>{children}</div></div>;
}
