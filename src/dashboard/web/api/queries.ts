import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { read, act } from "./client";
import { isActiveAction, isRunning, type Detail, type Launch, type Receipt, type Snapshot, type Workflow, type Log } from "./types";
import { useSelection, updateSelection } from "../state/selection";

export function useRead<T>(path: string, enabled = true, interval: number | false = false) {
  return useQuery<T, Error>({
    queryKey: [path], queryFn: ({signal}) => read<T>(path,signal), enabled,
    refetchInterval: interval, refetchIntervalInBackground: false,
    retry: (count,error) => !("status" in error && Number(error.status) < 500) && count < 1,
  });
}
export function useWorkspace() {
  const selection = useSelection();
  const now = useRead<Snapshot>("/api/now", true, 3000);
  const workflows = useRead<Workflow[]>("/api/workflows?limit=500", true, 3000);
  const history = useRead<{launches:Launch[]}>("/api/actions", true, 4000);
  const receipt = useQuery<Launch>({
    queryKey: ["/api/launch/" + selection.receiptPid],
    queryFn: ({signal}) => read<Launch>("/api/launch/" + selection.receiptPid,signal),
    enabled: Boolean(selection.receiptPid),
    refetchInterval: query => isActiveAction(query.state.data) || !query.state.data ? 1200 : false,
  });
  const workflowId = selection.receiptFor === selection.workflowId && receipt.data?.workflowId ? receipt.data.workflowId : selection.workflowId;
  const detail = useQuery<Detail,Error>({
    queryKey: ["/api/workflow/" + encodeURIComponent(workflowId)],
    queryFn: ({signal}) => read<Detail>("/api/workflow/" + encodeURIComponent(workflowId),signal),
    enabled: Boolean(workflowId),
    refetchInterval: query => !query.state.data || isRunning(query.state.data.workflow.status) ? 1800 : false,
    retry: (count,error) => (!("status" in error) || Number(error.status) !== 404) && count < 1,
  });
  return {selection,now,workflows,history,receipt,workflowId,detail};
}
export function useAction(pid: number | null, visible = true) {
  const action = useQuery<Launch, Error>({
    queryKey: ["/api/launch/" + pid], queryFn: ({signal}) => read<Launch>("/api/launch/" + pid,signal),
    enabled: Boolean(pid) && visible,
    refetchInterval: q => !q.state.data || isActiveAction(q.state.data) ? 1500 : false,
  });
  const log = useRead<Log>("/api/launch/" + pid + "/log?n=400&finished=" + (action.data?.exitCode ?? "pending"), Boolean(pid) && visible, isActiveAction(action.data) ? 1800 : false);
  return {action,log};
}
export function useCommand() {
  const client = useQueryClient();
  const command = useMutation({
    mutationFn: ({path,body}: {path:string;body:unknown}) => act<Receipt>(path,body),
    onSuccess: receipt => {
      if (receipt.workflowId) updateSelection({workflowId:receipt.workflowId,receiptPid:receipt.pid,receiptFor:receipt.workflowId,section:"collections",view:"progress"});
      client.invalidateQueries({queryKey:["/api/now"]});
      client.invalidateQueries({queryKey:["/api/actions"]});
      client.invalidateQueries({queryKey:["/api/workflows?limit=500"]});
    },
  });
  return command;
}
