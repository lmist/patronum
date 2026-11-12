import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ErrorNotice } from "../../components/feedback";
import { useCoverageExport } from "./use-coverage-export";

const TONES:Record<string,string>={complete:"success",partial:"warning",pending:"warning",failed:"error"};

/** Secondary to the posts themselves, so both parts stay folded until asked for. */
export function CoverageExport({handle}:{handle:string}) {
  const c=useCoverageExport(handle);
  return <section className="results-extras" aria-label="Coverage and export">
    <details className="surface fold">
      <summary><span className="fold-title"><strong>Post coverage</strong><span>Which posts are still missing media or analysis.</span></span><span className="fold-note">{c.count} posts tracked</span></summary>
      <div className="stack">
        <div className="section-heading"><p role="status" className="muted">{c.count} posts recorded for @{handle}, including ones found by earlier jobs.</p><Button id="coverage-refresh" variant="secondary" onClick={c.update} disabled={c.refresh.isPending}>{c.refresh.isPending?"Checking coverage…":"Update coverage"}</Button></div>
        <ErrorNotice error={c.coverage.error}/><ErrorNotice error={c.refresh.error}/>
        {!!c.summary.length&&<dl className="stat-grid coverage-summary">{c.summary.map(item=><div key={item.key} data-tone={item.value>0?TONES[item.key]:undefined}><dt>{item.key}</dt><dd>{item.value}</dd></div>)}</dl>}
        <details className="disclosure"><summary>Post-by-post status</summary>
          <label className="field" htmlFor="coverage-filter">Find a post or status<Input id="coverage-filter" {...c.filterProps}/></label>
          <div className="coverage-table"><table><thead><tr><th>Post</th><th>Analysis</th><th>Reason</th></tr></thead><tbody>{c.rows.map(row=><tr key={row.id}><td>{row.id}{!row.current&&" (earlier collection)"}</td><td>{row.status}</td><td>{row.reasons}</td></tr>)}</tbody></table></div>
          {c.more&&<Button variant="secondary" onClick={c.showMore}>Show more coverage rows</Button>}
        </details>
      </div>
    </details>
    <details className="surface fold">
      <summary><span className="fold-title"><strong>Export</strong><span>Copy this profile into an OpenKnowledge folder as a “trinket box”.</span></span>{c.state&&<span className="fold-note" data-tone={c.state.status==="failed"?"error":undefined}>{c.state.status==="complete"?"Last export complete":c.state.status==="failed"?"Last export failed":"Export running"}</span>}</summary>
      <div className="stack">
        <p className="muted">A trinket box is a standalone copy of the media, captions, analysis and linked design topics. The collected files stay where they are.</p>
        <label className="field" htmlFor="trinket-target">OpenKnowledge folder<Input id="trinket-target" placeholder="Absolute path to your initialized wiki" {...c.targetProps}/></label>
        <div className="actions"><Button id="trinket-export" onClick={c.exportNow} disabled={c.busy}>{c.busy?"Building trinket box…":"Export trinket box"}</Button></div>
        <ErrorNotice error={c.publish.error}/><ErrorNotice error={c.exported.error}/>
        <div role="status">{c.state?.status==="complete"&&<p>Export complete: {c.state.result?.postCount} posts, {c.state.result?.assetCount} media files. <span className="export-path">{c.state.targetDir}/{c.state.result?.indexPath}</span></p>}{c.state?.status==="failed"&&<p className="status-error">Export failed: {c.state.error}</p>}</div>
      </div>
    </details>
  </section>;
}
