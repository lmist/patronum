import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ErrorNotice } from "../../components/feedback";
import { useDiagnostics } from "./use-diagnostics";
export function Diagnostics() {
  const d=useDiagnostics();
  return <div className="stack">
    <header className="page-header"><h1>Diagnostics</h1><p className="muted">What the dashboard is running on and what it has logged. Nothing in the first two sections changes your data.</p></header>
    <section className="surface stack"><div className="section-heading"><div><h2>System</h2><p id="strip-clock" className="muted">Status last refreshed: {d.app.updated}</p></div></div><details className="disclosure"><summary>Host & queues</summary><pre id="strip-queues" className="log">{d.system}</pre></details></section>
    <section className="surface stack"><div className="section-heading"><div><h2>Dashboard log</h2><p className="muted">The dashboard server’s own recent log lines, for when a button does nothing.</p></div><Button id="diagnostics-btn" variant="secondary" onClick={d.showLog?d.refreshLog:d.openLog}>{d.showLog?"Refresh dashboard log":"View dashboard log"}</Button></div><ErrorNotice error={d.debug.error}/>{d.showLog&&<pre className="log">{d.debugText}</pre>}</section>
    <div className="section-divider"><h2>Maintenance</h2><p className="muted">This section deletes data.</p></div>
    <section className="surface stack maintenance"><div><h2>Clean up old job history</h2><p className="muted">Removes old jobs and their step records from the Jobs list. Downloaded media and login sessions are kept. Preview first: nothing is deleted until you confirm the list.</p></div><div className="form-grid"><label className="field">Delete jobs older than<Input id="gc-age" value={d.age} onChange={d.ageChange} placeholder="720h" disabled={d.busy}/><span className="collection-help">In hours: 720h is 30 days.</span></label><label className="check"><input id="gc-keep-errors" type="checkbox" checked={d.keepErrors} onChange={d.keepChange} disabled={d.busy}/>Keep failed jobs</label></div><div className="actions"><Button id="gc-preview" variant="secondary" disabled={d.busy} onClick={d.preview}>Preview cleanup</Button><Button id="gc-run" variant="destructive" hidden={!d.canDelete} disabled={d.busy} onClick={d.remove}>Delete listed history</Button></div><ErrorNotice error={d.mutation.error}/><ErrorNotice error={d.action.error}/><pre className="log" id="maintenance-output">{d.output}</pre></section>
  </div>;
}
