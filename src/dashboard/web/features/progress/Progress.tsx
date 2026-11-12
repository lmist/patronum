import type { CSSProperties } from "react";
import { Download, ChevronRight, GitBranch, ArrowRight, CircleAlert, Ban } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Status, ErrorNotice } from "../../components/feedback";
import { useProgress } from "./use-progress";
export function Progress() {
  const p=useProgress();
  return <div className="stack" id="progress-panel">
    <section className="surface fsm-card" aria-label="Job stages">
      <div className="section-heading"><div><h2>Stages</h2><p className="muted">Every job runs these stages in order. Select one to see what it produced and its log.</p></div><div className="fsm-current" role="status"><span>Current state</span><strong>{p.fsm.current}</strong></div></div>
      <ol id="pipeline-rail" className="fsm-flow">{p.fsmNodes.map(node=><li key={node.id} data-node={node.id} data-state={node.state} data-direction={node.direction} className="fsm-node" style={{"--fsm-column":node.column,"--fsm-row":node.row} as CSSProperties}>
        {node.stage
          ?<button {...node.props} className="fsm-state"><span className="fsm-state-top"><span className="stage-dot"/><span className="sval">{node.status}</span></span><strong className="sname">{node.name}</strong><span className="sdesc">{node.hint}</span></button>
          :<div className="fsm-state fsm-terminal"><span className="fsm-state-top"><span className="stage-dot"/><span className="sval">{node.status}</span></span><strong>{node.name}</strong><span className="sdesc">{node.hint}</span></div>}
        {node.direction!=="none"&&<ArrowRight className="fsm-connector" size={18} aria-hidden="true"/>}
      </li>)}</ol>
      {p.stopHelp&&<p className="fsm-stop" data-tone={p.fsm.failed?"error":"warning"}>{p.fsm.failed?<CircleAlert size={16} aria-hidden="true"/>:<Ban size={16} aria-hidden="true"/>}<span>{p.stopHelp}</span></p>}
    </section>
    {p.lineage&&<div className="notice actions"><GitBranch size={16}/><span>This attempt continues an earlier collection.</span><Button variant="link" onClick={p.openLineage}>View earlier attempt</Button></div>}
    <section className="surface state-inspector stack" aria-label="Selected stage">
      <div className="section-heading"><h2>{p.inspectedLabel}</h2><span className="muted section-note">Output of the {p.inspectedName} stage</span></div>
      <pre className="log" id="state-output">{p.inspectedText}</pre>
    </section>
    <section className="surface stack" aria-label="Activity log">
      <div className="section-heading"><div><h2>Activity log</h2><p className="muted">{p.active?"What the job is doing right now, line by line.":"What the job did, line by line."}</p></div><a className="download-link" id="log-download" href={p.download} download><Download size={16}/>Download log</a></div>
      <div className="log-toolbar">
        <label className="field" htmlFor="log-stage">Show<select id="log-stage" value={p.logStage} onChange={p.selectLog}><option value="all">All stages</option>{p.stages.map(s=><option key={s.name} value={s.name}>{s.title}</option>)}</select></label>
        <label className="check"><input id="log-follow" type="checkbox" checked={p.follow} onChange={p.toggleFollow}/>Follow latest</label>
      </div>
      <ErrorNotice error={p.log.error}/>
      <pre id="stream-tail" className="log" ref={p.followRef}>{p.logText}</pre>
      {!p.follow&&<p className="muted">Updates paused here. Turn on Follow latest to catch up.</p>}
    </section>
    <details className="disclosure execution-details"><summary>Every step, for debugging</summary>
      <div className="section-heading"><div><h2>Steps</h2><p className="muted">Each function the job ran, in order. Select one to see what it returned.</p></div><Button id="toggle-internals" variant="ghost" onClick={p.toggleInternals}>{p.internals?"Hide internals":"Show internals"}</Button></div>
      <ol id="timeline" className="timeline">{p.rows.map(s=><li key={s.stepId}><Button variant="ghost" {...s.props} className="step-row"><Status status={s.status}/><span className="step-name">{s.name}</span><span className="number muted">{s.duration}</span><ChevronRight size={15}/></Button>{s.childWorkflowId&&<Button variant="link" {...s.childProps}>View child workflow</Button>}</li>)}</ol>
      <details className="disclosure" open><summary>Selected step output</summary><pre className="log" id="step-focus">{p.selectedText}</pre></details>
    </details>
  </div>;
}
