import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ErrorNotice } from "../../components/feedback";
import { useDiagnostics } from "./use-diagnostics";
export function Diagnostics() {
  const d=useDiagnostics();
  return <div className="stack"><div><h1>Diagnostics</h1><p className="muted">System details and collection history maintenance.</p></div>
    <section className="surface stack"><h2>System</h2><p id="strip-clock" className="muted">Last update: {d.app.updated}</p><details className="disclosure"><summary>Host & queues</summary><pre id="strip-queues" className="log">{d.system}</pre></details></section>
    <section className="surface stack"><h2>Clean up old history</h2><p className="muted">Remove old workflow history after reviewing the preview. Downloaded media and login sessions are kept.</p><div className="form-grid"><label className="field">Keep jobs newer than<Input id="gc-age" value={d.age} onChange={d.ageChange} placeholder="720h" disabled={d.busy}/></label><label className="check"><input id="gc-keep-errors" type="checkbox" checked={d.keepErrors} onChange={d.keepChange} disabled={d.busy}/>Keep failed jobs</label></div><div className="actions"><Button id="gc-preview" variant="secondary" disabled={d.busy} onClick={d.preview}>Preview cleanup</Button><Button id="gc-run" variant="destructive" hidden={!d.canDelete} disabled={d.busy} onClick={d.remove}>Delete listed history</Button></div><ErrorNotice error={d.mutation.error}/><ErrorNotice error={d.action.error}/><pre className="log" id="maintenance-output">{d.output}</pre></section>
    <section className="surface stack"><div className="section-heading"><h2>Dashboard log</h2><Button id="diagnostics-btn" variant="secondary" onClick={d.showLog?d.refreshLog:d.openLog}>{d.showLog?"Refresh dashboard log":"View dashboard log"}</Button></div><ErrorNotice error={d.debug.error}/>{d.showLog&&<pre className="log">{d.debugText}</pre>}</section>
  </div>;
}
