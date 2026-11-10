import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ErrorNotice } from "../../components/feedback";
import { useCoverageExport } from "./use-coverage-export";

const TONES:Record<string,string>={complete:"success",partial:"warning",pending:"warning",failed:"error"};

export function CoverageExport({handle}:{handle:string}) {
  const c=useCoverageExport(handle);
  return <section className="stack" aria-label="Coverage and export">
    <div className="surface stack">
    <div className="section-heading"><div><h2>Post coverage</h2><p className="muted">Every discovered post, including missing media and incomplete analysis.</p></div><Button id="coverage-refresh" variant="secondary" onClick={c.update} disabled={c.refresh.isPending}>{c.refresh.isPending?"Checking coverage…":"Update coverage"}</Button></div>
    <ErrorNotice error={c.coverage.error}/><ErrorNotice error={c.refresh.error}/>
    <p role="status">{c.count} posts recorded in the database.</p>
    {!!c.summary.length&&<dl className="stat-grid coverage-summary">{c.summary.map(item=><div key={item.key} data-tone={item.value>0?TONES[item.key]:undefined}><dt>{item.key}</dt><dd>{item.value}</dd></div>)}</dl>}
    <details className="disclosure"><summary>Inspect post-by-post status</summary>
      <label className="field" htmlFor="coverage-filter">Find a post or status<Input id="coverage-filter" {...c.filterProps}/></label>
      <div className="coverage-table"><table><thead><tr><th>Post</th><th>Analysis</th><th>Reason</th></tr></thead><tbody>{c.rows.map(row=><tr key={row.id}><td>{row.id}{!row.current&&" (earlier collection)"}</td><td>{row.status}</td><td>{row.reasons}</td></tr>)}</tbody></table></div>
      {c.more&&<Button variant="secondary" onClick={c.showMore}>Show more coverage rows</Button>}
    </details>
    </div>
    <div className="surface stack">
    <div><h2>Trinket box</h2><p className="muted">Copy the media, captions, analysis, and linked design topics into a standalone OpenKnowledge folder.</p></div>
    <label className="field" htmlFor="trinket-target">OpenKnowledge folder<Input id="trinket-target" placeholder="Absolute path to your initialized wiki" {...c.targetProps}/></label>
    <div className="actions"><Button id="trinket-export" onClick={c.exportNow} disabled={c.busy}>{c.busy?"Building trinket box…":"Export trinket box"}</Button></div>
    <ErrorNotice error={c.publish.error}/><ErrorNotice error={c.exported.error}/>
    <div role="status">{c.state?.status==="complete"&&<p>Export complete: {c.state.result?.postCount} posts, {c.state.result?.assetCount} media files. <span className="export-path">{c.state.targetDir}/{c.state.result?.indexPath}</span></p>}{c.state?.status==="failed"&&<p className="status-error">Export failed: {c.state.error}</p>}</div>
    </div>
  </section>;
}
