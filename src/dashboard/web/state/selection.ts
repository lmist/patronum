import { useSyncExternalStore } from "react";
export type Section = "collections" | "account" | "diagnostics";
export interface Selection {
  section: Section; workflowId: string; actionPid: number | null; sessionPid: string;
  view: "results" | "progress"; receiptPid: number | null; receiptFor: string;
}
const initial: Selection = {section:"collections",workflowId:"",actionPid:null,sessionPid:"",view:"results",receiptPid:null,receiptFor:""};
export function restoreSelection(storage: Pick<Storage,"getItem">): Selection {
  try {
    const stored = JSON.parse(storage.getItem("patronum.selection.v1") ?? "null");
    const value = stored ?? {workflowId:storage.getItem("igdash-workflow"),actionPid:Number(storage.getItem("igdash-action")) || null,view:storage.getItem("igdash-view")};
    return {
      ...initial,
      section: ["collections","account","diagnostics"].includes(value.section) ? value.section : "collections",
      workflowId: typeof value.workflowId === "string" ? value.workflowId : "",
      actionPid: Number.isSafeInteger(value.actionPid) && value.actionPid > 0 ? value.actionPid : null,
      sessionPid: typeof value.sessionPid === "string" ? value.sessionPid : "",
      view: value.view === "progress" ? "progress" : "results",
      receiptPid: Number.isSafeInteger(value.receiptPid) && value.receiptPid > 0 ? value.receiptPid : null,
      receiptFor: typeof value.receiptFor === "string" ? value.receiptFor : "",
    };
  } catch { return {...initial}; }
}
let snapshot = typeof localStorage === "undefined" ? initial : restoreSelection(localStorage);
const listeners = new Set<() => void>();
export function updateSelection(patch: Partial<Selection>) {
  snapshot = {...snapshot,...patch};
  try { localStorage.setItem("patronum.selection.v1",JSON.stringify(snapshot)); } catch { /* Selection remains usable when storage is unavailable. */ }
  listeners.forEach(fn => fn());
}
function subscribe(listener: () => void) { listeners.add(listener); return () => {listeners.delete(listener);}; }
export function useSelection() { return useSyncExternalStore(subscribe, () => snapshot, () => initial); }
export function selectWorkflow(workflowId: string) { updateSelection({workflowId,section:"collections",view:"progress",receiptPid:null,receiptFor:""}); }
